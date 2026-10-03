import "server-only"
import { cookies } from "next/headers"
import { z } from "zod"
import {
  createSupabaseServerClient,
  getSupabaseAdminClient,
} from "../../supabase/server"
import {
  getDatabase,
  newId,
  nowIso,
  runOutsideTransaction,
  withImmediateTransaction,
  type DbExecutor,
} from "../db"
import {
  createOpaqueToken,
  decryptSensitive,
  encryptSensitive,
  hashOpaqueToken,
} from "../crypto"
import { AppError } from "../errors"
import { clientRateKey, consumeRequestRateLimit } from "../auth"
import {
  enrollmentContinuation,
  parseEnrollmentContinuation,
  type EnrollmentDestination,
} from "../auth-navigation"
import { startPasswordTotpChallenge } from "../totp-service"
import { supabaseIdentity, type SupabaseIdentity } from "../supabase-auth"
import { authError } from "../supabase-auth-http"
import { onboardingOrigin } from "./checkout"
import {
  assertEnrollmentGeneration,
  assertEnrollmentIdentity,
  assertEnrollmentSession,
  requireEnrollmentRuntime,
} from "./claim"
import {
  enrollmentChallengeScope,
  enrollmentEmailDomainHash,
  enrollmentEmailHash,
  enrollmentEncryptionScope,
  findEnrollment,
  newOwnerEnrollment,
  readEnrollmentContact,
} from "./store"
import {
  enqueueOnboardingEmailIntents,
  enqueueParkedInvite,
  nextEmailGeneration,
} from "./email-intents"
import type { EnrollmentRecord } from "./contracts"

export { enrollmentChallengeScope }
export const enrollmentAuthCookie = "mca_enrollment_auth"
export const enrollmentBindingCookie = "mca_enrollment_binding"
const challengePayloadSchema = z
  .object({
    version: z.literal(1),
    email: z.email().max(320),
    emailGeneration: z.number().int().positive(),
    destination: z.enum(["crm", "business", "billing"]).optional(),
    generation: z.number().int().positive().optional(),
    issuedAt: z.iso.datetime().nullable(),
    sessionId: z.uuid().nullable(),
    // Only a challenge minted into the frozen getting_started email proves mailbox control.
    invite: z.literal(true).optional(),
    // An invite minted to a pending new address; the enrollment moves only when it is consumed.
    emailChange: z.literal(true).optional(),
  })
  .strict()
