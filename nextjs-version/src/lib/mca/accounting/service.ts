import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import { calculateSplitSnapshot } from "./calculations"
import type { AccountingPaymentStatus, AccountingPaymentType, AccountingTotals, SplitTemplateVersion } from "./contracts"
import { assertCents, type BasisPointAllocation } from "./money"
import { findAdjustment, findPayment, insertAdjustment, insertManualPayment, listDistributionRows, listPaymentRows, listTemplateVersions, updateReceived } from "./repository"

async function lockWritableAdvance(database: DbExecutor, workspaceId: string, advanceId: string) {
  const advance = await database.prepare<{ status: string }>(`SELECT status FROM mca_advances
    WHERE workspace_id=? AND id=? FOR UPDATE`).get(workspaceId, advanceId)
  if (!advance) throw new AppError(404, "advance_not_found", "The requested advance was not found.")
  if (advance.status === "reversed") throw new AppError(409, "advance_reversed", "Accounting history for a reversed advance cannot be changed.")
}

async function lockPaymentTree(database: DbExecutor, workspaceId: string, paymentId: string) {
  const reference = await database.prepare<{ advance_id: string }>(`SELECT advance_id FROM mca_accounting_payments
    WHERE workspace_id=? AND id=?`).get(workspaceId, paymentId)
  if (!reference) throw new AppError(404, "payment_not_found", "The requested payment was not found.")
  await lockWritableAdvance(database, workspaceId, reference.advance_id)
  const payment = await database.prepare<{ id: string; status: string }>(`SELECT id,status FROM mca_accounting_payments
    WHERE workspace_id=? AND id=? FOR UPDATE`).get(workspaceId, paymentId)
  if (!payment) throw new AppError(404, "payment_not_found", "The requested payment was not found.")
  if (payment.status === "void") throw new AppError(409, "payment_void", "A void payment cannot be changed.")
}

export async function listPayments(actor: DealActor, filters: {
  status?: AccountingPaymentStatus; originatorMembershipId?: string; from?: string; to?: string
}, includeTotals = false) {
  const payments = await listPaymentRows(actor.workspaceId, filters)
  const totals = payments.reduce<AccountingTotals>((sum, item) => ({
    expectedCents: sum.expectedCents + (item.status === "void" ? 0 : item.expectedAmountCents),
    collectedCents: sum.collectedCents + (item.status === "void" ? 0 : item.receivedAmountCents),
    outstandingCents: sum.outstandingCents + (item.status === "void" ? 0 : Math.max(0, item.expectedAmountCents - item.receivedAmountCents)),
  }), { expectedCents: 0, collectedCents: 0, outstandingCents: 0 })
  return { payments, ...(includeTotals ? { totals } : {}) }
}

export async function addManualPayment(actor: DealActor, input: {
  advanceId: string; type: AccountingPaymentType; expectedAmountCents: number; expectedAt?: string
  originatorMembershipId?: string; idempotencyKey: string
}) {
  assertCents(input.expectedAmountCents, "expectedAmountCents")
  if (!input.idempotencyKey?.trim()) throw new AppError(400, "validation_failed", "An idempotency key is required.", { idempotencyKey: ["Required"] })
  return withImmediateTransaction(async (database) => {
    await lockWritableAdvance(database, actor.workspaceId, input.advanceId)
    if (input.originatorMembershipId) {
      const recipient = await database.prepare(`SELECT id FROM memberships WHERE workspace_id=? AND id=? AND status='active'`).get(actor.workspaceId, input.originatorMembershipId)
      if (!recipient) throw new AppError(422, "invalid_originator", "Choose an active workspace member.")
    }
    const result = await insertManualPayment(database, { ...input, workspaceId: actor.workspaceId, actorUserId: actor.userId })
    await recordAuditEvent({ context: actor, action: "accounting.payment.created", resourceType: "accounting_payment",
      resourceId: result.payment.id, correlationId: actor.correlationId, metadata: { type: input.type, replayed: !result.created }, executor: database })
    return result
  })
}

export async function reconcilePayment(actor: DealActor, id: string, input: { receivedAmountCents: number; receivedAt: string }) {
  assertCents(input.receivedAmountCents, "receivedAmountCents")
  return withImmediateTransaction(async (database) => {
    await lockPaymentTree(database, actor.workspaceId, id)
    const saved = await updateReceived(database, actor.workspaceId, id, input.receivedAmountCents, input.receivedAt)
    await recordAuditEvent({ context: actor, action: "accounting.payment.reconciled", resourceType: "accounting_payment",
      resourceId: id, correlationId: actor.correlationId, metadata: { receivedAmountCents: input.receivedAmountCents }, executor: database })
    return saved
  })
}

