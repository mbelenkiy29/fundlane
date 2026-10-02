import "server-only"
import { z } from "zod"
import { getSupabaseAdminClient } from "../../supabase/server"
import { getDatabase, newId, nowIso, type DbExecutor } from "../db"
import {
  createOpaqueToken,
  encryptSensitive,
  hashOpaqueToken,
  hmacScopedToken,
} from "../crypto"
import { consumeRequestRateLimit } from "../auth"
import { requireSuperAdmin, type SuperAdminActor } from "../platform-auth"
import {
  assertStrictPlatformMutation,
  withSuperAdminAction,
} from "../platform-audit"
import { requirePlatformStepUp } from "../platform-step-up"
import {
  liveSupabaseSession,
  verifiedSupabaseUser,
  type SupabaseIdentity,
} from "../supabase-auth"
import { AppError } from "../errors"
import type { StripeBillingClient } from "../billing"
import {
  assertEnrollmentGeneration,
  assertEnrollmentIdentity,
  assertEnrollmentSession,
  freshEnrollmentIdentity,
  requireEnrollmentRuntime,
} from "./claim"
import {
  enrollmentEmailDomainHash,
  enrollmentEmailHash,
  enrollmentEncryptionScope,
  findEnrollment,
  readEnrollmentContact,
} from "./store"
import {
  enrollmentChallengeScope,
  readEnrollmentChallengePayload,
  type EnrollmentChallenge,
  type EnrollmentChallengePayload,
} from "./auth"
import { assertEnrollmentMutation } from "./http"
import { reconcileEnrollment } from "./reconcile"
import { createEnrollmentBillingPortal } from "./billing"
import { enqueueOnboardingEmailIntents } from "./email-intents"
import type { EnrollmentRecord } from "./contracts"

export type EnrollmentRecoveryEvidence = {
  enrollmentId: string
  reason: string
  purchaseEvidence: string
  expectedRevision?: number
}
function evidenceHash(input: EnrollmentRecoveryEvidence): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/.test(input.purchaseEvidence) ||
    input.reason.trim().length < 10 ||
    input.reason.length > 500
  )
    throw new AppError(
      400,
      "enrollment_recovery_evidence_required",
      "Record the independently reviewed support/provider purchase-proof reference and reason."
    )
  return hmacScopedToken(
    "onboarding-purchase-evidence",
    input.enrollmentId,
    input.purchaseEvidence
  )
}
export async function operatorPermission(
  expected: SuperAdminActor,
  request: Request
): Promise<{ actor: SuperAdminActor; stepUpAt: string }> {
  requireEnrollmentRuntime()
  assertStrictPlatformMutation(request)
  assertEnrollmentMutation(request)
  const actor = await requireSuperAdmin(request)
  if (
    actor.userId !== expected.userId ||
    actor.supabaseUserId !== expected.supabaseUserId ||
    actor.sessionId !== expected.sessionId
  )
    throw new AppError(
      403,
      "super_admin_required",
      "The operator session has changed."
    )
  await consumeRequestRateLimit(`enrollment-recovery:${actor.userId}`, 10)
  return { actor, stepUpAt: await requirePlatformStepUp(actor) }
}
export async function assertOperatorInTransaction(
  actor: SuperAdminActor,
  db: DbExecutor
): Promise<void> {
  if (
    !(await liveSupabaseSession(actor.sessionId, actor.supabaseUserId)) ||
    !(await db.queryOne(
      "SELECT user_id FROM platform_admin_grants WHERE user_id=? AND revoked_at IS NULL FOR SHARE",
      [actor.userId]
    ))
  )
    throw new AppError(
      403,
      "platform_admin_required",
      "The operator grant or session is no longer active."
    )
  await requirePlatformStepUp(actor)
}
function assertRecoverable(row: EnrollmentRecord): void {
  if (
    !row.activatedAt ||
    row.workspaceId ||
    row.userId ||
    row.claimState !== "unclaimed" ||
    row.finalizationState !== "pending" ||
    row.recoveryState !== "none" ||
    row.claimToken ||
    row.claimedProviderUserId
  )
    throw new AppError(
      409,
      "enrollment_recovery_not_allowed",
      "Only an unclaimed, confirmed enrollment may change its approved contact."
    )
}
async function currentRecoveryEnrollment(
  input: EnrollmentRecoveryEvidence,
  client?: StripeBillingClient
): Promise<EnrollmentRecord> {
  const row = await findEnrollment(input.enrollmentId)
  if (!row)
    throw new AppError(404, "enrollment_not_found", "Enrollment unavailable.")
  assertRecoverable(row)
  if (
    input.expectedRevision !== undefined &&
    row.revision !== input.expectedRevision
  )
    throw new AppError(
      409,
      "enrollment_revision_conflict",
      "Reload the enrollment before reviewing recovery."
    )
  const fresh = await reconcileEnrollment(row.id, client)
  assertRecoverable(fresh)
  if (fresh.errorCode)
    throw new AppError(
      409,
      "enrollment_recovery_proof_invalid",
      "Refresh the current purchase association before recovery."
    )
  return fresh
}
async function lockRecoveryEnrollment(
  row: EnrollmentRecord,
  db: DbExecutor
): Promise<EnrollmentRecord> {
  await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [
    `enrollment:${row.id}`,
  ])
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
    row.id,
  ])
  const current = (await findEnrollment(row.id, db))!
  assertRecoverable(current)
  if (current.revision !== row.revision)
    throw new AppError(
      409,
      "enrollment_revision_conflict",
      "Enrollment changed during review."
    )
  return current
}

