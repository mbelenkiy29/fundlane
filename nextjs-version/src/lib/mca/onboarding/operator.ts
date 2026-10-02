import "server-only"
import { z } from "zod"
import { getDatabase, nowIso } from "../db"
import { AppError } from "../errors"
import { requireSuperAdmin, type SuperAdminActor } from "../platform-auth"
import { enrollmentCreationEnabled, enrollmentRuntimeEnabled, onboardingEmailEnabled } from "./config"
import { enrollmentQueueQuerySchema, type EnrollmentOperationsPage, type EnrollmentOperationsRow, type EnrollmentQueueQuery } from "./operator-contracts"

const cursorSchema = z.object({ stamp: z.iso.datetime(), id: z.uuid(), enrollmentId: z.string(), state: z.string() }).strict()

/** Diagnostic reads remain available during rollback. No provider reads, decryption or enrollment mutations. */
export async function listEnrollmentOperations(actor: SuperAdminActor, input: EnrollmentQueueQuery): Promise<EnrollmentOperationsPage> {
  const live = await requireSuperAdmin()
  if (live.userId !== actor.userId || live.sessionId !== actor.sessionId || live.supabaseUserId !== actor.supabaseUserId) throw new AppError(403, "super_admin_required", "Platform access required.")
  const parsed = enrollmentQueueQuerySchema.safeParse(input)
  if (!parsed.success) throw new AppError(422, "invalid_query", "Invalid enrollment filters.")
  const query = parsed.data
  let cursor: z.infer<typeof cursorSchema> | undefined
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))) }
    catch { throw new AppError(422, "invalid_query", "Invalid enrollment cursor.") }
    if (cursor.enrollmentId !== (query.enrollmentId ?? "") || cursor.state !== (query.state ?? "")) throw new AppError(422, "invalid_query", "Restart pagination after changing filters.")
  }
  const snapshotAt = nowIso(), stalledBefore = new Date(Date.parse(snapshotAt) - 15 * 60_000).toISOString()
  // The CTE projects only allowed metadata; contact, offer, hashes, tokens and provider payloads are never selected.
  const rows = await getDatabase().prepare<EnrollmentOperationsRow>(`WITH clock AS (SELECT ?::text now,?::text stalled), operations AS (
    SELECT e.id "enrollmentId",e.revision,e.created_at "createdAt",e.updated_at "updatedAt",e.workspace_id "workspaceId",
      e.checkout_state "checkoutState",e.billing_state "billingState",e.claim_state "claimState",e.finalization_state "finalizationState",e.recovery_state "recoveryState",
      e.trial_ends_at "trialEndsAt",e.activated_at "activatedAt",e.verified_at "verifiedAt",e.next_reconcile_at "nextReconcileAt",e.lease_until "leaseUntil",e.error_code IS NOT NULL "hasRepairError",
      CASE WHEN e.workspace_id IS NOT NULL THEN 'attached' WHEN e.recovery_state='operator_required' THEN 'operator_required'
        WHEN e.lease_until IS NOT NULL AND e.lease_until>=clock.now THEN 'lease_active' WHEN e.next_reconcile_at>clock.now THEN 'scheduled'
        WHEN e.next_reconcile_at<=clock.stalled THEN 'stalled' ELSE 'due' END "repairState",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('purpose',m.purpose,'state',m.state,'attempts',m.attempts,'hasError',m.error_code IS NOT NULL,'nextAttemptAt',m.next_attempt_at) ORDER BY m.purpose)
        FROM mca_onboarding_service_emails m WHERE m.enrollment_id=e.id AND m.generation=e.email_generation),'[]'::jsonb) emails
      FROM mca_enrollments e CROSS JOIN clock)
    SELECT * FROM operations WHERE (?='' OR "enrollmentId"=?) AND (
      ?='' OR (?='pending' AND "workspaceId" IS NULL) OR (?='claimed' AND "claimState"='claimed')
      OR (?='due' AND "repairState" IN ('due','stalled')) OR (?='stalled' AND "repairState"='stalled')
      OR (?='compensation' AND "recoveryState" IN ('pending','canceling','uncertain')) OR (?='operator_required' AND "recoveryState"='operator_required')
      OR (?='mail_uncertain' AND emails @> '[{"state":"uncertain"}]') OR (?='mail_failed' AND emails @> '[{"state":"failed"}]'))
      AND (?='' OR ("createdAt","enrollmentId")>(?,?)) ORDER BY "createdAt","enrollmentId" LIMIT ?`)
    .all(snapshotAt, stalledBefore, query.enrollmentId ?? "", query.enrollmentId ?? "", ...Array(9).fill(query.state ?? ""), cursor?.id ?? "", cursor?.stamp ?? "", cursor?.id ?? "", query.limit + 1)
  const items = rows.slice(0, query.limit), last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ stamp: last.createdAt, id: last.enrollmentId, enrollmentId: query.enrollmentId ?? "", state: query.state ?? "" })).toString("base64url") : null,
    snapshotAt,
    runtime: { enabled: enrollmentRuntimeEnabled(), creationEnabled: enrollmentCreationEnabled(), emailEnabled: onboardingEmailEnabled() },
  }
}
