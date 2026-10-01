import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core"
import { workspaces } from "./schema"
import { mca_sms_messages } from "./milestone05-sms"

export const smsCreditAccounts = pgTable("sms_credit_accounts", {
  workspace_id: text().primaryKey().references(() => workspaces.id),
  balance_segments: integer().notNull().default(0),
  reserved_segments: integer().notNull().default(0),
  updated_at: text().notNull(),
}, t => [check("sms_credit_account_bounds", sql`${t.balance_segments} >= 0 AND ${t.reserved_segments} >= 0 AND ${t.reserved_segments} <= ${t.balance_segments}`)])

export const smsCreditReservations = pgTable("sms_credit_reservations", {
  id: text().primaryKey(),
  workspace_id: text().notNull().references(() => smsCreditAccounts.workspace_id),
  message_id: text().notNull().unique("sms_credit_reservations_message_id_key"),
  segments: integer().notNull(),
  payload_hash: text().notNull(),
  state: text().notNull(),
  charge_segments: integer(),
  created_at: text().notNull(),
}, t => [
  unique("sms_credit_reservations_workspace_id_id_key").on(t.workspace_id, t.id),
  foreignKey({ name: "sms_credit_reservations_workspace_id_message_id_fkey", columns: [t.workspace_id, t.message_id], foreignColumns: [mca_sms_messages.workspace_id, mca_sms_messages.id] }),
  check("sms_credit_reservations_segments_check", sql`${t.segments} > 0`),
  check("sms_credit_reservations_payload_hash_check", sql`length(${t.payload_hash}) BETWEEN 1 AND 256`),
  check("sms_credit_reservations_state_check", sql`${t.state} IN ('reserved','settled','released')`),
  check("sms_credit_reservation_charge", sql`(${t.state} = 'settled' AND ${t.charge_segments} IS NOT NULL AND ${t.charge_segments} BETWEEN 0 AND ${t.segments}) OR (${t.state} <> 'settled' AND ${t.charge_segments} IS NULL)`),
])

export const smsCreditLedger = pgTable("sms_credit_ledger", {
  id: text().primaryKey(),
  workspace_id: text().notNull().references(() => smsCreditAccounts.workspace_id),
  reservation_id: text(),
  purchase_id: text().unique("sms_credit_ledger_purchase_id_key"),
  provider_payment_id: text().unique("sms_credit_ledger_provider_payment_id_key"),
  event_key: text().unique("sms_credit_ledger_event_key_key"),
  kind: text().notNull(),
  segments: integer().notNull(),
  balance_delta: integer().notNull(),
  reserved_delta: integer().notNull(),
  created_at: text().notNull(),
}, t => [
  foreignKey({ name: "sms_credit_ledger_workspace_id_reservation_id_fkey", columns: [t.workspace_id, t.reservation_id], foreignColumns: [smsCreditReservations.workspace_id, smsCreditReservations.id] }),
  index("sms_credit_ledger_workspace").on(t.workspace_id, t.created_at),
  uniqueIndex("sms_credit_reserve_once").on(t.reservation_id).where(sql`${t.kind}='reserve'`),
  check("sms_credit_ledger_kind_check", sql`${t.kind} IN ('grant','reserve','settle','release')`),
  check("sms_credit_ledger_segments_check", sql`${t.segments} >= 0`),
  check("sms_credit_ledger_shape", sql`
    (${t.kind}='grant' AND ${t.purchase_id} IS NOT NULL AND ${t.provider_payment_id} IS NOT NULL AND ${t.reservation_id} IS NULL AND ${t.event_key} IS NULL AND ${t.segments} > 0 AND ${t.balance_delta}=${t.segments} AND ${t.reserved_delta}=0) OR
    (${t.kind}='reserve' AND ${t.purchase_id} IS NULL AND ${t.provider_payment_id} IS NULL AND ${t.reservation_id} IS NOT NULL AND ${t.event_key} IS NULL AND ${t.segments} > 0 AND ${t.balance_delta}=0 AND ${t.reserved_delta}=${t.segments}) OR
    (${t.kind}='settle' AND ${t.purchase_id} IS NULL AND ${t.provider_payment_id} IS NULL AND ${t.reservation_id} IS NOT NULL AND ${t.event_key} IS NOT NULL AND ${t.balance_delta} IN (0,-${t.segments}) AND ${t.reserved_delta} <= 0) OR
    (${t.kind}='release' AND ${t.purchase_id} IS NULL AND ${t.provider_payment_id} IS NULL AND ${t.reservation_id} IS NOT NULL AND ${t.event_key} IS NOT NULL AND ${t.segments}=0 AND ${t.balance_delta}=0 AND ${t.reserved_delta} <= 0)
  `),
])