export type EnrollmentChallengePayload = z.infer<typeof challengePayloadSchema>
export type EnrollmentChallenge = {
  id: string
  enrollment_id: string
  purpose: "authentication" | "contact_recovery"
  token_hash: string
  email_cipher: string
  email_hash: string
  provider_user_id: string | null
  authorized_by_user_id: string | null
  purchase_evidence_hash: string | null
  resume_generation: number
  attempts: number
  state: string
  expires_at: string
  verified_at: string | null
  created_at: string
}
export function readEnrollmentChallengePayload(
  challenge: EnrollmentChallenge
): EnrollmentChallengePayload {
  return challengePayloadSchema.parse(
    JSON.parse(
      decryptSensitive(
        challenge.email_cipher,
        enrollmentChallengeScope(challenge.id)
      )
    )
  )
}
export async function readEnrollmentAuthCookie(): Promise<{
  id: string
  secret: string
} | null> {
  const value = (await cookies()).get(enrollmentAuthCookie)?.value
  if (!value) return null
  const [id, secret, extra] = value.split(".")
  return !extra &&
    z.uuid().safeParse(id).success &&
    secret?.length >= 32 &&
    secret.length <= 256
    ? { id, secret }
    : null
}
function invalidChallenge(): AppError {
  return new AppError(
    400,
    "enrollment_challenge_invalid",
    "Verification is invalid or expired. Request a new email and retry."
  )
}
/** One answer for every address collision and for an already-created account. */
function emailUnavailable(): AppError {
  return new AppError(
    409,
    "enrollment_email_unavailable",
    "This email can't be used to set a new password. If you already set one, Login with it, or use Forgot password."
  )
}
function isInvite(challenge: EnrollmentChallenge): boolean {
  if (challenge.purpose !== "authentication") return false
  try {
    return readEnrollmentChallengePayload(challenge).invite === true
  } catch {
    return false
  }
}
/** Invites are distinguishable only inside the encrypted payload (no column), so revocation decrypts. */
async function revokePendingInvites(
  db: DbExecutor,
  enrollmentId: string,
  now: string
): Promise<void> {
  const pending = (
    await db.query<EnrollmentChallenge>(
      "SELECT * FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose='authentication' AND state='pending' FOR UPDATE",
      [enrollmentId]
    )
  ).rows
  for (const challenge of pending)
    if (isInvite(challenge))
      await db.execute(
        "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE id=? AND state='pending'",
        [now, challenge.id]
      )
}
/** Unsent parked invites above the current generation are superseded by a newer one. */
async function suppressParkedInvites(
  db: DbExecutor,
  row: EnrollmentRecord,
  generation: number,
  now: string
): Promise<void> {
  await db.execute(
    "UPDATE mca_onboarding_service_emails SET state='suppressed',superseded_by_generation=?,updated_at=? WHERE enrollment_id=? AND generation>? AND state IN ('queued','retry','failed') AND claim_token IS NULL AND provider_message_id IS NULL AND frozen_at IS NULL",
    [generation, now, row.id, row.emailGeneration]
  )
}
/** Edits and fresh links share a durable window, so a stranger cannot block the owner for longer than a day. */
async function parkedInviteWindowFull(
  db: DbExecutor,
  enrollmentId: string
): Promise<boolean> {
  const recent = await db.queryOne<{ count: number }>(
    "SELECT count(*)::int count FROM mca_onboarding_service_emails m JOIN mca_enrollments e ON e.id=m.enrollment_id WHERE m.enrollment_id=? AND m.purpose='getting_started' AND m.generation>e.email_generation AND m.created_at::timestamptz>now()-interval '1 day'",
    [enrollmentId]
  )
  return (recent?.count ?? 0) >= 5
}
/**
 * Serialises every edit and consume that targets one address. Committed owners always count; at edit time,
 * other enrollments' live invite challenges and parked unsent rows also reserve the address.
 */
async function assertEnrollmentEmailAvailable(
  db: DbExecutor,
  enrollmentId: string,
  email: string,
  reservations: boolean
): Promise<void> {
  const hash = enrollmentEmailHash(email)
  await db.execute("SELECT pg_advisory_xact_lock(hashtext(?))", [
    `enrollment-email:${hash}`,
  ])
  const taken = await db.queryOne(
    `SELECT 1 FROM users WHERE lower(email)=?
    UNION ALL SELECT 1 FROM mca_enrollments WHERE id<>? AND email_hash=? AND activated_at IS NOT NULL AND claim_state IN ('unclaimed','claiming')
      AND recovery_state<>'canceled' AND billing_state NOT IN ('canceled','incomplete_expired','blocked')
    UNION ALL SELECT 1 FROM mca_enrollment_challenges WHERE ?::boolean AND enrollment_id<>? AND purpose='authentication' AND email_hash=? AND state='pending' AND expires_at::timestamptz>now()
    UNION ALL SELECT 1 FROM mca_onboarding_service_emails m JOIN mca_enrollments e ON e.id=m.enrollment_id WHERE ?::boolean AND m.enrollment_id<>? AND m.purpose='getting_started'
      AND m.recipient_hash=? AND m.frozen_at IS NULL AND m.state IN ('queued','retry','sending') AND m.superseded_by_generation IS NULL AND m.generation>e.email_generation
    LIMIT 1`,
    [
      email.trim().toLowerCase(),
      enrollmentId,
      hash,
      reservations,
      enrollmentId,
      hash,
      reservations,
      enrollmentId,
      hash,
    ]
  )
  if (taken) throw emailUnavailable()
}

