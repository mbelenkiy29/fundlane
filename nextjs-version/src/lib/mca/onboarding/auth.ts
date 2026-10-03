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
  readEnrollmentContact,
} from "./store"
import { enqueueOnboardingEmailIntents } from "./email-intents"
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
    await db.execute(
      "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND purpose=? AND email_hash=? AND state='pending' AND id<>?",
      [
        now,
        row.id,
        authorization ? "contact_recovery" : "authentication",
        enrollmentEmailHash(email),
        authorization?.id ?? "",
      ]
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
  completing = false
): Promise<{
  challenge: EnrollmentChallenge
  payload: EnrollmentChallengePayload
  row: EnrollmentRecord
}> {
  requireEnrollmentRuntime()
  const cookie = await readEnrollmentAuthCookie()
  if (!cookie || cookie.id !== challengeId) throw invalidChallenge()
  const challenge = await db.queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [challengeId]
  )
  if (
    !challenge ||
    hashOpaqueToken(cookie.secret) !== challenge.token_hash ||
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
  if (
    challenge.purpose === "authentication" &&
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
  identity: SupabaseIdentity
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
    const { challenge, payload, row } = await requireIssuedEnrollmentChallenge(
      challengeId,
      undefined,
      db,
      true
    )
    await assertEnrollmentSession(identity, undefined, db)
    if (enrollmentEmailHash(identity.email) !== challenge.email_hash)
      throw invalidChallenge()
    if (
      row.initiatingProviderUserId &&
      row.initiatingProviderUserId !== identity.user.id
    )
      throw invalidChallenge()
    if (challenge.purpose === "authentication")
      assertEnrollmentIdentity(row, identity)
    const nextPayload = { ...payload, sessionId: identity.sessionId }
    await db.execute(
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
  input: { continuation?: string | null; email?: string } = {}
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
      db
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

/** Opening an emailed invite only binds it to this browser; nothing is consumed until the POST. */
export async function openEnrollmentInvite(
  challengeId: string,
  token: string
): Promise<string> {
  requireEnrollmentRuntime()
  ;(await cookies()).set(enrollmentAuthCookie, `${challengeId}.${token}`, {
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
  })
  const challenge = await getDatabase().queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE id=?",
    [challengeId]
  )
  if (!challenge || hashOpaqueToken(token) !== challenge.token_hash)
    return "/enrollment"
  const payload = readEnrollmentChallengePayload(challenge)
  // Expired or used invites still land on their enrollment, which then offers the email-code fallback.
  return payload.invite
    ? enrollmentContinuation({
        enrollmentId: challenge.enrollment_id,
        ...(payload.destination ? { destination: payload.destination } : {}),
        ...(payload.generation ? { generation: payload.generation } : {}),
      })
    : "/enrollment"
}

/** A mailbox-proving invite either sets the new owner's password or moves the unclaimed enrollment to a corrected email. */
export async function completeEnrollmentInvite(input: {
  challengeId: string
  email: string
  password?: string
}): Promise<{ destination: string } | { emailChanged: true }> {
  const { challenge, payload, row } =
    await reserveEnrollmentAuthenticationAttempt(input.challengeId)
  if (
    !payload.invite ||
    row.workspaceId ||
    row.claimedProviderUserId ||
    row.initiatingProviderUserId
  )
    throw invalidChallenge()
  const email = input.email.trim().toLowerCase()
  if (enrollmentEmailHash(email) !== challenge.email_hash) {
    if (input.password !== undefined)
      throw new AppError(
        400,
        "validation_failed",
        "Confirm the new email before setting a password."
      )
    return changeEnrollmentEmailFromInvite(input.challengeId, email)
  }
  if (input.password === undefined)
    throw new AppError(400, "validation_failed", "Choose a password.")
  // The consumed invite proves the mailbox, so the new account is created confirmed.
  const { error } = await getSupabaseAdminClient().auth.admin.createUser({
    email: payload.email,
    password: input.password,
    email_confirm: true,
  })
  if (error && (error.code === "email_exists" || error.status === 422))
    throw new AppError(
      409,
      "enrollment_account_exists",
      "An account already uses this email. Login with your password to continue."
    )
  authError(error)
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
  const identity = await supabaseIdentity()
  if (!identity) throw invalidChallenge()
  const result = await completeEnrollmentAuthentication(
    input.challengeId,
    identity
  )
  await startPasswordTotpChallenge(identity)
  return result
}

async function changeEnrollmentEmailFromInvite(
  challengeId: string,
  email: string
): Promise<{ emailChanged: true }> {
  await withImmediateTransaction(async (db) => {
    const candidate = await db.queryOne<EnrollmentChallenge>(
      "SELECT * FROM mca_enrollment_challenges WHERE id=?",
      [challengeId]
    )
    if (!candidate) throw invalidChallenge()
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      candidate.enrollment_id,
    ])
    await db.queryOne(
      "SELECT id FROM mca_enrollment_challenges WHERE id=? FOR UPDATE",
      [challengeId]
    )
    const { payload, row } = await requireIssuedEnrollmentChallenge(
      challengeId,
      undefined,
      db,
      true
    )
    if (
      !payload.invite ||
      row.workspaceId ||
      row.claimedProviderUserId ||
      row.initiatingProviderUserId ||
      row.claimState !== "unclaimed"
    )
      throw invalidChallenge()
    if (
      await db.queryOne("SELECT id FROM users WHERE lower(email)=?", [email])
    )
      throw new AppError(
        409,
        "enrollment_email_unavailable",
        "This email already has an account. Login with it instead, or use another email."
      )
    const now = nowIso(),
      generation = row.emailGeneration + 1
    await db.execute(
      "UPDATE mca_enrollment_challenges SET state='consumed',consumed_at=?,updated_at=? WHERE id=? AND state='pending'",
      [now, now, challengeId]
    )
    const changed = await db.execute(
      "UPDATE mca_enrollments SET contact_cipher=?,email_hash=?,email_domain_hash=?,email_generation=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      [
        encryptSensitive(
          JSON.stringify({ ...readEnrollmentContact(row), email }),
          enrollmentEncryptionScope(row.id)
        ),
        enrollmentEmailHash(email),
        enrollmentEmailDomainHash(email),
        generation,
        now,
        row.id,
        row.revision,
      ]
    )
    if (changed !== 1)
      throw new AppError(
        409,
        "enrollment_revision_conflict",
        "Reload the purchase page and retry."
      )
    await db.execute(
      "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND state IN ('pending','verified')",
      [now, row.id]
    )
    await db.execute(
      "UPDATE mca_onboarding_service_emails SET state='suppressed',superseded_by_generation=?,updated_at=? WHERE enrollment_id=? AND generation<? AND state IN ('queued','retry','failed') AND claim_token IS NULL AND provider_message_id IS NULL AND frozen_at IS NULL",
      [generation, now, row.id, generation]
    )
    // The fresh invite must prove the corrected mailbox before any password is set.
    await enqueueOnboardingEmailIntents(row.id, generation, db)
  })
  ;(await cookies()).delete(enrollmentAuthCookie)
  return { emailChanged: true }
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
