import "server-only"

import { AppError } from "../errors"
import { getDatabase, newId, nowIso, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "./schema"
import { getDealForDocument } from "./service"
import { generateExpectedInstallments } from "../advances/performance"
import { calendarDateInZone } from "./book-math"

type InstallmentRow = {
  id: string
  advance_id: string
  sequence: number
  occurrence_date: string
  amount_cents: number
}

type ReceiptRow = {
  id: string
  advance_id: string
  installment_id: string | null
  amount_cents: number
  received_at: string
  origin: "manual" | "csv" | "system"
  status: "received" | "void"
}

export async function persistInstallments(database: DbExecutor, input: {
  workspaceId: string
  advanceId: string
  fundedAt: string
  paymentCount: number | null
  paymentFrequency: string | null
  calendarConvention: string | null
  periodicPaymentCents: number | null
  paybackCents: number | null
  createdAt: string
}): Promise<number> {
  const expected = generateExpectedInstallments(input)
  let inserted = 0
  // Bound both the parameter count and remote database round trips.
  for (let offset = 0; offset < expected.length; offset += 250) {
    const batch = expected.slice(offset, offset + 250)
    const rows = await database.prepare<{ id: string }>(`INSERT INTO mca_merchant_installments
      (id, workspace_id, advance_id, sequence, occurrence_date, amount_cents, created_at)
      VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")}
      ON CONFLICT (workspace_id, advance_id, occurrence_date) DO NOTHING
      RETURNING id`).all(...batch.flatMap((item) => [newId(), input.workspaceId, input.advanceId, item.sequence, item.occurrenceDate, item.amountCents, input.createdAt]))
    inserted += rows.length
  }
  return inserted
}

export async function ensureWorkspaceInstallments(workspaceId: string, database: DbExecutor = getDatabase()): Promise<void> {
  const missing = await database.prepare<{
    id: string; funded_at: string; payment_count: number | null; payment_frequency: string | null
    calendar_convention: string | null; periodic_payment_cents: number | null; payback_cents: number | null
  }>(`SELECT a.id, a.funded_at, a.payment_count, a.payment_frequency, a.calendar_convention, a.periodic_payment_cents, a.payback_cents
    FROM mca_advances a
    WHERE a.workspace_id = ? AND a.reversed_at IS NULL
      AND a.payment_count IS NOT NULL AND a.periodic_payment_cents IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM mca_merchant_installments i WHERE i.workspace_id = a.workspace_id AND i.advance_id = a.id)`).all(workspaceId)
  const createdAt = nowIso()
  for (const advance of missing) {
    await persistInstallments(database, {
      workspaceId, advanceId: advance.id, fundedAt: advance.funded_at, paymentCount: advance.payment_count,
      paymentFrequency: advance.payment_frequency, calendarConvention: advance.calendar_convention,
      periodicPaymentCents: advance.periodic_payment_cents, paybackCents: advance.payback_cents, createdAt,
    })
  }
}

export async function listInstallments(workspaceId: string, advanceId?: string): Promise<InstallmentRow[]> {
  const clauses = ["workspace_id=?"]; const values: unknown[] = [workspaceId]
  if (advanceId) { clauses.push("advance_id=?"); values.push(advanceId) }
  return getDatabase().prepare<InstallmentRow>(`SELECT id, advance_id, sequence, occurrence_date, amount_cents
    FROM mca_merchant_installments WHERE ${clauses.join(" AND ")} ORDER BY occurrence_date, sequence`).all(...values)
}

export async function listReceipts(workspaceId: string, advanceId?: string): Promise<ReceiptRow[]> {
  const clauses = ["workspace_id=?"]; const values: unknown[] = [workspaceId]
  if (advanceId) { clauses.push("advance_id=?"); values.push(advanceId) }
  return getDatabase().prepare<ReceiptRow>(`SELECT id, advance_id, installment_id, amount_cents, received_at, origin, status
    FROM mca_merchant_receipts WHERE ${clauses.join(" AND ")} ORDER BY received_at, id`).all(...values)
}

function canRecordReceipt(actor: DealActor): boolean {
  return actor.source === "user" && ["admin", "super_admin", "manager"].includes(actor.role ?? "")
}

export async function recordReceipt(actor: DealActor, advanceId: string, input: {
  amountCents: number
  receivedAt: string
  origin?: "manual" | "csv" | "system"
  idempotencyKey: string
}): Promise<ReceiptRow> {
  if (!canRecordReceipt(actor)) throw new AppError(403, "permission_denied", "Only managers and administrators can record merchant receipts.")
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new AppError(422, "validation_failed", "Receipt amount must be positive integer cents.", { amountCents: ["Enter a positive whole number of cents."] })
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(input.receivedAt) || Number.isNaN(Date.parse(input.receivedAt))) {
    throw new AppError(422, "validation_failed", "Receipt date is invalid.", { receivedAt: ["Use a valid ISO date."] })
  }
  const key = input.idempotencyKey.trim()
  if (!key || key.length > 160) throw new AppError(422, "validation_failed", "Idempotency key is required.", { idempotencyKey: ["Provide a stable key."] })
  const origin = input.origin ?? "manual"
  return withImmediateTransaction(async (database) => {
    const advance = await database.prepare<{ deal_id: string }>("SELECT deal_id FROM mca_advances WHERE workspace_id=? AND id=? AND reversed_at IS NULL").get(actor.workspaceId, advanceId)
    if (!advance) throw new AppError(404, "advance_not_found", "The requested advance was not found.")
    await getDealForDocument(actor, advance.deal_id)
    const receivedDate = calendarDateInZone(input.receivedAt, "UTC")
    const installment = await database.prepare<{ id: string }>(`SELECT id FROM mca_merchant_installments
      WHERE workspace_id=? AND advance_id=? AND occurrence_date=?`).get(actor.workspaceId, advanceId, receivedDate)
    const existing = await database.prepare<ReceiptRow>(`SELECT id, advance_id, installment_id, amount_cents, received_at, origin, status
      FROM mca_merchant_receipts WHERE workspace_id=? AND advance_id=? AND idempotency_key=?`).get(actor.workspaceId, advanceId, key)
    if (existing) return existing
    const id = newId(); const createdAt = nowIso()
    const row = await database.prepare<ReceiptRow>(`INSERT INTO mca_merchant_receipts
      (id, workspace_id, advance_id, installment_id, amount_cents, received_at, origin, status, idempotency_key, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)
      RETURNING id, advance_id, installment_id, amount_cents, received_at, origin, status`).get(
      id, actor.workspaceId, advanceId, installment?.id ?? null, input.amountCents, input.receivedAt, origin, key, actor.userId, createdAt,
    )
    if (!row) throw new Error("Receipt was not persisted.")
    return row
  })
}