/** Persisted authorization, not a browser flow flag, permits enrollment security email. */
export async function requestEnrollmentAuthentication(input: {
  enrollmentId: string
  email: string
  resumeSecret?: string
  destination?: EnrollmentDestination
  generation?: number
}): Promise<void> {
  requireEnrollmentRuntime()
  const id = newId(),
    secret = createOpaqueToken(),
    now = nowIso(),
    email = input.email.trim().toLowerCase()
  const store = await cookies()
  // Allocate the same opaque response/cookie shape for every account-neutral result.
  store.set(enrollmentAuthCookie, `${id}.${secret}`, {
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 900,
  })
  await consumeRequestRateLimit(
    `enrollment-auth-email:${enrollmentEmailHash(email)}`,
    5
  )
  await consumeRequestRateLimit(`enrollment-auth-id:${input.enrollmentId}`, 5)
  const row = await findEnrollment(input.enrollmentId)
  if (
    !row ||
    !row.activatedAt ||
    row.claimState === "blocked" ||
    row.recoveryState !== "none"
  )
    return
  try {
    assertEnrollmentGeneration(row, input.generation)
  } catch {
    return
  }
  let authorization: EnrollmentChallenge | undefined
  const ordinary = row.emailHash === enrollmentEmailHash(email)
  if (!ordinary)
    authorization = await getDatabase().queryOne<EnrollmentChallenge>(
      `SELECT * FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose='contact_recovery'
    AND email_hash=? AND state='pending' AND expires_at::timestamptz>now() AND authorized_by_user_id IS NOT NULL AND purchase_evidence_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [row.id, enrollmentEmailHash(email)]
    )
  if (!ordinary && !authorization) return
  if (
    authorization &&
    (authorization.resume_generation !== row.resumeGeneration ||
      readEnrollmentChallengePayload(authorization).emailGeneration !==
        row.emailGeneration)
  )
    return
  const payload: EnrollmentChallengePayload = {
    version: 1,
    email,
    emailGeneration: row.emailGeneration,
    issuedAt: now,
    sessionId: null,
    ...(input.destination ? { destination: input.destination } : {}),
    ...(input.generation ? { generation: input.generation } : {}),
  }
  await withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      row.id,
    ])
    const current = await findEnrollment(row.id, db)
    if (!current || current.revision !== row.revision) return
    if (
      authorization &&
      !(await db.queryOne(
        `SELECT c.id FROM mca_enrollment_challenges c
      JOIN platform_admin_grants g ON g.user_id=c.authorized_by_user_id AND g.revoked_at IS NULL
      WHERE c.id=? AND c.state='pending' AND c.expires_at::timestamptz>now()
      AND c.resume_generation=? AND c.email_hash=? AND c.purchase_evidence_hash=? FOR SHARE`,
        [
          authorization.id,
          current.resumeGeneration,
          enrollmentEmailHash(email),
          authorization.purchase_evidence_hash,
        ]
      ))
    )
      return
    const superseded = (
      await db.query<EnrollmentChallenge>(
        "SELECT * FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose=? AND email_hash=? AND state='pending' AND id<>? FOR UPDATE",
        [
          row.id,
          authorization ? "contact_recovery" : "authentication",
          enrollmentEmailHash(email),
          authorization?.id ?? "",
        ]
      )
    ).rows
    for (const previous of superseded)
      // An emailed invite is the owner's mailbox proof; a code requested by any browser must not strand it.
      if (!isInvite(previous))
        await db.execute(
          "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE id=? AND state='pending'",
          [now, previous.id]
        )
    await db.execute(
      `INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,authorized_by_user_id,purchase_evidence_hash,resume_generation,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        row.id,
        authorization ? "contact_recovery" : "authentication",
        hashOpaqueToken(secret),
        encryptSensitive(JSON.stringify(payload), enrollmentChallengeScope(id)),
        enrollmentEmailHash(email),
        authorization?.authorized_by_user_id ?? null,
        authorization?.purchase_evidence_hash ?? null,
        row.resumeGeneration,
        new Date(Date.now() + 900000).toISOString(),
        now,
        now,
      ]
    )
  })
  const persisted = await getDatabase().queryOne(
    "SELECT id FROM mca_enrollment_challenges WHERE id=?",
    [id]
  )
  if (!persisted) return
  const callback = new URL("/auth/callback", onboardingOrigin())
  callback.searchParams.set(
    "next",
    enrollmentContinuation({
      enrollmentId: row.id,
      ...(input.destination ? { destination: input.destination } : {}),
      ...(input.generation ? { generation: input.generation } : {}),
    })
  )
  callback.searchParams.set("challenge", id)
  try {
    const client = await createSupabaseServerClient()
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: callback.toString() },
    })
    if (error)
      await getDatabase().execute(
        "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE id=? AND state='pending'",
        [nowIso(), id]
      )
  } catch {
    await getDatabase().execute(
      "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE id=? AND state='pending'",
      [nowIso(), id]
    )
  }
}

