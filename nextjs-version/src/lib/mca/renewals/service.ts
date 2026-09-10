import "server-only"

import { AppError } from "../errors"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { estimateScheduledPaidIn } from "../advances/performance"
import { listAdvanceRows } from "../advances/repository"
import type { RenewalAction } from "../accounting/contracts"
import { getDealForDocument } from "../deals/service"
import { findAdvanceRow } from "../advances/repository"
import { requestRenewalDocuments } from "../closing/service"

const DAY_MS = 86_400_000

function dollars(cents: number): string {
  return `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`
}

type PolicyRow = { paid_in_threshold_basis_points: number; minimum_days_since_funding: number; version: number; updated_at: string }
type ActionRow = {
  id: string; source_advance_id: string; renewed_deal_id: string | null; policy_version: number; eligible_at: string
  state: RenewalAction["state"]; message_subject: string; message_body: string; documentation_requested_at: string | null
  created_at: string; updated_at: string
}

function action(row: ActionRow): RenewalAction {
  return { id: row.id, sourceAdvanceId: row.source_advance_id, renewedDealId: row.renewed_deal_id,
    policyVersion: row.policy_version, eligibleAt: row.eligible_at, state: row.state,
    messageSubject: row.message_subject, messageBody: row.message_body,
    documentationRequestedAt: row.documentation_requested_at, createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function getRenewalPolicy(actor: DealActor) {
  const row = await getDatabase().prepare<PolicyRow>(`SELECT paid_in_threshold_basis_points, minimum_days_since_funding, version, updated_at
    FROM mca_renewal_policies WHERE workspace_id=?`).get(actor.workspaceId)
  return row ? { paidInThresholdBasisPoints: row.paid_in_threshold_basis_points, minimumDaysSinceFunding: row.minimum_days_since_funding,
    version: row.version, updatedAt: row.updated_at } : null
}

export async function saveRenewalPolicy(actor: DealActor, input: { paidInThresholdBasisPoints: number; minimumDaysSinceFunding: number }) {
  if (!Number.isInteger(input.paidInThresholdBasisPoints) || input.paidInThresholdBasisPoints < 0 || input.paidInThresholdBasisPoints > 10_000) {
    throw new AppError(400, "validation_failed", "Paid-in threshold must be integer basis points from 0 through 10000.")
  }
  if (!Number.isSafeInteger(input.minimumDaysSinceFunding) || input.minimumDaysSinceFunding < 0) {
    throw new AppError(400, "validation_failed", "Minimum days since funding must be a non-negative integer.")
  }
  return withImmediateTransaction(async (database) => {
    const previous = await database.prepare<PolicyRow>(`SELECT paid_in_threshold_basis_points, minimum_days_since_funding, version, updated_at
      FROM mca_renewal_policies WHERE workspace_id=? FOR UPDATE`).get(actor.workspaceId)
    const version = (previous?.version ?? 0) + 1; const timestamp = nowIso()
    await database.prepare(`INSERT INTO mca_renewal_policies
      (workspace_id,paid_in_threshold_basis_points,minimum_days_since_funding,version,updated_by_user_id,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT (workspace_id) DO UPDATE SET
      paid_in_threshold_basis_points=excluded.paid_in_threshold_basis_points,
      minimum_days_since_funding=excluded.minimum_days_since_funding,version=excluded.version,
      updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`).run(
        actor.workspaceId, input.paidInThresholdBasisPoints, input.minimumDaysSinceFunding, version, actor.userId, timestamp,
      )
    await recordAuditEvent({ context: actor, action: "renewal.policy.versioned", resourceType: "renewal_policy",
      resourceId: actor.workspaceId, correlationId: actor.correlationId, metadata: { version }, executor: database })
    return { ...input, version, updatedAt: timestamp }
  })
}

export async function runRenewalEligibility(actor: DealActor, asOf = nowIso()): Promise<{ created: number; eligible: RenewalAction[] }> {
  const policy = await getRenewalPolicy(actor)
  if (!policy) throw new AppError(409, "renewal_policy_required", "Configure a renewal eligibility policy first.")
  const advances = await listAdvanceRows(actor.workspaceId)
  return withImmediateTransaction(async (database) => {
    const eligible: RenewalAction[] = []; let created = 0
    for (const advance of advances) {
      const ageDays = Math.floor((Date.parse(asOf) - Date.parse(advance.funded_at)) / DAY_MS)
      const estimate = estimateScheduledPaidIn({ fundedAt: advance.funded_at, asOf,
        paybackCents: advance.payback_cents, periodicPaymentCents: advance.periodic_payment_cents,
        paymentCount: advance.payment_count, paymentFrequency: advance.payment_frequency,
        calendarConvention: advance.calendar_convention })
      if (ageDays < policy.minimumDaysSinceFunding || estimate.paidInBasisPoints === null
        || estimate.paidInBasisPoints < policy.paidInThresholdBasisPoints) continue
      const id = newId(); const timestamp = nowIso()
      const idempotencyKey = `eligibility:v${policy.version}:${advance.id}`
      const subject = `Renewal review for ${advance.business_name}`
      const body = `${advance.business_name}'s ${dollars(advance.principal_cents)} advance with ${advance.funder_name}, funded ${new Date(advance.funded_at).toLocaleDateString("en-US", { timeZone: "UTC" })}, has reached an estimated ${(estimate.paidInBasisPoints / 100).toFixed(2)}% paid in. Review current documents before offering repeat funding.`
      const row = await database.prepare<ActionRow>(`INSERT INTO mca_renewal_actions
        (id,workspace_id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,message_subject,message_body,
         documentation_requested_at,idempotency_key,created_by_user_id,created_at,updated_at)
        VALUES (?,?,?,NULL,?,?,'eligible',?,?,NULL,?,?,?,?)
        ON CONFLICT (workspace_id,source_advance_id,idempotency_key) DO NOTHING
        RETURNING id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,message_subject,message_body,
          documentation_requested_at,created_at,updated_at`).get(
          id, actor.workspaceId, advance.id, policy.version, asOf, subject, body, idempotencyKey, actor.userId, timestamp, timestamp,
        )
      const resolved = row ?? await database.prepare<ActionRow>(`SELECT id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,
        message_subject,message_body,documentation_requested_at,created_at,updated_at FROM mca_renewal_actions
        WHERE workspace_id=? AND source_advance_id=? AND idempotency_key=?`).get(actor.workspaceId, advance.id, idempotencyKey)
      if (!resolved) throw new Error("Renewal eligibility conflict could not be replayed.")
      if (row) created += 1
      eligible.push(action(resolved))
    }
    await recordAuditEvent({ context: actor, action: "renewal.eligibility.ran", resourceType: "workspace",
      resourceId: actor.workspaceId, correlationId: actor.correlationId, metadata: { policyVersion: policy.version, created }, executor: database })
    return { created, eligible }
  })
}

export async function listRenewalActions(actor: DealActor, filters: { state?: RenewalAction["state"]; eligibleBefore?: string } = {}): Promise<RenewalAction[]> {
  const clauses = ["workspace_id=?"]; const values: unknown[] = [actor.workspaceId]
  if (filters.state) { clauses.push("state=?"); values.push(filters.state) }
  if (filters.eligibleBefore) { clauses.push("eligible_at<=?"); values.push(filters.eligibleBefore) }
  const rows = await getDatabase().prepare<ActionRow>(`SELECT id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,
    message_subject,message_body,documentation_requested_at,created_at,updated_at FROM mca_renewal_actions
    WHERE ${clauses.join(" AND ")} ORDER BY eligible_at,id`).all(...values)
  return rows.map(action)
}

export async function updateRenewalAction(actor: DealActor, id: string, input: {
  messageSubject?: string; messageBody?: string; state?: RenewalAction["state"]; renewedDealId?: string | null; requestDocumentation?: boolean
}): Promise<RenewalAction> {
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<ActionRow>(`SELECT id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,
      message_subject,message_body,documentation_requested_at,created_at,updated_at FROM mca_renewal_actions
      WHERE workspace_id=? AND id=? FOR UPDATE`).get(actor.workspaceId, id)
    if (!row) throw new AppError(404, "renewal_action_not_found", "The requested renewal action was not found.")
    const timestamp = nowIso()
    const next = {
      subject: input.messageSubject?.trim() || row.message_subject,
      body: input.messageBody?.trim() || row.message_body,
      state: input.requestDocumentation ? "documents_requested" : (input.state ?? row.state),
      renewedDealId: input.renewedDealId === undefined ? row.renewed_deal_id : input.renewedDealId,
      documentationRequestedAt: input.requestDocumentation ? timestamp : row.documentation_requested_at,
    }
    const sourceAdvance = await findAdvanceRow(actor.workspaceId, row.source_advance_id, database)
    if (!sourceAdvance) throw new AppError(404, "advance_not_found", "The source advance was not found.")
    if (next.renewedDealId) {
      if (next.renewedDealId === sourceAdvance.deal_id) throw new AppError(422, "invalid_renewal_lineage", "The renewed deal must be a new deal linked to the original advance.")
      await getDealForDocument(actor, next.renewedDealId)
    }
    if (input.requestDocumentation) {
      await requestRenewalDocuments(actor, {
        dealId: sourceAdvance.deal_id,
        sourceAdvanceId: sourceAdvance.id,
        idempotencyKey: `renewal-documents:${id}`,
      })
    }
    await database.prepare(`UPDATE mca_renewal_actions SET message_subject=?,message_body=?,state=?,renewed_deal_id=?,
      documentation_requested_at=?,updated_at=? WHERE workspace_id=? AND id=?`).run(
        next.subject, next.body, next.state, next.renewedDealId, next.documentationRequestedAt, timestamp, actor.workspaceId, id,
      )
    await recordAuditEvent({ context: actor, action: "renewal.action.updated", resourceType: "renewal_action", resourceId: id,
      correlationId: actor.correlationId, metadata: { state: next.state, sourceAdvanceId: row.source_advance_id }, executor: database })
    return action({ ...row, renewed_deal_id: next.renewedDealId, message_subject: next.subject, message_body: next.body,
      state: next.state as RenewalAction["state"], documentation_requested_at: next.documentationRequestedAt, updated_at: timestamp })
  })
}
