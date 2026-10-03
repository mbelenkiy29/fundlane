import "server-only"
import { z } from "zod"
import { getSupabaseAdminClient } from "../../supabase/server"
import { getDatabase, newId, nowIso, type DbExecutor } from "../db"
import { createOpaqueToken, decryptSensitive, hashOpaqueToken, hmacScopedToken } from "../crypto"
import { AppError } from "../errors"
import type { SuperAdminActor } from "../platform-auth"
import { withSuperAdminAction } from "../platform-audit"
import { requirePlatformStepUp, stepUpMinutes } from "../platform-step-up"
import { liveSupabaseSession, verifiedSupabaseUser } from "../supabase-auth"
import { evaluateCompanyAccess } from "../company-access"
import { findEnrollment, enrollmentEmailHash } from "./store"
import type { EnrollmentRecord, OnboardingEmailState } from "./contracts"
import { readVerifiedEnrollmentBilling } from "./evidence"
import { enqueueOnboardingEmailIntents, nextEmailGeneration, onboardingEmailEncryptionScope } from "./email-intents"
import { onboardingEmailProviderIdentity, type FrozenOnboardingEmailConfiguration } from "./email-transport"
import { readEnrollmentChallengePayload, type EnrollmentChallenge } from "./auth"
import { assertOperatorInTransaction, operatorPermission, type EnrollmentRecoveryEvidence } from "./recovery"
import { enrollmentRuntimeEnabled, enrollmentCreationEnabled, onboardingEmailEnabled } from "./config"

const reference = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/)
const providerId = z.string().min(1).max(512).refine(value => value === value.trim() && !/[\r\n]/.test(value))
export const onboardingEmailEvidenceSchema = z.object({
  emailId: z.uuid(), outcome: z.enum(["accepted", "delivered", "failed", "suppressed"]),
  evidence: reference, provider: z.enum(["usesend", "resend", "webhook"]),
  providerConfigurationId: z.string().min(1).max(128), providerMessageId: providerId.optional(),
  expectedRevision: z.number().int().positive().safe(), reason: z.string().trim().min(10).max(500),
}).strict()
export type OnboardingEmailEvidenceInput = z.infer<typeof onboardingEmailEvidenceSchema> & { enrollmentId: string }
type Mail = {
  id: string; enrollment_id: string; purpose: string; generation: number; state: OnboardingEmailState;
  provider: string | null; provider_account_id: string | null; provider_message_id: string | null;
  provider_config_cipher: string | null; frozen_at: string | null; recipient_hash: string;
  claim_token: string | null; lease_until: string | null; attempts: number; error_code: string | null;
  created_at: string; updated_at: string; next_attempt_at: string; superseded_by_generation: number | null;
}
type Receipt = { id: string; enrollment_id: string; email_id: string; state: string; provider_message_id: string | null; evidence_type: string; occurred_at: string; observed_at: string }
const conflict = (code: string, message: string) => new AppError(409, code, message)
async function operatorFence(actor: SuperAdminActor, stepUpAt: string, db: DbExecutor) {
  await assertOperatorInTransaction(actor, db)
  const live = await db.queryOne("SELECT session_id FROM platform_step_ups WHERE session_id=? AND user_id=? AND verified_at=? AND verified_at::timestamptz<=clock_timestamp() AND verified_at::timestamptz>clock_timestamp()-(? * interval '1 minute') FOR SHARE", [actor.sessionId, actor.userId, stepUpAt, stepUpMinutes()])
  if (!live || await requirePlatformStepUp(actor) !== stepUpAt) throw new AppError(403, "step_up_required", "Complete a fresh operator step-up in this session.")
}
async function lockEnrollment(id: string, db: DbExecutor) {
  await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [`enrollment:${id}`])
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [id])
  const row = await findEnrollment(id, db)
  if (!row) throw new AppError(404, "enrollment_not_found", "Enrollment unavailable.")
  return row
}
function frozenIdentity(mail: Mail) {
  if (!mail.frozen_at || !mail.provider || !mail.provider_account_id || !mail.provider_config_cipher) return false
  try {
    const configuration = JSON.parse(decryptSensitive(mail.provider_config_cipher, onboardingEmailEncryptionScope(mail.enrollment_id, mail.generation))) as FrozenOnboardingEmailConfiguration
    return configuration.provider === mail.provider && onboardingEmailProviderIdentity(configuration) === mail.provider_account_id
  } catch { return false }
}
/** Fence the exact expired dispatch marker before operator resolution; no invented provider receipt. */
async function expireSending(mail: Mail, db: DbExecutor) {
  if (mail.state !== "sending") return
  const clock = nowIso()
  const changed = await db.execute("UPDATE mca_onboarding_service_emails SET state='uncertain',error_code='onboarding_email_interrupted',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='sending' AND claim_token=? AND lease_until=? AND lease_until<=? AND lease_until::timestamptz<=clock_timestamp()", [clock, mail.id, mail.claim_token, mail.lease_until, clock])
  if (!changed) throw conflict("onboarding_email_dispatch_live", "Wait for the active dispatch lease before reviewing evidence.")
  mail.state = "uncertain"; mail.claim_token = null; mail.lease_until = null
}