export async function adjustPayment(actor: DealActor, id: string, input: { amountCents: number; reason: string; idempotencyKey: string }) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) throw new AppError(400, "validation_failed", "Adjustment must be a non-zero integer number of cents.")
  if (!input.reason?.trim()) throw new AppError(400, "validation_failed", "An adjustment reason is required.")
  return withImmediateTransaction(async (database) => {
    await lockPaymentTree(database, actor.workspaceId, id)
    const payment = await findPayment(actor.workspaceId, id, database)
    if (!payment) throw new AppError(404, "payment_not_found", "The requested payment was not found.")
    const existing = await findAdjustment(database, actor.workspaceId, id, input.idempotencyKey)
    if (existing) {
      if (existing.amount_cents !== input.amountCents || existing.reason !== input.reason.trim()) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different adjustment.")
      return { id: existing.id, created: false }
    }
    if (payment.expectedAmountCents + input.amountCents < 0) throw new AppError(422, "invalid_adjustment", "An adjustment cannot make expected revenue negative.")
    const result = await insertAdjustment(database, { workspaceId: actor.workspaceId, paymentId: id,
      amountCents: input.amountCents, reason: input.reason.trim(), actorUserId: actor.userId, correlationId: input.idempotencyKey })
    const adjusted = payment.expectedAmountCents + input.amountCents
    const status: AccountingPaymentStatus = payment.receivedAmountCents === 0 ? "expected"
      : payment.receivedAmountCents < adjusted ? "partial" : "received"
    await database.prepare(`UPDATE mca_accounting_payments SET status=?,updated_at=? WHERE workspace_id=? AND id=?`)
      .run(status, nowIso(), actor.workspaceId, id)
    await recordAuditEvent({ context: actor, action: "accounting.payment.adjusted", resourceType: "accounting_payment",
      resourceId: id, correlationId: actor.correlationId, metadata: { adjustmentId: result.id }, executor: database })
    return result
  })
}

export function listSplitTemplates(actor: DealActor): Promise<SplitTemplateVersion[]> { return listTemplateVersions(actor.workspaceId) }

