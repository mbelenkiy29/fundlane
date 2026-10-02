import "server-only"
import {
  getDatabase,
  newId,
  nowIso,
  recordAuditEvent,
  withImmediateTransaction,
  type DbExecutor,
} from "../db"
import { AppError } from "../errors"
import {
  linkSupabaseUser,
  liveSupabaseSession,
  resolveSupabaseMembership,
  setActiveWorkspace,
  supabaseIdentity,
  type SupabaseIdentity,
} from "../supabase-auth"
import { getTotpAccessState } from "../totp-service"
import {
  DEFAULT_ACTION_VISIBILITY,
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PAGE_VISIBILITY,
} from "../workspaces"
import { trialAllowedForIdentity } from "../trial-abuse"
import { getCompanyAccess } from "../company-access"
import {
  enrollmentContinuation,
  type EnrollmentDestination,
} from "../auth-navigation"
import type { StripeBillingClient } from "../billing"
import {
  attachEnrollmentBilling,
  compensateEnrollment,
  recordEnrollmentTrialGrant,
} from "./billing"
import { enrollmentRuntimeEnabled } from "./config"
import {
  enrollmentEmailHash,
  findEnrollment,
  readEnrollmentContact,
  verifyEnrollmentResume,
} from "./store"
import { reconcileEnrollment } from "./reconcile"
import type { EnrollmentRecord } from "./contracts"

export function requireEnrollmentRuntime(): void {
  if (!enrollmentRuntimeEnabled())
    throw new AppError(
      503,
      "enrollment_disabled",
      "Enrollment recovery is unavailable."
    )
}
export async function freshEnrollmentIdentity(
  expected: SupabaseIdentity
): Promise<SupabaseIdentity> {
  const identity = await supabaseIdentity()
  if (
    !identity ||
    identity.user.id !== expected.user.id ||
    identity.sessionId !== expected.sessionId ||
    identity.email !== expected.email.trim().toLowerCase()
  )
    throw new AppError(
      401,
      "authentication_required",
      "Sign in with a verified account to continue."
    )
  return identity
}
export function assertEnrollmentGeneration(
  row: EnrollmentRecord,
  generation?: number
): void {
  if (
    generation !== undefined &&
    (!Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation !== row.emailGeneration)
  )
    throw new AppError(
      409,
      "enrollment_link_superseded",
      "Open the current enrollment link or request a new one."
    )
}
export function assertEnrollmentIdentity(
  row: EnrollmentRecord,
  identity: SupabaseIdentity
): void {
  if (
    !row.emailHash ||
    enrollmentEmailHash(identity.email) !== row.emailHash ||
    (row.initiatingProviderUserId &&
      row.initiatingProviderUserId !== identity.user.id) ||
    (row.claimedProviderUserId &&
      row.claimedProviderUserId !== identity.user.id)
  )
    throw new AppError(
      403,
      "enrollment_identity_mismatch",
      "Use the verified account associated with this enrollment, or request operator recovery."
    )
}
export async function assertEnrollmentSession(
  identity: SupabaseIdentity,
  userId?: string,
  db: DbExecutor = getDatabase()
): Promise<void> {
  if (!(await liveSupabaseSession(identity.sessionId, identity.user.id)))
    throw new AppError(
      401,
      "authentication_required",
      "Sign in again to continue."
    )
  if (!userId) return
  // These reads use the transaction-aware executor; no provider request occurs here.
  const linked = await db.queryOne(
    "SELECT id FROM users WHERE id=? AND supabase_user_id=?",
    [userId, identity.user.id]
  )
  if (!linked)
    throw new AppError(
      409,
      "identity_conflict",
      "This account linkage has changed."
    )
  const state = await getTotpAccessState({
    userId,
    sessionId: identity.sessionId,
  })
  if (state.enrollmentRequired)
    throw new AppError(
      403,
      "totp_enrollment_required",
      "Enroll an authenticator before continuing."
    )
  if (state.challengeRequired)
    throw new AppError(
      403,
      "totp_required",
      "Complete authenticator verification before continuing."
    )
}
export async function enrollmentDestination(
  row: EnrollmentRecord,
  destination: EnrollmentDestination = "crm",
  generation?: number
): Promise<string> {
  if (!row.workspaceId)
    return enrollmentContinuation({
      enrollmentId: row.id,
      destination,
      ...(generation ? { generation } : {}),
    })
  if (
    destination === "billing" ||
    !(await getCompanyAccess(row.workspaceId)).allowed
  )
    return "/settings/billing"
  return destination === "business" ? "/settings/business" : "/dashboard"
}