/** Human-reviewed evidence resolves a frozen intent; it never dispatches or reopens retry. */
export async function recordOnboardingEmailEvidence(expected: SuperAdminActor, input: OnboardingEmailEvidenceInput, request: Request): Promise<void> {
  const { actor, stepUpAt } = await operatorPermission(expected, request)
  const parsed = onboardingEmailEvidenceSchema.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "enrollmentId")))
  const evidenceHash = hmacScopedToken("onboarding-email-evidence", `${parsed.provider}:${parsed.providerConfigurationId}`, parsed.evidence)
  await withSuperAdminAction({ actor, action: "enrollment.email_evidence_recorded", targetType: "enrollment", targetId: input.enrollmentId, reason: parsed.reason, request, stepUpAt, after: { emailId: parsed.emailId, outcome: parsed.outcome, evidenceHash, provider: parsed.provider, providerConfigurationId: parsed.providerConfigurationId, providerIdentityVerified: false } }, async db => {
    await operatorFence(actor, stepUpAt, db)
    const row = await lockEnrollment(input.enrollmentId, db)
    const mail = await db.queryOne<Mail>("SELECT * FROM mca_onboarding_service_emails WHERE enrollment_id=? AND id=? FOR UPDATE", [row.id, parsed.emailId])
    if (!mail) throw conflict("onboarding_email_identity_mismatch", "The email does not belong to this enrollment.")
    if (!frozenIdentity(mail) || mail.provider !== parsed.provider || mail.provider_account_id !== parsed.providerConfigurationId) throw conflict("onboarding_email_identity_mismatch", "Review the exact frozen provider configuration.")
    await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [`email-evidence:${evidenceHash}`])
    const duplicate = await db.queryOne<Receipt>("SELECT * FROM mca_onboarding_service_email_receipts WHERE provider=? AND provider_account_id=? AND event_key=?", [mail.provider, mail.provider_account_id, evidenceHash])
    const recordedMessages = (await db.query<{ provider_message_id: string }>("SELECT DISTINCT provider_message_id FROM mca_onboarding_service_email_receipts WHERE enrollment_id=? AND email_id=? AND provider=? AND provider_account_id=? AND provider_message_id IS NOT NULL LIMIT 2", [row.id, mail.id, mail.provider, mail.provider_account_id])).rows
    const knownMessageId = mail.provider_message_id ?? recordedMessages[0]?.provider_message_id ?? null
    if (recordedMessages.some(receipt => receipt.provider_message_id !== knownMessageId)) throw conflict("onboarding_email_message_mismatch", "Review the conflicting recorded provider message binding.")
    const messageId = parsed.providerMessageId ?? knownMessageId
    if (duplicate) {
      if (duplicate.enrollment_id !== row.id || duplicate.email_id !== mail.id || duplicate.state !== parsed.outcome || duplicate.provider_message_id !== messageId) throw conflict("onboarding_email_evidence_conflict", "This evidence reference already describes another event.")
      return
    }
    if (row.revision !== parsed.expectedRevision) throw conflict("enrollment_revision_conflict", "Reload the enrollment before reviewing email evidence.")
    await expireSending(mail, db)
    if (mail.claim_token || mail.lease_until) throw conflict("onboarding_email_dispatch_live", "Wait for dispatch reconciliation before review.")
    if ((["accepted", "delivered"].includes(parsed.outcome) && !messageId) || (knownMessageId && messageId !== knownMessageId) || (!["accepted", "delivered"].includes(parsed.outcome) && parsed.providerMessageId && !knownMessageId)) throw conflict("onboarding_email_message_mismatch", "Match the known provider message identifier.")
    const positiveHistory = await db.queryOne("SELECT id FROM mca_onboarding_service_email_receipts WHERE email_id=? AND state IN ('accepted','delivered') LIMIT 1", [mail.id])
    if (!["accepted", "delivered"].includes(parsed.outcome) && (["accepted", "delivered"].includes(mail.state) || positiveHistory || mail.provider_message_id)) throw conflict("onboarding_email_history_conflict", "Known acceptance or delivery cannot be downgraded.")
    if (messageId) {
      await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [`email-message:${mail.provider}:${mail.provider_account_id}:${messageId}`])
      if (await db.queryOne("SELECT id FROM mca_onboarding_service_emails WHERE provider=? AND provider_account_id=? AND provider_message_id=? AND id<>?", [mail.provider, mail.provider_account_id, messageId, mail.id]) || await db.queryOne("SELECT id FROM mca_onboarding_service_email_receipts WHERE provider=? AND provider_account_id=? AND provider_message_id=? AND email_id<>? LIMIT 1", [mail.provider, mail.provider_account_id, messageId, mail.id])) throw conflict("onboarding_email_message_mismatch", "This provider message belongs to another email.")
    }
    const deliveredHistory = await db.queryOne("SELECT id FROM mca_onboarding_service_email_receipts WHERE email_id=? AND state='delivered' LIMIT 1", [mail.id])
    const state = mail.state === "delivered" || deliveredHistory ? "delivered" : parsed.outcome
    const clock = nowIso(), receiptId = newId()
    await operatorFence(actor, stepUpAt, db)
    const changed = await db.execute("UPDATE mca_onboarding_service_emails SET state=?,provider_message_id=?,error_code=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state=? AND claim_token IS NULL AND lease_until IS NULL", [state, messageId, ["failed", "suppressed"].includes(state) ? `onboarding_email_operator_${state}` : null, clock, mail.id, mail.state])
    if (!changed) throw conflict("onboarding_email_dispatch_live", "The email changed during review.")
    await db.execute("INSERT INTO mca_onboarding_service_email_receipts(id,enrollment_id,email_id,provider,provider_account_id,event_key,state,provider_message_id,evidence_type,occurred_at,observed_at) VALUES(?,?,?,?,?,?,?,?,'operator_review',?,?)", [receiptId, row.id, mail.id, mail.provider, mail.provider_account_id, evidenceHash, parsed.outcome, messageId, clock, clock])
    if (parsed.outcome === "suppressed") await db.execute("INSERT INTO mca_service_email_suppressions(recipient_hash,provider,provider_account_id,reason,active,evidence_receipt_id,created_at,updated_at) VALUES(?,?,?,'safety',true,?,?,?) ON CONFLICT(recipient_hash,provider,provider_account_id) DO UPDATE SET active=true,evidence_receipt_id=EXCLUDED.evidence_receipt_id,updated_at=EXCLUDED.updated_at", [mail.recipient_hash, mail.provider, mail.provider_account_id, receiptId, clock, clock])
    if (!await db.execute("UPDATE mca_enrollments SET revision=revision+1,updated_at=? WHERE id=? AND revision=?", [clock, row.id, row.revision])) throw conflict("enrollment_revision_conflict", "Enrollment changed during review.")
  })
}

