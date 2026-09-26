import {
  pgTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { workspaces, users } from "./schema"

export const smsCompanies = pgTable(
  "sms_companies",
  {
    workspace_id: text()
      .primaryKey()
      .references(() => workspaces.id),
    owner_user_id: text()
      .notNull()
      .references(() => users.id),
    email_verified_at: text(),
    profile_cipher: text(),
    review_state: text().notNull().default("draft"),
    review_note: text(),
    reviewed_by: text(),
    registration_state: text().notNull().default("not_started"),
    provider_cipher: text(),
    opt_out_ready: integer().notNull().default(0),
    suspended: integer().notNull().default(0),
    number_limit: integer().notNull().default(0),
    monthly_limit_cents: integer().notNull().default(0),
    registration_limit_cents: integer().notNull().default(0),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    refresh_attempted_at: text(),
  },
  (t) => [
    index("sms_companies_refresh_cursor_idx")
      .on(t.refresh_attempted_at.asc().nullsFirst(), t.workspace_id)
      .where(sql`${t.provider_cipher} IS NOT NULL`),
    check(
      "sms_company_limits",
      sql`${t.number_limit} >= 0 AND ${t.monthly_limit_cents} >= 0 AND ${t.registration_limit_cents} >= 0`
    ),
  ]
)
export const smsEmailTokens = pgTable("sms_email_tokens", {
  token_hash: text().primaryKey(),
  workspace_id: text()
    .notNull()
    .references(() => workspaces.id),
  user_id: text()
    .notNull()
    .references(() => users.id),
  expires_at: text().notNull(),
  used_at: text(),
  created_at: text().notNull(),
})
export const smsOperations = pgTable(
  "sms_operations",
  {
    id: text().primaryKey(),
    workspace_id: text()
      .notNull()
      .references(() => workspaces.id),
    kind: text().notNull(),
    request_key: text().notNull(),
    payload_cipher: text().notNull(),
    state: text().notNull().default("queued"),
    step: text(),
    result_cipher: text(),
    error_code: text(),
    lease_until: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [uniqueIndex("sms_operation_retry").on(t.workspace_id, t.request_key)]
)
export const smsNumbers = pgTable(
  "sms_numbers",
  {
    id: text().primaryKey(),
    workspace_id: text()
      .notNull()
      .references(() => workspaces.id),
    account_id: text().notNull(),
    provider_sid: text().notNull(),
    phone: text().notNull(),
    membership_id: text(),
    state: text().notNull(),
    monthly_cents: integer().notNull(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("sms_number_provider").on(t.provider_sid),
    uniqueIndex("sms_number_account").on(t.account_id),
    uniqueIndex("sms_employee_number")
      .on(t.workspace_id, t.membership_id)
      .where(sql`${t.state} <> 'released'`),
  ]
)
export const smsAssignments = pgTable("sms_number_assignments", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  number_id: text().notNull(),
  membership_id: text(),
  actor_user_id: text().notNull(),
  created_at: text().notNull(),
})
export const smsConversations = pgTable(
  "sms_conversations",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    account_id: text().notNull(),
    recipient_hash: text().notNull(),
    recipient_cipher: text().notNull(),
    deal_id: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("sms_conversation_identity").on(
      t.workspace_id,
      t.account_id,
      t.recipient_hash
    ),
  ]
)
export const smsInboxMessages = pgTable(
  "sms_inbox_messages",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    conversation_id: text().notNull(),
    provider_id: text().notNull(),
    direction: text().notNull(),
    body_cipher: text().notNull(),
    created_at: text().notNull(),
  },
  (t) => [uniqueIndex("sms_inbox_provider").on(t.workspace_id, t.provider_id)]
)
export const smsReads = pgTable(
  "sms_conversation_reads",
  {
    conversation_id: text().notNull(),
    membership_id: text().notNull(),
    read_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversation_id, t.membership_id] })]
)
export const smsSuppressions = pgTable(
  "sms_suppressions",
  {
    workspace_id: text().notNull(),
    recipient_hash: text().notNull(),
    state: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.recipient_hash] })]
)
export const smsUsage = pgTable("sms_usage", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  period: text().notNull(),
  category: text().notNull(),
  estimated_cents: integer().notNull().default(0),
  actual_cents: integer(),
  quantity: text(),
  updated_at: text().notNull(),
})
export const smsRegistrationEvents = pgTable("sms_registration_events", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  number_sid: text().notNull(),
  state: text().notNull(),
  provider_time: text().notNull(),
  created_at: text().notNull(),
})