export async function runMissedPaymentAlerts(actor: DealActor, asOf = nowIso()): Promise<{ created: number }> {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can run missed-payment alerts.")
  }
  await ensureWorkspaceInstallments(actor.workspaceId)
  const asOfDate = calendarDateInZone(asOf, "UTC")
  return withImmediateTransaction(async (database) => {
    const overdue = await database.prepare<{ id: string; advance_id: string; occurrence_date: string }>(`SELECT i.id, i.advance_id, i.occurrence_date
      FROM mca_merchant_installments i
      JOIN mca_advances a ON a.workspace_id=i.workspace_id AND a.id=i.advance_id AND a.reversed_at IS NULL
      WHERE i.workspace_id=? AND i.occurrence_date<=?
        AND NOT EXISTS (
          SELECT 1 FROM mca_merchant_receipts r
          WHERE r.workspace_id=i.workspace_id AND r.advance_id=i.advance_id AND r.status='received'
            AND (r.installment_id=i.id OR left(r.received_at, 10)=i.occurrence_date)
        )`).all(actor.workspaceId, asOfDate)
    let created = 0
    const createdAt = nowIso()
    for (const item of overdue) {
      const row = await database.prepare<{ id: string }>(`INSERT INTO mca_servicing_alerts
        (id, workspace_id, advance_id, installment_id, kind, occurrence_date, created_at)
        VALUES (?, ?, ?, ?, 'missed_payment', ?, ?)
        ON CONFLICT (workspace_id, advance_id, installment_id, kind) DO NOTHING
        RETURNING id`).get(newId(), actor.workspaceId, item.advance_id, item.id, item.occurrence_date, createdAt)
      if (row) created += 1
    }
    return { created }
  })
}

export async function unreadAlertCount(workspaceId: string): Promise<number> {
  const row = await getDatabase().prepare<{ count: number }>(`SELECT count(*)::int AS count FROM mca_servicing_alerts WHERE workspace_id=? AND read_at IS NULL`).get(workspaceId)
  return row?.count ?? 0
}