export async function claimEnrollment(
  input: {
    enrollmentId: string
    identity: SupabaseIdentity
    destination?: EnrollmentDestination
    generation?: number
  },
  client?: StripeBillingClient
): Promise<{ workspaceId: string; destination: string }> {
  requireEnrollmentRuntime()
  const identity = await freshEnrollmentIdentity(input.identity)
  let current = await findEnrollment(input.enrollmentId)
  if (!current)
    throw new AppError(404, "enrollment_not_found", "Enrollment unavailable.")
  assertEnrollmentGeneration(current, input.generation)
  assertEnrollmentIdentity(current, identity)
  // Provider reconciliation is outside the atomic tenant transaction.
  if (current.claimState !== "claimed")
    current = await reconcileEnrollment(current.id, client)
  const verified = current
  const result = await withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [
      `enrollment:${verified.id}`,
    ])
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      verified.id,
    ])
    const row = (await findEnrollment(verified.id, db))!
    assertEnrollmentGeneration(row, input.generation)
    assertEnrollmentIdentity(row, identity)
    await assertEnrollmentSession(identity, undefined, db)
    if (row.claimState === "claimed" && row.workspaceId && row.userId) {
      await assertEnrollmentSession(identity, row.userId, db)
      return { workspaceId: row.workspaceId }
    }
    if (row.claimToken)
      throw new AppError(
        409,
        "enrollment_busy",
        "Enrollment is being reconciled. Retry after confirmation."
      )
    if (
      !row.activatedAt ||
      row.claimState !== "unclaimed" ||
      row.finalizationState !== "pending" ||
      row.recoveryState !== "none" ||
      row.errorCode
    )
      throw new AppError(
        409,
        "enrollment_not_ready",
        "Enrollment requires billing confirmation or recovery."
      )
    for (const key of [
      `provider:${identity.user.id}`,
      `email:${identity.email}`,
      `domain:${identity.email.split("@")[1]}`,
    ].sort())
      await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [key])
    const userId = await linkSupabaseUser(identity)
    await db.queryOne("SELECT pg_advisory_xact_lock(105,hashtext(?))", [
      `user:${userId}`,
    ])
    await assertEnrollmentSession(identity, userId, db)
    const memberships = await db
      .prepare<{
        workspace_id: string
      }>(
        "SELECT workspace_id FROM memberships WHERE user_id=? AND status='active'"
      )
      .all(userId)
    let existingCompany = false
    for (const membership of memberships)
      if ((await getCompanyAccess(membership.workspace_id)).allowed)
        existingCompany = true
    const eligible = await trialAllowedForIdentity(
      { userId, providerUserId: identity.user.id, email: identity.email },
      { enrollmentId: row.id },
      db
    )
    if (existingCompany || !eligible) {
      await db.execute(
        "UPDATE mca_enrollments SET claim_state='blocked',finalization_state='blocked',recovery_state='pending',error_code=?,next_reconcile_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        [
          existingCompany
            ? "enrollment_existing_company"
            : "trial_not_eligible",
          nowIso(),
          nowIso(),
          row.id,
          row.revision,
        ]
      )
      return {
        blocked: existingCompany
          ? "enrollment_existing_company"
          : "trial_not_eligible",
      }
    }
    // Attachment validates this fresh reconciliation revision before any association update.
    if (row.revision !== verified.revision)
      throw new AppError(
        409,
        "enrollment_evidence_stale",
        "Refresh enrollment billing and retry."
      )
    const workspaceId = newId(),
      membershipId = newId(),
      now = nowIso()
    await db.execute(
      "INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',1,?,?,?,?,?)",
      [
        workspaceId,
        readEnrollmentContact(row).businessName,
        JSON.stringify(DEFAULT_FEATURE_FLAGS),
        JSON.stringify(DEFAULT_PAGE_VISIBILITY),
        JSON.stringify(DEFAULT_ACTION_VISIBILITY),
        now,
        now,
      ]
    )
    await db.execute(
      "INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)",
      [membershipId, workspaceId, userId, now, now]
    )
    await db.execute(
      "INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)",
      [workspaceId, membershipId, now]
    )
    await attachEnrollmentBilling(db, workspaceId, verified)
    await recordEnrollmentTrialGrant(db, workspaceId, verified, {
      userId,
      providerUserId: identity.user.id,
      email: identity.email,
    })
    await db.execute(
      "INSERT INTO sms_companies(workspace_id,owner_user_id,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?)",
      [workspaceId, userId, identity.user.email_confirmed_at, now, now]
    )
    await assertEnrollmentSession(identity, userId, db)
    const changed = await db.execute(
      "UPDATE mca_enrollments SET workspace_id=?,user_id=?,claimed_provider_user_id=?,claim_state='claimed',finalization_state='complete',revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      [workspaceId, userId, identity.user.id, now, row.id, row.revision]
    )
    if (changed !== 1)
      throw new AppError(
        409,
        "enrollment_revision_conflict",
        "Retry enrollment finalization."
      )
    await recordAuditEvent({
      context: { workspaceId, userId },
      action: "enrollment.claimed",
      resourceType: "enrollment",
      resourceId: row.id,
      executor: db,
    })
    return { workspaceId }
  })
  if ("blocked" in result) {
    // The durable blocked/pending decision commits before narrow internal compensation.
    try {
      await compensateEnrollment(verified.id, client)
    } catch (error) {
      if (!(error instanceof AppError && error.code === "enrollment_busy"))
        throw error
    }
    throw new AppError(
      409,
      result.blocked!,
      "This enrollment requires billing recovery; an existing company is preserved."
    )
  }
  await setActiveWorkspace(identity, result.workspaceId)
  return {
    workspaceId: result.workspaceId,
    destination: await enrollmentDestination(
      (await findEnrollment(verified.id))!,
      input.destination,
      input.generation
    ),
  }
}