/** First stage authorizes target verification only. Delivery waits for the target's ordinary auth request. */
export async function authorizeEnrollmentContactVerification(
  expected: SuperAdminActor,
  input: EnrollmentRecoveryEvidence & { correctedEmail: string },
  request: Request,
  client?: StripeBillingClient
): Promise<void> {
  const { actor, stepUpAt } = await operatorPermission(expected, request),
    proof = evidenceHash(input)
  const email = z
      .email()
      .max(320)
      .parse(input.correctedEmail.trim().toLowerCase()),
    row = await currentRecoveryEnrollment(input, client)
  if (row.initiatingProviderUserId) {
    const initiating = await getSupabaseAdminClient().auth.admin.getUserById(
      row.initiatingProviderUserId
    )
    if (
      initiating.error ||
      !initiating.data.user ||
      !verifiedSupabaseUser(initiating.data.user) ||
      initiating.data.user.app_metadata.mca_migration_pending === true ||
      initiating.data.user.email!.trim().toLowerCase() !== email
    )
      throw new AppError(
        409,
        "enrollment_recovery_not_allowed",
        "The corrected correspondence address must belong to the original verified initiating identity."
      )
  }
  const id = newId(),
    now = nowIso(),
    payload: EnrollmentChallengePayload = {
      version: 1,
      email,
      emailGeneration: row.emailGeneration,
      issuedAt: null,
      sessionId: null,
    }
  await withSuperAdminAction(
    {
      actor,
      action: "enrollment.contact_verification_authorized",
      targetType: "enrollment",
      targetId: row.id,
      reason: input.reason,
      stepUpAt,
      request,
      after: {
        purchaseEvidenceHash: proof,
        expectedRevision: row.revision,
        challengeId: id,
      },
    },
    async (db) => {
      await assertOperatorInTransaction(actor, db)
      await lockRecoveryEnrollment(row, db)
      await db.execute(
        "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND purpose='contact_recovery' AND state IN ('pending','verified')",
        [now, row.id]
      )
      await db.execute(
        `INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,authorized_by_user_id,purchase_evidence_hash,resume_generation,expires_at,created_at,updated_at)
      VALUES (?,?,'contact_recovery',?,?,?,?,?,?,?,?,?)`,
        [
          id,
          row.id,
          hashOpaqueToken(createOpaqueToken()),
          encryptSensitive(
            JSON.stringify(payload),
            enrollmentChallengeScope(id)
          ),
          enrollmentEmailHash(email),
          actor.userId,
          proof,
          row.resumeGeneration,
          new Date(Date.now() + 900000).toISOString(),
          now,
          now,
        ]
      )
    }
  )
}