export async function requireIssuedEnrollmentChallenge(
  challengeId: string,
  continuation?: string | null,
  db: DbExecutor = getDatabase(),
  completing = false,
  secret?: string
): Promise<{
  challenge: EnrollmentChallenge
  payload: EnrollmentChallengePayload
  row: EnrollmentRecord
}> {
  requireEnrollmentRuntime()
  // Emailed invites present their token in a POST body; every other challenge proves this browser via the cookie.
  const proof =
    secret === undefined
      ? await readEnrollmentAuthCookie()
      : { id: challengeId, secret }
  if (!proof || proof.id !== challengeId) throw invalidChallenge()
  const challenge = await db.queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [challengeId]
  )
  if (
    !challenge ||
    hashOpaqueToken(proof.secret) !== challenge.token_hash ||
    challenge.state !== "pending" ||
    challenge.attempts > (completing ? 5 : 4) ||
    Date.parse(challenge.expires_at) <= Date.now()
  )
    throw invalidChallenge()
  const row = await findEnrollment(challenge.enrollment_id, db),
    payload = readEnrollmentChallengePayload(challenge)
  if (
    !row ||
    !payload.issuedAt ||
    row.resumeGeneration !== challenge.resume_generation ||
    row.emailGeneration !== payload.emailGeneration ||
    row.claimState === "blocked" ||
    row.recoveryState !== "none"
  )
    throw invalidChallenge()
  if (continuation !== undefined) {
    const next = parseEnrollmentContinuation(continuation ?? null)
    if (
      !next ||
      next.enrollmentId !== row.id ||
      next.generation !== payload.generation ||
      next.destination !== payload.destination
    )
      throw invalidChallenge()
  }
  // Invites are accepted only by their POSTed token, and only before any account or company exists.
  if (Boolean(payload.invite) !== (secret !== undefined)) throw invalidChallenge()
  if (payload.invite && !newOwnerEnrollment(row)) throw invalidChallenge()
  if (
    challenge.purpose === "authentication" &&
    !(payload.invite && payload.emailChange) &&
    row.emailHash !== challenge.email_hash
  )
    throw invalidChallenge()
  if (
    challenge.purpose === "contact_recovery" &&
    (!challenge.authorized_by_user_id ||
      !challenge.purchase_evidence_hash ||
      row.workspaceId ||
      row.claimState !== "unclaimed")
  )
    throw invalidChallenge()
  return { challenge, payload, row }
}
export async function completeEnrollmentAuthentication(
  challengeId: string,
  identity: SupabaseIdentity,
  secret?: string
): Promise<{ destination: string }> {
  const candidate = await getDatabase().queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [challengeId]
  )
  if (!candidate) throw invalidChallenge()
  return withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      candidate.enrollment_id,
    ])
    await db.queryOne(
      "SELECT id FROM mca_enrollment_challenges WHERE id=? FOR UPDATE",
      [challengeId]
    )
    const issued = await requireIssuedEnrollmentChallenge(
      challengeId,
      undefined,
      db,
      true,
      secret
    )
    const { challenge, payload } = issued
    let row = issued.row
    await assertEnrollmentSession(identity, undefined, db)
    if (enrollmentEmailHash(identity.email) !== challenge.email_hash)
      throw invalidChallenge()
    if (
      row.initiatingProviderUserId &&
      row.initiatingProviderUserId !== identity.user.id
    )
      throw invalidChallenge()
    const now = nowIso(),
      generation = payload.generation ?? row.emailGeneration
    if (payload.emailChange) {
      // The pending address lives on this challenge; the enrollment moves only together with its consumption.
      if (
        await db.queryOne(
          "SELECT 1 FROM mca_onboarding_service_emails WHERE enrollment_id=? AND generation>? LIMIT 1",
          [row.id, generation]
        )
      )
        throw invalidChallenge()
      await assertEnrollmentEmailAvailable(db, row.id, payload.email, false)
      const moved = await db.execute(
        "UPDATE mca_enrollments SET contact_cipher=?,email_hash=?,email_domain_hash=?,email_generation=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND email_generation=?",
        [
          encryptSensitive(
            JSON.stringify({ ...readEnrollmentContact(row), email: payload.email }),
            enrollmentEncryptionScope(row.id)
          ),
          enrollmentEmailHash(payload.email),
          enrollmentEmailDomainHash(payload.email),
          generation,
          now,
          row.id,
          row.revision,
          payload.emailGeneration,
        ]
      )
      if (moved !== 1) throw invalidChallenge()
      row = (await findEnrollment(row.id, db))!
    }
    if (challenge.purpose === "authentication")
      assertEnrollmentIdentity(row, identity)
    const nextPayload = { ...payload, sessionId: identity.sessionId }
    const consumed = await db.execute(
      "UPDATE mca_enrollment_challenges SET state=?,provider_user_id=?,email_cipher=?,verified_at=?,consumed_at=?,updated_at=? WHERE id=? AND state='pending'",
      [
        challenge.purpose === "authentication" ? "consumed" : "verified",
        identity.user.id,
        encryptSensitive(
          JSON.stringify(nextPayload),
          enrollmentChallengeScope(challenge.id)
        ),
        nowIso(),
        challenge.purpose === "authentication" ? nowIso() : null,
        nowIso(),
        challengeId,
      ]
    )
    if (consumed !== 1) throw invalidChallenge()
    if (payload.emailChange) {
      await db.execute(
        "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND state IN ('pending','verified') AND id<>?",
        [now, row.id, challengeId]
      )
      await db.execute(
        "UPDATE mca_onboarding_service_emails SET state='suppressed',superseded_by_generation=?,updated_at=? WHERE enrollment_id=? AND generation<? AND state IN ('queued','retry','failed') AND claim_token IS NULL AND provider_message_id IS NULL AND frozen_at IS NULL",
        [generation, now, row.id, generation]
      )
      // getting_started at this generation already went out; business details now go to the new address.
      await enqueueOnboardingEmailIntents(row.id, generation, db)
    }
    return {
      destination: enrollmentContinuation({
        enrollmentId: row.id,
        ...(payload.destination ? { destination: payload.destination } : {}),
        ...(payload.generation ? { generation: payload.generation } : {}),
      }),
    }
  })
}