export async function saveSplitTemplate(actor: DealActor, input: { templateId?: string; name: string; allocations: BasisPointAllocation[] }): Promise<SplitTemplateVersion> {
  calculateSplitSnapshot(0, input.allocations)
  if (!input.name?.trim()) throw new AppError(400, "validation_failed", "Template name is required.")
  return withImmediateTransaction(async (database) => {
    const recipientIds = input.allocations.map((item) => item.recipientMembershipId)
    const recipients = await database.prepare<{ id: string }>(`SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND id=ANY(?::text[])`)
      .all(actor.workspaceId, recipientIds)
    if (recipients.length !== new Set(recipientIds).size) throw new AppError(422, "invalid_recipient", "Every split recipient must be an active workspace member.")
    const timestamp = nowIso(); const templateId = input.templateId ?? newId()
    const current = await database.prepare<{ active_version: number; name: string }>(`SELECT active_version, name FROM mca_split_templates
      WHERE workspace_id=? AND id=? FOR UPDATE`).get(actor.workspaceId, templateId)
    const version = (current?.active_version ?? 0) + 1
    if (current) await database.prepare(`UPDATE mca_split_templates SET name=?, active_version=?, updated_at=? WHERE workspace_id=? AND id=?`)
      .run(input.name.trim(), version, timestamp, actor.workspaceId, templateId)
    else await database.prepare(`INSERT INTO mca_split_templates (id,workspace_id,name,active_version,created_by_user_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(templateId, actor.workspaceId, input.name.trim(), version, actor.userId, timestamp, timestamp)
    await database.prepare(`INSERT INTO mca_split_template_versions
      (id,workspace_id,template_id,version,allocation_json,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(newId(), actor.workspaceId, templateId, version, JSON.stringify(input.allocations), actor.userId, timestamp)
    await recordAuditEvent({ context: actor, action: "accounting.split_template.versioned", resourceType: "split_template",
      resourceId: templateId, correlationId: actor.correlationId, metadata: { version }, executor: database })
    return { templateId, name: input.name.trim(), version, allocations: input.allocations, createdAt: timestamp }
  })
}

export async function applySplitTemplate(actor: DealActor, input: { paymentId: string; templateId: string; version: number; idempotencyKey: string }) {
  return withImmediateTransaction(async (database) => {
    await lockPaymentTree(database, actor.workspaceId, input.paymentId)
    const payment = await findPayment(actor.workspaceId, input.paymentId, database)
    if (!payment) throw new AppError(404, "payment_not_found", "The requested payment was not found.")
    const row = await database.prepare<{ allocation_json: string }>(`SELECT allocation_json FROM mca_split_template_versions
      WHERE workspace_id=? AND template_id=? AND version=?`).get(actor.workspaceId, input.templateId, input.version)
    if (!row) throw new AppError(404, "split_template_not_found", "The requested split template version was not found.")
    const allocations = JSON.parse(row.allocation_json) as BasisPointAllocation[]
    const snapshot = calculateSplitSnapshot(payment.expectedAmountCents, allocations)
    const recipientIds = allocations.map((item) => item.recipientMembershipId)
    const recipients = await database.prepare<{ id: string }>(`SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND id=ANY(?::text[])`)
      .all(actor.workspaceId, recipientIds)
    if (recipients.length !== new Set(recipientIds).size) throw new AppError(422, "invalid_recipient", "Every split recipient must be an active workspace member.")
    const existing = await database.prepare<{ count: number; keyed_count: number }>(`SELECT count(*)::int count,
      count(*) FILTER (WHERE idempotency_key=?)::int keyed_count FROM mca_payment_distributions
      WHERE workspace_id=? AND payment_id=? AND status<>'void'`).get(input.idempotencyKey, actor.workspaceId, input.paymentId)
    if ((existing?.count ?? 0) > 0 && existing?.count !== existing?.keyed_count) {
      throw new AppError(409, "payment_already_allocated", "This payment already has active distributions. Void unpaid distributions before applying a replacement.")
    }
    for (const allocation of snapshot.allocations) {
      await database.prepare(`INSERT INTO mca_payment_distributions
        (id,workspace_id,payment_id,recipient_membership_id,template_id,template_version,percentage_basis_points,
         amount_cents,status,expected_at,paid_at,snapshot_json,idempotency_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'expected',?,NULL,?,?,?,?)
        ON CONFLICT (workspace_id,payment_id,recipient_membership_id,idempotency_key) DO NOTHING`).run(
          newId(), actor.workspaceId, input.paymentId, allocation.recipientMembershipId, input.templateId, input.version,
          allocation.percentageBasisPoints, allocation.amountCents, payment.expectedAt, JSON.stringify(snapshot),
          input.idempotencyKey, nowIso(), nowIso(),
        )
    }
    await recordAuditEvent({ context: actor, action: "accounting.distributions.created", resourceType: "accounting_payment",
      resourceId: input.paymentId, correlationId: actor.correlationId, metadata: { templateId: input.templateId, version: input.version }, executor: database })
    return snapshot
  })
}

export function listDistributions(actor: DealActor, paymentId?: string) { return listDistributionRows(actor.workspaceId, paymentId) }

export async function setDistributionStatus(actor: DealActor, id: string, status: "paid" | "void", paidAt?: string) {
  return withImmediateTransaction(async (database) => {
    const reference = await database.prepare<{ payment_id: string }>(`SELECT payment_id FROM mca_payment_distributions
      WHERE workspace_id=? AND id=?`).get(actor.workspaceId, id)
    if (!reference) throw new AppError(404, "distribution_not_found", "The requested distribution was not found.")
    await lockPaymentTree(database, actor.workspaceId, reference.payment_id)
    const row = await database.prepare<{ id: string; status: string }>(`SELECT id,status FROM mca_payment_distributions
      WHERE workspace_id=? AND id=? FOR UPDATE`).get(actor.workspaceId, id)
    if (!row) throw new AppError(404, "distribution_not_found", "The requested distribution was not found.")
    if (row.status === "paid" && status === "void") throw new AppError(409, "paid_distribution_immutable", "Paid distribution history cannot be voided.")
    if (row.status === "paid" && status === "paid") return (await listDistributionRows(actor.workspaceId)).find((item) => item.id === id)
    if (row.status === "void" && status === "paid") throw new AppError(409, "void_distribution_immutable", "A void distribution cannot be marked paid.")
    if (row.status === "void" && status === "void") return (await listDistributionRows(actor.workspaceId)).find((item) => item.id === id)
    const timestamp = nowIso()
    await database.prepare(`UPDATE mca_payment_distributions SET status=?,paid_at=?,updated_at=? WHERE workspace_id=? AND id=?`)
      .run(status, status === "paid" ? (paidAt ?? timestamp) : null, timestamp, actor.workspaceId, id)
    await recordAuditEvent({ context: actor, action: `accounting.distribution.${status}`, resourceType: "payment_distribution",
      resourceId: id, correlationId: actor.correlationId, executor: database })
    return (await listDistributionRows(actor.workspaceId)).find((item) => item.id === id)
  })
}
