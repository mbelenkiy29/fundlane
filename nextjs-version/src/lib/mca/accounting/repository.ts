import "server-only"
import { membershipProfileNameSql } from "../membership-profile"

import { getDatabase, newId, nowIso, parseJson, type DbExecutor } from "../db"
import type { AccountingPayment, AccountingPaymentStatus, AccountingPaymentType, PaymentDistribution, SplitTemplateVersion } from "./contracts"
import type { BasisPointAllocation } from "./money"

type PaymentRow = {
  id: string; advance_id: string; type: AccountingPaymentType; origin: AccountingPayment["origin"]
  originator_membership_id: string | null; expected_amount_cents: number; received_amount_cents: number
  expected_at: string | null; received_at: string | null; status: AccountingPaymentStatus
  created_at: string; updated_at: string
}

function payment(row: PaymentRow): AccountingPayment {
  return {
    id: row.id, advanceId: row.advance_id, type: row.type, origin: row.origin,
    originatorMembershipId: row.originator_membership_id, expectedAmountCents: Number(row.expected_amount_cents),
    receivedAmountCents: Number(row.received_amount_cents), expectedAt: row.expected_at,
    receivedAt: row.received_at, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export async function listPaymentRows(workspaceId: string, filters: {
  status?: AccountingPaymentStatus; originatorMembershipId?: string; from?: string; to?: string
}): Promise<AccountingPayment[]> {
  const clauses = ["p.workspace_id = ?"]
  const values: unknown[] = [workspaceId]
  if (filters.status) { clauses.push("p.status = ?"); values.push(filters.status) }
  if (filters.originatorMembershipId) { clauses.push("p.originator_membership_id = ?"); values.push(filters.originatorMembershipId) }
  if (filters.from) { clauses.push("COALESCE(p.received_at, p.expected_at, p.created_at) >= ?"); values.push(filters.from) }
  if (filters.to) { clauses.push("COALESCE(p.received_at, p.expected_at, p.created_at) <= ?"); values.push(filters.to) }
  const rows = await getDatabase().prepare<PaymentRow>(`SELECT p.id, p.advance_id, p.type, p.origin, p.originator_membership_id,
    p.expected_amount_cents + COALESCE((SELECT sum(a.amount_cents) FROM mca_accounting_adjustments a
      WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)::int expected_amount_cents,
    p.received_amount_cents, p.expected_at, p.received_at, p.status, p.created_at, p.updated_at
    FROM mca_accounting_payments p WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(p.received_at, p.expected_at, p.created_at) DESC, p.id`).all(...values)
  return rows.map(payment)
}

export async function findPayment(workspaceId: string, id: string, database: DbExecutor = getDatabase()): Promise<AccountingPayment | undefined> {
  const row = await database.prepare<PaymentRow>(`SELECT p.id, p.advance_id, p.type, p.origin, p.originator_membership_id,
    p.expected_amount_cents + COALESCE((SELECT sum(a.amount_cents) FROM mca_accounting_adjustments a
      WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id),0)::int expected_amount_cents,
    p.received_amount_cents, p.expected_at, p.received_at, p.status, p.created_at, p.updated_at
    FROM mca_accounting_payments p WHERE p.workspace_id = ? AND p.id = ?`).get(workspaceId, id)
  return row ? payment(row) : undefined
}

export async function insertManualPayment(database: DbExecutor, input: {
  workspaceId: string; advanceId: string; type: AccountingPaymentType; expectedAmountCents: number
  expectedAt?: string; originatorMembershipId?: string; idempotencyKey: string; actorUserId: string | null
}): Promise<{ payment: AccountingPayment; created: boolean }> {
  const id = newId(); const timestamp = nowIso()
  const row = await database.prepare<PaymentRow>(`INSERT INTO mca_accounting_payments
    (id, workspace_id, advance_id, funding_event_id, type, origin, originator_membership_id,
     expected_amount_cents, received_amount_cents, expected_at, received_at, status,
     idempotency_key, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'manual', ?, ?, 0, ?, NULL, 'expected', ?, ?, ?, ?)
    ON CONFLICT (workspace_id, advance_id, type, idempotency_key) DO NOTHING
    RETURNING id, advance_id, type, origin, originator_membership_id, expected_amount_cents,
      received_amount_cents, expected_at, received_at, status, created_at, updated_at`).get(
      id, input.workspaceId, input.advanceId, input.type, input.originatorMembershipId ?? null,
      input.expectedAmountCents, input.expectedAt ?? null, input.idempotencyKey, input.actorUserId, timestamp, timestamp,
    )
  if (row) return { payment: payment(row), created: true }
  const replay = await database.prepare<PaymentRow>(`SELECT id, advance_id, type, origin, originator_membership_id,
    expected_amount_cents, received_amount_cents, expected_at, received_at, status, created_at, updated_at
    FROM mca_accounting_payments WHERE workspace_id = ? AND advance_id = ? AND type = ? AND idempotency_key = ?`)
    .get(input.workspaceId, input.advanceId, input.type, input.idempotencyKey)
  if (!replay) throw new Error("Payment conflicted without replayable row.")
  return { payment: payment(replay), created: false }
}

export async function updateReceived(database: DbExecutor, workspaceId: string, id: string, receivedAmountCents: number, receivedAt: string): Promise<AccountingPayment> {
  const current = await findPayment(workspaceId, id, database)
  if (!current) throw new Error("Payment not found.")
  const status: AccountingPaymentStatus = receivedAmountCents === 0 ? "expected"
    : receivedAmountCents < current.expectedAmountCents ? "partial" : "received"
  await database.prepare(`UPDATE mca_accounting_payments SET received_amount_cents = ?, received_at = ?, status = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(receivedAmountCents, receivedAt, status, nowIso(), workspaceId, id)
  const saved = await findPayment(workspaceId, id, database)
  if (!saved) throw new Error("Payment not found after update.")
  return saved
}

export async function insertAdjustment(database: DbExecutor, input: {
  workspaceId: string; paymentId: string; amountCents: number; reason: string; actorUserId: string | null; correlationId: string
}): Promise<{ id: string; created: boolean }> {
  const id = newId()
  const row = await database.prepare<{ id: string }>(`INSERT INTO mca_accounting_adjustments
    (id, workspace_id, payment_id, amount_cents, reason, actor_user_id, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, payment_id, correlation_id) DO NOTHING RETURNING id`).get(
      id, input.workspaceId, input.paymentId, input.amountCents, input.reason, input.actorUserId, input.correlationId, nowIso(),
    )
  return { id: row?.id ?? id, created: Boolean(row) }
}

export function findAdjustment(database: DbExecutor, workspaceId: string, paymentId: string, correlationId: string) {
  return database.prepare<{ id: string; amount_cents: number; reason: string }>(`SELECT id,amount_cents,reason FROM mca_accounting_adjustments
    WHERE workspace_id=? AND payment_id=? AND correlation_id=?`).get(workspaceId, paymentId, correlationId)
}

type TemplateRow = { template_id: string; name: string; version: number; allocation_json: string; created_at: string }

export async function listTemplateVersions(workspaceId: string): Promise<SplitTemplateVersion[]> {
  const rows = await getDatabase().prepare<TemplateRow>(`SELECT t.id template_id, t.name, v.version, v.allocation_json, v.created_at
    FROM mca_split_templates t JOIN mca_split_template_versions v ON v.workspace_id=t.workspace_id AND v.template_id=t.id
    WHERE t.workspace_id=? ORDER BY lower(t.name), v.version DESC`).all(workspaceId)
  return rows.map((row) => ({ templateId: row.template_id, name: row.name, version: row.version,
    allocations: parseJson<BasisPointAllocation[]>(row.allocation_json, []), createdAt: row.created_at }))
}

type DistributionRow = { id: string; payment_id: string; recipient_membership_id: string; recipient_name: string
  template_id: string | null; template_version: number | null; percentage_basis_points: number; amount_cents: number
  status: PaymentDistribution["status"]; expected_at: string | null; paid_at: string | null; snapshot_json: string }

export async function listDistributionRows(workspaceId: string, paymentId?: string): Promise<PaymentDistribution[]> {
  const rows = await getDatabase().prepare<DistributionRow>(`SELECT d.id,d.payment_id,d.recipient_membership_id,${membershipProfileNameSql} recipient_name,
    d.template_id,d.template_version,d.percentage_basis_points,d.amount_cents,d.status,d.expected_at,d.paid_at,d.snapshot_json
    FROM mca_payment_distributions d JOIN memberships m ON m.workspace_id=d.workspace_id AND m.id=d.recipient_membership_id
    JOIN users u ON u.id=m.user_id WHERE d.workspace_id=? AND (?::text IS NULL OR d.payment_id=?)
    ORDER BY d.expected_at,d.created_at,d.id`).all(workspaceId, paymentId ?? null, paymentId ?? null)
  return rows.map((row) => ({ id: row.id, paymentId: row.payment_id, recipientMembershipId: row.recipient_membership_id,
    recipientName: row.recipient_name, templateId: row.template_id, templateVersion: row.template_version,
    percentageBasisPoints: row.percentage_basis_points, amountCents: row.amount_cents, status: row.status,
    expectedAt: row.expected_at, paidAt: row.paid_at, snapshot: parseJson(row.snapshot_json, null) }))
}