/** Second stage requires actual target verification, live session and a separately fresh operator approval. */
export async function recoverEnrollmentContact(
  expected: SuperAdminActor,
  input: EnrollmentRecoveryEvidence & { verifiedProviderUserId: string },
  request: Request,
  client?: StripeBillingClient
): Promise<void> {
  const { actor, stepUpAt } = await operatorPermission(expected, request),
    proof = evidenceHash(input)
  const { data, error } = await getSupabaseAdminClient().auth.admin.getUserById(
    input.verifiedProviderUserId
  )
  const target = data.user
  if (
    error ||
    !target ||
    !verifiedSupabaseUser(target) ||
    target.app_metadata.mca_migration_pending === true
  )
    throw new AppError(
      409,
      "enrollment_recovery_proof_invalid",
      "The target must complete normal verified identity recovery."
    )
  const row = await currentRecoveryEnrollment(input, client)
  const challenge = await getDatabase().queryOne<EnrollmentChallenge>(
    "SELECT * FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose='contact_recovery' AND state='verified' AND provider_user_id=? AND purchase_evidence_hash=? ORDER BY verified_at DESC LIMIT 1",
    [row.id, target.id, proof]
  )
  if (
    !challenge ||
    !challenge.verified_at ||
    Date.parse(challenge.expires_at) <= Date.now() ||
    Date.parse(stepUpAt) < Date.parse(challenge.verified_at)
  )
    throw new AppError(
      409,
      "enrollment_recovery_proof_invalid",
      "Verify the intended target, then complete a fresh operator step-up before approval."
    )
  const payload = readEnrollmentChallengePayload(challenge),
    email = target.email!.trim().toLowerCase()
  if (
    !payload.sessionId ||
    challenge.email_hash !== enrollmentEmailHash(email) ||
    !(await liveSupabaseSession(payload.sessionId, target.id)) ||
    payload.emailGeneration !== row.emailGeneration ||
    challenge.resume_generation !== row.resumeGeneration ||
    (row.initiatingProviderUserId && row.initiatingProviderUserId !== target.id)
  )
    throw new AppError(
      409,
      "enrollment_recovery_proof_invalid",
      "The target verification or enrollment generation has changed."
    )
  await withSuperAdminAction(
    {
      actor,
      action: "enrollment.identity_recovery_approved",
      targetType: "enrollment",
      targetId: row.id,
      reason: input.reason,
      stepUpAt,
      request,
      before: { revision: row.revision, emailGeneration: row.emailGeneration },
      after: {
        revision: row.revision + 1,
        emailGeneration: row.emailGeneration + 1,
        purchaseEvidenceHash: proof,
        challengeId: challenge.id,
        providerUserId: target.id,
      },
    },
    async (db) => {
      await assertOperatorInTransaction(actor, db)
      const current = await lockRecoveryEnrollment(row, db)
      await db.queryOne(
        "SELECT id FROM mca_enrollment_challenges WHERE id=? FOR UPDATE",
        [challenge.id]
      )
      const liveProof = await db.queryOne<EnrollmentChallenge>(
        "SELECT * FROM mca_enrollment_challenges WHERE id=? AND state='verified'",
        [challenge.id]
      )
      if (
        !liveProof ||
        Date.parse(liveProof.expires_at) <= Date.now() ||
        liveProof.provider_user_id !== target.id ||
        liveProof.purchase_evidence_hash !== proof ||
        liveProof.email_hash !== enrollmentEmailHash(email) ||
        liveProof.email_cipher !== challenge.email_cipher ||
        liveProof.verified_at !== challenge.verified_at ||
        liveProof.resume_generation !== current.resumeGeneration ||
        !(await liveSupabaseSession(payload.sessionId!, target.id))
      )
        throw new AppError(
          409,
          "enrollment_recovery_proof_invalid",
          "The target session or proof is no longer active."
        )
      const collision = await db.queryOne<{
        id: string
        supabase_user_id: string | null
      }>("SELECT id,supabase_user_id FROM users WHERE lower(email)=?", [email])
      if (
        (collision && collision.supabase_user_id !== target.id) ||
        (await db.queryOne(
          "SELECT m.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.supabase_user_id=? AND m.status='active' LIMIT 1",
          [target.id]
        ))
      )
        throw new AppError(
          409,
          "enrollment_recovery_identity_conflict",
          "This target has an existing account or company requiring deliberate recovery."
        )
      const generation = current.emailGeneration + 1,
        contact = { ...readEnrollmentContact(current), email }
      await assertOperatorInTransaction(actor, db)
      await db.execute(
        "UPDATE mca_enrollments SET contact_cipher=?,email_hash=?,email_domain_hash=?,claimed_provider_user_id=?,resume_secret_hash=?,resume_generation=resume_generation+1,email_generation=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        [
          encryptSensitive(
            JSON.stringify(contact),
            enrollmentEncryptionScope(row.id)
          ),
          enrollmentEmailHash(email),
          enrollmentEmailDomainHash(email),
          target.id,
          hashOpaqueToken(createOpaqueToken()),
          generation,
          nowIso(),
          row.id,
          row.revision,
        ]
      )
      await db.execute(
        "UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND state IN ('pending','verified')",
        [nowIso(), row.id]
      )
      await db.execute(
        "UPDATE mca_onboarding_service_emails SET state='suppressed',superseded_by_generation=?,updated_at=? WHERE enrollment_id=? AND generation<? AND state IN ('queued','retry','failed') AND claim_token IS NULL AND provider_message_id IS NULL AND frozen_at IS NULL",
        [generation, nowIso(), row.id, generation]
      )
      await enqueueOnboardingEmailIntents(row.id, generation, db)
    }
  )
}

export async function manageEnrollmentBilling(
  input: {
    enrollmentId: string
    identity: SupabaseIdentity
    generation?: number
  },
  client?: StripeBillingClient
): Promise<string> {
  requireEnrollmentRuntime()
  const identity = await freshEnrollmentIdentity(input.identity),
    row = await findEnrollment(input.enrollmentId)
  if (!row)
    throw new AppError(404, "enrollment_not_found", "Enrollment unavailable.")
  assertEnrollmentGeneration(row, input.generation)
  assertEnrollmentIdentity(row, identity)
  const user = await getDatabase().queryOne<{ id: string }>(
    "SELECT id FROM users WHERE supabase_user_id=?",
    [identity.user.id]
  )
  await assertEnrollmentSession(identity, user?.id)
  if (row.workspaceId)
    throw new AppError(
      409,
      "enrollment_already_claimed",
      "Use the company's Plans & Billing page."
    )
  const fresh = await reconcileEnrollment(row.id, client)
  assertEnrollmentGeneration(fresh, input.generation)
  assertEnrollmentIdentity(fresh, identity)
  await assertEnrollmentSession(identity, user?.id)
  return createEnrollmentBillingPortal(fresh, client)
}