export type EnrollmentPublicStatus = {
  state: "unavailable" | "pending" | "ready" | "claimed" | "recovery_required"
  nextAction: "authenticate" | "wait" | "claim" | "continue" | "recover"
  trialEndsAt?: string
  destination?: string
}
export async function readEnrollmentStatus(
  input: {
    enrollmentId: string
    resumeSecret?: string
    identity?: SupabaseIdentity
    generation?: number
    destination?: EnrollmentDestination
  },
  client?: StripeBillingClient
): Promise<EnrollmentPublicStatus> {
  requireEnrollmentRuntime()
  let row = await findEnrollment(input.enrollmentId)
  if (!row) return { state: "unavailable", nextAction: "authenticate" }
  const identity = input.identity
    ? await freshEnrollmentIdentity(input.identity)
    : undefined
  let identityAuthorized = false
  if (identity)
    try {
      assertEnrollmentIdentity(row, identity)
      identityAuthorized = true
    } catch {
      /* Account mismatch conveys no enrollment facts. */
    }
  const resumeAuthorized = Boolean(
    input.resumeSecret && verifyEnrollmentResume(row, input.resumeSecret)
  )
  if (!identityAuthorized && !resumeAuthorized)
    return { state: "unavailable", nextAction: "authenticate" }
  assertEnrollmentGeneration(row, input.generation)
  if (
    !row.workspaceId &&
    row.recoveryState === "none" &&
    row.claimState === "unclaimed"
  )
    row = await reconcileEnrollment(row.id, client)
  assertEnrollmentGeneration(row, input.generation)
  if (identityAuthorized && identity)
    try {
      assertEnrollmentIdentity(row, identity)
    } catch {
      identityAuthorized = false
    }
  if (
    !identityAuthorized &&
    !(input.resumeSecret && verifyEnrollmentResume(row, input.resumeSecret))
  )
    return { state: "unavailable", nextAction: "authenticate" }
  if (
    row.workspaceId &&
    identityAuthorized &&
    identity &&
    !(await resolveSupabaseMembership(identity, row.workspaceId))
  )
    return {
      state: "recovery_required",
      nextAction: "recover",
      ...(row.trialEndsAt ? { trialEndsAt: row.trialEndsAt } : {}),
    }
  const facts = {
    ...(row.trialEndsAt ? { trialEndsAt: row.trialEndsAt } : {}),
    ...(identityAuthorized
      ? {
          destination: await enrollmentDestination(
            row,
            input.destination,
            input.generation
          ),
        }
      : {}),
  }
  if (row.recoveryState !== "none" || row.claimState === "blocked")
    return { state: "recovery_required", nextAction: "recover", ...facts }
  if (row.claimState === "claimed")
    return {
      state: "claimed",
      nextAction: identityAuthorized ? "continue" : "authenticate",
      ...facts,
    }
  if (row.activatedAt)
    return {
      state: "ready",
      nextAction: identityAuthorized ? "claim" : "authenticate",
      ...facts,
    }
  return { state: "pending", nextAction: "wait", ...facts }
}