async function billingEligible(row: EnrollmentRecord, db: DbExecutor) {
  const evidence = await readVerifiedEnrollmentBilling(row.id, db)
  if (!evidence || evidence.accountId !== row.providerAccountId || evidence.livemode !== row.offer.livemode || evidence.sessionId !== row.checkoutSessionId || evidence.customerId !== row.customerId || evidence.subscriptionId !== row.subscriptionId || evidence.requestGeneration !== row.checkoutGeneration || evidence.trialStartedAt !== row.trialStartedAt || evidence.trialEndsAt !== row.trialEndsAt || evidence.entitlement.status !== row.billingState) return false
  const periodEnd = row.billingState === "trialing" && evidence.entitlement.periodEnd && row.trialEndsAt ? new Date(Math.min(Date.parse(evidence.entitlement.periodEnd), Date.parse(row.trialEndsAt))).toISOString() : evidence.entitlement.periodEnd
  return evaluateCompanyAccess({ state_present: 1, legacy_exempt: 0, trial_ends_at: null, manual_paused: 0, access_extended_until: null, grace_ends_at: evidence.graceEndsAt, processing_extension_until: evidence.processingExtensionUntil, pending_seats: null, status: evidence.entitlement.status, period_end: periodEnd, seat_limit: evidence.entitlement.seatLimit }).allowed
}
async function approvedRecovery(row: EnrollmentRecord, db: DbExecutor) {
  const approval = await db.queryOne<{ after_json: { challengeId?: string; providerUserId?: string; purchaseEvidenceHash?: string; emailGeneration?: number }; step_up_at: string; created_at: string }>("SELECT after_json,step_up_at,created_at FROM platform_admin_audit WHERE action='enrollment.identity_recovery_approved' AND target_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [row.id])
  if (!approval || !row.claimedProviderUserId || approval.after_json.providerUserId !== row.claimedProviderUserId || !approval.after_json.emailGeneration || approval.after_json.emailGeneration > row.emailGeneration) return null
  const challenge = await db.queryOne<EnrollmentChallenge>("SELECT * FROM mca_enrollment_challenges WHERE id=? AND enrollment_id=? AND purpose='contact_recovery' AND verified_at IS NOT NULL", [approval.after_json.challengeId, row.id])
  if (!challenge || challenge.provider_user_id !== row.claimedProviderUserId || challenge.email_hash !== row.emailHash || challenge.purchase_evidence_hash !== approval.after_json.purchaseEvidenceHash) return null
  const payload = readEnrollmentChallengePayload(challenge)
  if (payload.emailGeneration !== approval.after_json.emailGeneration - 1 || enrollmentEmailHash(payload.email) !== row.emailHash || !payload.sessionId) return null
  return { approval, challenge, payload }
}
async function reissueEligible(row: EnrollmentRecord, db: DbExecutor) {
  if (!row.activatedAt || row.checkoutState !== "complete" || row.workspaceId || row.userId || row.claimState !== "unclaimed" || row.finalizationState !== "pending" || row.recoveryState !== "none" || row.claimToken || !row.claimedProviderUserId || (row.initiatingProviderUserId && row.initiatingProviderUserId !== row.claimedProviderUserId)) return false
  if (!await billingEligible(row, db)) return false
  if (await db.queryOne("SELECT recipient_hash FROM mca_service_email_suppressions WHERE recipient_hash=? AND active=true LIMIT 1", [row.emailHash])) return false
  if (await db.queryOne("SELECT id FROM mca_onboarding_service_emails WHERE enrollment_id=? AND (state IN ('sending','uncertain') OR claim_token IS NOT NULL OR (generation=? AND (state IN ('accepted','delivered') OR provider_message_id IS NOT NULL))) LIMIT 1", [row.id, row.emailGeneration])) return false
  if (await db.queryOne("SELECT r.id FROM mca_onboarding_service_email_receipts r JOIN mca_onboarding_service_emails e ON e.id=r.email_id AND e.enrollment_id=r.enrollment_id WHERE e.enrollment_id=? AND e.recipient_hash=? AND r.state IN ('accepted','delivered') LIMIT 1", [row.id, row.emailHash])) return false
  return Boolean(await approvedRecovery(row, db))
}

/** Explicit, separately approved generation invalidation; never replay a frozen row. */
export async function reissueOnboardingEmails(expected: SuperAdminActor, input: EnrollmentRecoveryEvidence & { expectedRevision: number }, request: Request): Promise<void> {
  const { actor, stepUpAt } = await operatorPermission(expected, request)
  reference.parse(input.purchaseEvidence)
  z.string().trim().min(10).max(500).parse(input.reason)
  z.number().int().positive().safe().parse(input.expectedRevision)
  const observed = await findEnrollment(input.enrollmentId)
  if (!observed?.claimedProviderUserId) throw conflict("onboarding_email_reissue_not_allowed", "Approve independent contact recovery before reissue.")
  if (observed.revision !== input.expectedRevision) throw conflict("enrollment_revision_conflict", "Reload the enrollment before reissue.")
  const { data, error } = await getSupabaseAdminClient().auth.admin.getUserById(observed.claimedProviderUserId)
  const target = data.user
  if (error || !target || !verifiedSupabaseUser(target) || target.app_metadata.mca_migration_pending === true || enrollmentEmailHash(target.email!) !== observed.emailHash) throw conflict("onboarding_email_reissue_not_allowed", "The approved target identity is no longer current.")
  const proof = hmacScopedToken("onboarding-purchase-evidence", observed.id, input.purchaseEvidence)
  await withSuperAdminAction({ actor, action: "enrollment.email_generation_reissued", targetType: "enrollment", targetId: observed.id, reason: input.reason, request, stepUpAt, before: { revision: input.expectedRevision, emailGeneration: observed.emailGeneration }, after: { revision: input.expectedRevision + 1, emailGeneration: observed.emailGeneration + 1, purchaseEvidenceHash: proof } }, async db => {
    await operatorFence(actor, stepUpAt, db)
    const row = await lockEnrollment(observed.id, db)
    if (row.revision !== input.expectedRevision) throw conflict("enrollment_revision_conflict", "Reload the enrollment before reissue.")
    const previous = (await db.query<Mail>("SELECT * FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY id FOR UPDATE", [row.id])).rows
    // An expired send remains unresolved uncertainty. Commit no generation until its separate evidence action succeeds.
    if (!await reissueEligible(row, db) || row.claimedProviderUserId !== target.id || row.emailHash !== enrollmentEmailHash(target.email!)) throw conflict("onboarding_email_reissue_not_allowed", "Resolve delivery uncertainty and current recovery or billing holds before reissue.")
    const approved = (await approvedRecovery(row, db))!
    const lastReissue = await db.queryOne<{ step_up_at: string }>("SELECT step_up_at FROM platform_admin_audit WHERE action='enrollment.email_generation_reissued' AND target_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [row.id])
    if (Date.parse(stepUpAt) <= Date.parse(approved.approval.step_up_at) || Date.parse(stepUpAt) < Date.parse(approved.approval.created_at) || (lastReissue && Date.parse(stepUpAt) <= Date.parse(lastReissue.step_up_at))) throw new AppError(403, "step_up_required", "Complete a NEW operator step-up after contact approval or the previous reissue.")
    if (proof !== approved.approval.after_json.purchaseEvidenceHash || !await liveSupabaseSession(approved.payload.sessionId!, target.id) || await db.queryOne("SELECT m.id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.supabase_user_id=? AND m.status='active' LIMIT 1", [target.id]) || await db.queryOne("SELECT id FROM users WHERE lower(email)=? AND (supabase_user_id IS NULL OR supabase_user_id<>?)", [target.email!.trim().toLowerCase(), target.id])) throw conflict("onboarding_email_reissue_not_allowed", "The approved purchase, target session or company association has changed.")
    // Parked invites may already occupy the next generation.
    const generation = await nextEmailGeneration(row.id, row.emailGeneration, db), clock = nowIso()
    await operatorFence(actor, stepUpAt, db)
    if (!await db.execute("UPDATE mca_enrollments SET email_generation=?,resume_generation=resume_generation+1,resume_secret_hash=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", [generation, hashOpaqueToken(createOpaqueToken()), clock, row.id, row.revision])) throw conflict("enrollment_revision_conflict", "Enrollment changed during reissue.")
    await db.execute("UPDATE mca_enrollment_challenges SET state='revoked',updated_at=? WHERE enrollment_id=? AND state IN ('pending','verified')", [clock, row.id])
    for (const mail of previous) {
      if (["accepted", "delivered"].includes(mail.state)) continue
      const state = ["queued", "retry", "failed"].includes(mail.state) ? "suppressed" : mail.state
      await db.execute("UPDATE mca_onboarding_service_emails SET state=?,superseded_by_generation=?,updated_at=? WHERE id=? AND claim_token IS NULL AND superseded_by_generation IS NULL", [state, generation, clock, mail.id])
    }
    await enqueueOnboardingEmailIntents(row.id, generation, db)
  })
}

/** Protected operator projection, entirely read-only and independent of provider availability. */
export async function readOnboardingEmailDetails(row: EnrollmentRecord) {
  const db = getDatabase(), rows = (await db.query<Mail>("SELECT * FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY generation DESC,purpose LIMIT 100", [row.id])).rows
  const runtime = { runtimeEnabled: enrollmentRuntimeEnabled(), creationEnabled: enrollmentCreationEnabled(), emailDispatchEnabled: onboardingEmailEnabled() }
  const emails = []
  for (const mail of rows) {
    const receipts = (await db.query<Receipt>("SELECT id,state,provider_message_id,evidence_type,occurred_at,observed_at FROM mca_onboarding_service_email_receipts WHERE enrollment_id=? AND email_id=? ORDER BY observed_at DESC,id DESC LIMIT 20", [row.id, mail.id])).rows
    const activeLease = mail.state === "sending" && (!mail.lease_until || Date.parse(mail.lease_until) > Date.now() || Boolean(await db.queryOne("SELECT id FROM mca_onboarding_service_emails WHERE id=? AND lease_until::timestamptz>clock_timestamp()", [mail.id])))
    emails.push({ id: mail.id, purpose: mail.purpose, generation: mail.generation, state: mail.state, attempts: mail.attempts, createdAt: mail.created_at, updatedAt: mail.updated_at, ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(mail.created_at)) / 1000)), nextAttemptAt: mail.next_attempt_at, errorCode: mail.error_code, provider: mail.provider, providerConfigurationId: mail.provider_account_id, providerIdentityVerified: false as const, providerMessageId: mail.provider_message_id, supersededByGeneration: mail.superseded_by_generation, canRecordEvidence: runtime.runtimeEnabled && !activeLease && frozenIdentity(mail), receipts: receipts.map(receipt => ({ id: receipt.id, state: receipt.state, providerMessageId: receipt.provider_message_id, evidenceType: receipt.evidence_type, occurredAt: receipt.occurred_at, observedAt: receipt.observed_at })) })
  }
  const availableActions: string[] = []
  if (runtime.runtimeEnabled && row.activatedAt && !row.workspaceId && !row.userId && row.claimState === "unclaimed" && row.finalizationState === "pending" && row.recoveryState === "none" && !row.claimToken && !row.claimedProviderUserId) {
    availableActions.push("verify_target")
    if (await db.queryOne("SELECT id FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose='contact_recovery' AND state='verified' AND verified_at IS NOT NULL AND resume_generation=? AND expires_at::timestamptz>clock_timestamp() LIMIT 1", [row.id, row.resumeGeneration])) availableActions.push("approve_identity")
  }
  if (emails.some(mail => mail.canRecordEvidence)) availableActions.push("record_email_evidence")
  try { if (runtime.runtimeEnabled && await reissueEligible(row, db)) availableActions.push("reissue_emails") } catch { /* SQL diagnostics remain available when encrypted proof is unreadable. */ }
  return { emails, availableActions, runtime }
}
