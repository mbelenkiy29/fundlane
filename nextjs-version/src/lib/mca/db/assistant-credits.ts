import { sql } from "drizzle-orm"
import {
  pgTable,
  text,
  integer,
  bigserial,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core"
import { mcaAssistantConversations, mcaAssistantRuns } from "./schema"

export const assistantReferences = pgTable(
  "mca_assistant_references",
  {
    id: text().primaryKey(),
    conversation_id: text()
      .notNull()
      .references(() => mcaAssistantConversations.id, { onDelete: "cascade" }),
    deal_id: text().notNull(),
  },
  (t) => [
    uniqueIndex("assistant_reference_once").on(t.conversation_id, t.deal_id),
  ]
)
export const creditAccounts = pgTable(
  "mca_credit_accounts",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    user_id: text().notNull(),
    purchased_balance: integer().notNull().default(0),
    purchased_reserved: integer().notNull().default(0),
    alert_episode: integer().notNull().default(0),
    low_sent: integer().notNull().default(0),
    exhausted_sent: integer().notNull().default(0),
    alert_dirty: integer().notNull().default(1),
    created_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("credit_account_owner").on(t.workspace_id, t.user_id),
    check("credit_reserved_nonnegative", sql`${t.purchased_reserved} >= 0`),
  ]
)
export const creditMonths = pgTable(
  "mca_credit_months",
  {
    id: text().primaryKey(),
    account_id: text()
      .notNull()
      .references(() => creditAccounts.id),
    month: text().notNull(),
    allowance: integer().notNull(),
    effective_allowance: integer().notNull(),
    remaining: integer().notNull(),
    reserved: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex("credit_month_once").on(t.account_id, t.month),
    check(
      "credit_month_balances",
      sql`${t.remaining} >= 0 AND ${t.reserved} >= 0 AND ${t.reserved} <= ${t.remaining}`
    ),
  ]
)
export const creditReservations = pgTable("mca_credit_reservations", {
  run_id: text()
    .primaryKey()
    .references(() => mcaAssistantRuns.id),
  account_id: text()
    .notNull()
    .references(() => creditAccounts.id),
  month: text().notNull(),
  source: text().notNull(),
  state: text().notNull(),
  created_at: text().notNull(),
})
export const creditLedger = pgTable(
  "mca_credit_ledger",
  {
    id: text().primaryKey(),
    account_id: text()
      .notNull()
      .references(() => creditAccounts.id),
    event_key: text().notNull(),
    kind: text().notNull(),
    amount: integer().notNull(),
    source: text().notNull(),
    created_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("credit_event_once").on(t.event_key),
    index("credit_ledger_account").on(t.account_id, t.created_at),
  ]
)
export const creditPurchases = pgTable(
  "mca_credit_purchases",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    buyer_user_id: text().notNull(),
    recipient_user_id: text().notNull(),
    request_id: text().notNull(),
    session_id: text(),
    payment_intent_id: text(),
    credits: integer().notNull().default(100),
    amount: integer().notNull().default(1000),
    currency: text().notNull().default("usd"),
    state: text().notNull(),
    granted: integer().notNull().default(0),
    reversed: integer().notNull().default(0),
    created_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("credit_purchase_request").on(t.workspace_id, t.request_id),
    uniqueIndex("credit_purchase_session").on(t.session_id),
  ]
)
export const creditAlertSettings = pgTable("mca_credit_alert_settings", {
  workspace_id: text().primaryKey(),
  mode: text().notNull().default("percent"),
  threshold: integer().notNull().default(20),
  updated_at: text().notNull(),
})
export const creditNotifications = pgTable(
  "mca_credit_notifications",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    account_id: text()
      .notNull()
      .references(() => creditAccounts.id),
    recipient_user_id: text().notNull(),
    episode: integer().notNull(),
    kind: text().notNull(),
    payload_cipher: text().notNull(),
    created_at: text().notNull(),
    read_at: text(),
  },
  (t) => [
    uniqueIndex("credit_alert_once").on(
      t.account_id,
      t.recipient_user_id,
      t.episode,
      t.kind
    ),
    index("credit_alert_inbox").on(
      t.workspace_id,
      t.recipient_user_id,
      t.created_at
    ),
  ]
)
export const creditAlertEmails = pgTable("mca_credit_alert_emails", {
  id: text()
    .primaryKey()
    .references(() => creditNotifications.id),
  state: text().notNull().default("queued"),
  attempts: integer().notNull().default(0),
  next_attempt_at: text().notNull(),
  updated_at: text().notNull(),
  error_code: text(),
})

// An ordered transactional outbox preserves transitions even when delivery is delayed.
export const creditBalanceEvents = pgTable(
  "mca_credit_balance_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    account_id: text()
      .notNull()
      .references(() => creditAccounts.id),
    month: text().notNull(),
    allowance: integer().notNull(),
    included: integer().notNull(),
    purchased: integer().notNull(),
    threshold_mode: text().notNull(),
    threshold_value: integer().notNull(),
    created_at: text().notNull(),
    processed_at: text(),
  },
  (t) => [
    index("credit_balance_events_pending")
      .on(t.account_id, t.id)
      .where(sql`${t.processed_at} IS NULL`),
  ]
)
