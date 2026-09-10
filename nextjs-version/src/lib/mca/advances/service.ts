import "server-only"

import { AppError } from "../errors"
import { recordAuditEvent, withImmediateTransaction } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import type { AdvancePerformanceStatus, AdvanceSummary } from "../accounting/contracts"
import { estimateScheduledPaidIn } from "./performance"
import { findAdvanceRow, insertStatusHistory, latestPerformanceStatuses, listAdvanceRows, statusHistories, type AdvanceRow, type StatusHistoryRow } from "./repository"

async function assertVisible(actor: DealActor, row: AdvanceRow | undefined): Promise<AdvanceRow> {
  if (!row) throw new AppError(404, "advance_not_found", "The requested advance was not found.")
  await getDealForDocument(actor, row.deal_id)
  return row
}

function summary(row: AdvanceRow, status: AdvancePerformanceStatus, asOf: string, history: StatusHistoryRow[] = []): AdvanceSummary {
  const estimate = estimateScheduledPaidIn({
    fundedAt: row.funded_at, asOf, paybackCents: row.payback_cents,
    periodicPaymentCents: row.periodic_payment_cents, paymentCount: row.payment_count,
    paymentFrequency: row.payment_frequency, calendarConvention: row.calendar_convention,
  })
  return {
    id: row.id, dealId: row.deal_id, offerId: row.offer_id, fundedAt: row.funded_at,
    businessName: row.business_name, funderName: row.funder_name,
    assignedTeam: row.assigned_team ? row.assigned_team.split(", ") : [], termMonths: row.term_months,
    principalCents: row.principal_cents, paybackCents: row.payback_cents,
    periodicPaymentCents: row.periodic_payment_cents, paymentCount: row.payment_count,
    paymentFrequency: row.payment_frequency, calendarConvention: row.calendar_convention,
    status: row.status, performanceStatus: status,
    scheduledPaidInBasisPoints: estimate.paidInBasisPoints, scheduledPaidInCents: estimate.paidInCents,
    estimateAsOf: asOf, estimateLabel: estimate.label,
    statusHistory: history.map((item) => ({ id: item.id, status: item.status, reason: item.reason, effectiveAt: item.effective_at })),
  }
}

export async function listAdvances(actor: DealActor, asOf = new Date().toISOString()): Promise<AdvanceSummary[]> {
  const [rows, statuses, histories] = await Promise.all([listAdvanceRows(actor.workspaceId), latestPerformanceStatuses(actor.workspaceId), statusHistories(actor.workspaceId)])
  const visible = await Promise.all(rows.map(async (row) => {
    try { await assertVisible(actor, row); return summary(row, statuses.get(row.id) ?? "on_track", asOf, histories.get(row.id)) }
    catch (error) { if (error instanceof AppError && error.status === 404) return null; throw error }
  }))
  return visible.filter((item): item is AdvanceSummary => item !== null)
}

export async function getAdvance(actor: DealActor, id: string, asOf = new Date().toISOString()): Promise<AdvanceSummary> {
  const row = await assertVisible(actor, await findAdvanceRow(actor.workspaceId, id))
  const [statuses, histories] = await Promise.all([latestPerformanceStatuses(actor.workspaceId), statusHistories(actor.workspaceId)])
  return summary(row, statuses.get(row.id) ?? "on_track", asOf, histories.get(row.id))
}

export async function recordAdvanceStatus(actor: DealActor, id: string, input: {
  status: AdvancePerformanceStatus
  reason?: string
  effectiveAt?: string
}): Promise<AdvanceSummary> {
  if (!actor.role || !["admin", "super_admin"].includes(actor.role)) throw new AppError(403, "permission_denied", "Only workspace administrators can correct advance performance.")
  const reason = input.reason?.trim()
  if (!reason) throw new AppError(400, "validation_failed", "Explain the performance correction.", { reason: ["A correction reason is required."] })
  return withImmediateTransaction(async (database) => {
    const row = await assertVisible(actor, await findAdvanceRow(actor.workspaceId, id, database))
    const inserted = await insertStatusHistory(database, {
      workspaceId: actor.workspaceId, advanceId: id, status: input.status,
      reason, effectiveAt: input.effectiveAt ?? new Date().toISOString(),
      actorUserId: actor.userId, correlationId: actor.correlationId,
    })
    await recordAuditEvent({ context: actor, action: "advance.performance.recorded", resourceType: "advance", resourceId: id,
      correlationId: actor.correlationId, metadata: { status: input.status, historyId: inserted.id }, executor: database })
    return summary(row, input.status, new Date().toISOString())
  })
}