/** Commit one shared OTP/link attempt before any external verification request. */
export async function reserveEnrollmentAuthenticationAttempt(
  challengeId: string,
  input: { continuation?: string | null; email?: string; secret?: string } = {}
): Promise<{
  challenge: EnrollmentChallenge
  payload: EnrollmentChallengePayload
  row: EnrollmentRecord
}> {
  requireEnrollmentRuntime()
  const candidate = await getDatabase().queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [challengeId]
  )
  if (!candidate) throw invalidChallenge()
  return withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      candidate.enrollment_id,
    ])
    await db.queryOne(
      "SELECT id FROM mca_enrollment_challenges WHERE id=? FOR UPDATE",
      [challengeId]
    )
    const current = await requireIssuedEnrollmentChallenge(
      challengeId,
      input.continuation,
      db,
      false,
      input.secret
    )
    if (
      input.email !== undefined &&
      enrollmentEmailHash(input.email) !== current.challenge.email_hash
    )
      throw invalidChallenge()
    const changed = await db.execute(
      "UPDATE mca_enrollment_challenges SET attempts=attempts+1,updated_at=? WHERE id=? AND state='pending' AND attempts<5",
      [nowIso(), challengeId]
    )
    if (changed !== 1) throw invalidChallenge()
    return current
  })
}

