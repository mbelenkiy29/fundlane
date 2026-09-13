import { check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const mca_merchant_installments = pgTable("mca_merchant_installments", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  advance_id: text().notNull(),
  sequence: integer().notNull(),
  occurrence_date: text().notNull(),
  amount_cents: integer().notNull(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_merchant_installments_occurrence_key").on(table.workspace_id, table.advance_id, table.occurrence_date),
  unique("mca_merchant_installments_sequence_key").on(table.workspace_id, table.advance_id, table.sequence),
  index("mca_merchant_installments_due_idx").on(table.workspace_id, table.occurrence_date, table.advance_id),
  check("mca_merchant_installments_sequence_check", sql`${table.sequence} > 0`),
  check("mca_merchant_installments_amount_check", sql`${table.amount_cents} > 0`),
])

export const mca_merchant_receipts = pgTable("mca_merchant_receipts", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  advance_id: text().notNull(),
  installment_id: text(),
  amount_cents: integer().notNull(),
  received_at: text().notNull(),
  origin: text().notNull(),
  status: text().notNull(),
  idempotency_key: text().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_merchant_receipts_idempotency_key").on(table.workspace_id, table.advance_id, table.idempotency_key),
  index("mca_merchant_receipts_advance_idx").on(table.workspace_id, table.advance_id, table.received_at),
  check("mca_merchant_receipts_amount_check", sql`${table.amount_cents} > 0`),
  check("mca_merchant_receipts_origin_check", sql`${table.origin} in ('manual','csv','system')`),
  check("mca_merchant_receipts_status_check", sql`${table.status} in ('received','void')`),
])

export const mca_servicing_alerts = pgTable("mca_servicing_alerts", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  advance_id: text().notNull(),
  installment_id: text().notNull(),
  kind: text().notNull(),
  occurrence_date: text().notNull(),
  read_at: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_servicing_alerts_identity_key").on(table.workspace_id, table.advance_id, table.installment_id, table.kind),
  check("mca_servicing_alerts_kind_check", sql`${table.kind} in ('missed_payment')`),
])