/** Enrollment callbacks are GETs from Auth; their bound challenge replaces a mutation Origin check. */
export async function reserveEnrollmentCallbackAttempt(
  request: Request,
  challengeId: string,
  continuation: string
): Promise<void> {
  await consumeRequestRateLimit(
    clientRateKey(request, "enrollment:callback"),
    15
  )
  await reserveEnrollmentAuthenticationAttempt(challengeId, { continuation })
}

/** A mailbox-proving invite sets the new owner's password; a change invite also moves the enrollment in the same consume. */
export async function completeEnrollmentInvite(input: {
  challengeId: string
  token: string
  email: string
  password: string
}): Promise<{ destination: string }> {
  const { payload, row } = await reserveEnrollmentAuthenticationAttempt(
    input.challengeId,
    { email: input.email, secret: input.token }
  )
  // Cheap pre-check before any provider account exists; the consume transaction checks again.
  if (payload.emailChange)
    await withImmediateTransaction((db) =>
      assertEnrollmentEmailAvailable(db, row.id, payload.email, false)
    )
  // The consumed invite proves the mailbox, so the new account is created confirmed.
  const { data, error } = await getSupabaseAdminClient().auth.admin.createUser({
    email: payload.email,
    password: input.password,
    email_confirm: true,
  })
  if (error && (error.code === "email_exists" || error.status === 422))
    throw emailUnavailable()
  authError(error)
  const created = data.user?.id
  let identity: SupabaseIdentity | null = null,
    result: { destination: string }
  try {
    const client = await createSupabaseServerClient()
    if (
      (
        await client.auth.signInWithPassword({
          email: payload.email,
          password: input.password,
        })
      ).error
    )
      throw invalidChallenge()
    identity = await supabaseIdentity()
    if (!identity || identity.user.id !== created) throw invalidChallenge()
    result = await completeEnrollmentAuthentication(
      input.challengeId,
      identity,
      input.token
    )
  } catch (failure) {
    if (!created) throw failure
    // The consume may have committed before the error surfaced. Re-read the invite on a fresh pool query and
    // delete the account this request created only while the invite is provably unused; when unsure, keep it.
    const after = await runOutsideTransaction(() =>
      getDatabase().queryOne<{ state: string }>(
        "SELECT state FROM mca_enrollment_challenges WHERE id=?",
        [input.challengeId]
      )
    ).catch(() => undefined)
    if (after?.state !== "pending") throw emailUnavailable()
    await getSupabaseAdminClient()
      .auth.admin.deleteUser(created)
      .catch(() => undefined)
    throw failure
  }
  ;(await cookies()).delete(enrollmentAuthCookie)
  await startPasswordTotpChallenge(identity!)
  return result
}

/** Moves nothing: kills every live invite and parks a new one for the pending address, sent through the outbox. */
export async function requestEnrollmentEmailChange(input: {
  challengeId: string
  token: string
  newEmail: string
}): Promise<{ emailChangeRequested: true }> {
  requireEnrollmentRuntime()
  const email = input.newEmail.trim().toLowerCase()
  const candidate = await getDatabase().queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [input.challengeId]
  )
  if (!candidate) throw invalidChallenge()
  await consumeRequestRateLimit(
    `enrollment-email-change:${candidate.enrollment_id}`,
    3
  )
  await withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      candidate.enrollment_id,
    ])
    await db.queryOne(
      "SELECT id FROM mca_enrollment_challenges WHERE id=? FOR UPDATE",
      [input.challengeId]
    )
    const { challenge, row } = await requireIssuedEnrollmentChallenge(
      input.challengeId,
      undefined,
      db,
      false,
      input.token
    )
    if (
      enrollmentEmailHash(email) === challenge.email_hash ||
      enrollmentEmailHash(email) === row.emailHash
    )
      throw new AppError(
        400,
        "validation_failed",
        "Enter a different email, or request a new link for the purchase email."
      )
    if (await parkedInviteWindowFull(db, row.id))
      throw new AppError(
        429,
        "rate_limit_exceeded",
        "Too many attempts. Try again shortly."
      )
    await assertEnrollmentEmailAvailable(db, row.id, email, true)
    const now = nowIso()
    await revokePendingInvites(db, row.id, now)
    const generation = await nextEmailGeneration(row.id, row.emailGeneration, db)
    await suppressParkedInvites(db, row, generation, now)
    await enqueueParkedInvite(row.id, generation, email, db)
  })
  return { emailChangeRequested: true }
}

/** Account-neutral: a fresh set-password link goes only to the enrollment's current address and cancels a pending change. */
export async function requestEnrollmentInvite(input: {
  enrollmentId: string
  email: string
  destination?: EnrollmentDestination
  generation?: number
}): Promise<void> {
  requireEnrollmentRuntime()
  const email = input.email.trim().toLowerCase()
  await consumeRequestRateLimit(
    `enrollment-invite-email:${enrollmentEmailHash(email)}`,
    3
  )
  await consumeRequestRateLimit(`enrollment-invite-id:${input.enrollmentId}`, 3)
  const eligible = (row: EnrollmentRecord | undefined): row is EnrollmentRecord =>
    Boolean(
      row?.activatedAt &&
        row.recoveryState === "none" &&
        newOwnerEnrollment(row) &&
        row.emailHash === enrollmentEmailHash(email)
    )
  const row = await findEnrollment(input.enrollmentId)
  if (!eligible(row)) return
  try {
    assertEnrollmentGeneration(row, input.generation)
  } catch {
    return
  }
  await withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      row.id,
    ])
    const current = await findEnrollment(row.id, db)
    if (
      !eligible(current) ||
      current.revision !== row.revision ||
      (await parkedInviteWindowFull(db, row.id))
    )
      return
    const now = nowIso()
    // Older invites are superseded only by a newer one to this same mailbox.
    await revokePendingInvites(db, current.id, now)
    const generation = await nextEmailGeneration(
      current.id,
      current.emailGeneration,
      db
    )
    await suppressParkedInvites(db, current, generation, now)
    await enqueueParkedInvite(
      current.id,
      generation,
      readEnrollmentContact(current).email,
      db
    )
  })
}

export async function verifyEnrollmentAuthentication(input: {
  challengeId: string
  email: string
  token: string
}): Promise<{ destination: string }> {
  const { payload } = await reserveEnrollmentAuthenticationAttempt(
    input.challengeId,
    { email: input.email }
  )
  const client = await createSupabaseServerClient()
  const { error } = await client.auth.verifyOtp({
    email: payload.email,
    token: input.token,
    type: "email",
  })
  if (error) throw invalidChallenge()
  const identity = await supabaseIdentity()
  if (!identity) throw invalidChallenge()
  // The fifth valid attempt may complete; a sixth attempt cannot call the provider.
  const result = await completeEnrollmentAuthentication(
    input.challengeId,
    identity
  )
  await startPasswordTotpChallenge(identity)
  return result
}
