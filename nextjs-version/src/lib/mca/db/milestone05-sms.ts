import { check, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const mca_sms_accounts = pgTable("mca_sms_accounts", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), provider: text().notNull(), label: text().notNull(),
  sender_kind: text().notNull(), sender_identity_cipher: text().notNull(), credential_ref: text().notNull(),
  state: text().default("active").notNull(), is_default: integer().default(0).notNull(),
  created_by_user_id: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_sms_accounts_label_key").on(table.workspace_id, table.label),
  index("mca_sms_accounts_route_idx").on(table.workspace_id, table.state, table.is_default),
  check("mca_sms_accounts_provider_check", sql`provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text])`),
  check("mca_sms_accounts_sender_kind_check", sql`sender_kind = ANY (ARRAY['phone_number'::text, 'messaging_service'::text])`),
  check("mca_sms_accounts_state_check", sql`state = ANY (ARRAY['active'::text, 'revoked'::text])`),
  check("mca_sms_accounts_default_check", sql`is_default IN (0,1)`),
])

export const mca_sms_account_members = pgTable("mca_sms_account_members", {
  workspace_id: text().notNull(), account_id: text().notNull(), membership_id: text().notNull(), assigned_at: text().notNull(), assigned_by_user_id: text(),
}, (table) => [
  primaryKey({ columns: [table.account_id, table.membership_id], name: "mca_sms_account_members_pkey" }),
  index("mca_sms_account_members_member_idx").on(table.workspace_id, table.membership_id, table.account_id),
])

export const mca_sms_consent_events = pgTable("mca_sms_consent_events", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(), recipient_hash: text().notNull(),
  recipient_cipher: text().notNull(), state: text().notNull(), source: text().notNull(), evidence: text(),
  idempotency_key: text().notNull(), actor_user_id: text(), effective_at: text().notNull(), created_at: text().notNull(),
}, (table) => [
  unique("mca_sms_consent_events_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_sms_consent_events_current_idx").on(table.workspace_id, table.deal_id, table.recipient_hash, table.effective_at),
  check("mca_sms_consent_events_state_check", sql`state = ANY (ARRAY['opted_in'::text, 'opted_out'::text])`),
  check("mca_sms_consent_events_source_check", sql`source = ANY (ARRAY['manual'::text, 'provider_webhook'::text, 'keyword'::text])`),
])

export const mca_sms_messages = pgTable("mca_sms_messages", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(), account_id: text().notNull(), provider: text().notNull(),
  sender_identity_cipher: text().notNull(), recipient_hash: text().notNull(), recipient_cipher: text().notNull(), body_cipher: text().notNull(),
  content_hash: text().notNull(), payload_hash: text().notNull(), state: text().notNull(), provider_message_id: text(), provider_status: text(),
  error_code: text(), error_message: text(), idempotency_key: text().notNull(), correlation_id: text().notNull(), actor_user_id: text(),
  accepted_at: text(), delivered_at: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_sms_messages_idempotency_key").on(table.workspace_id, table.idempotency_key),
  unique("mca_sms_messages_provider_id_key").on(table.workspace_id, table.provider, table.provider_message_id),
  index("mca_sms_messages_deal_idx").on(table.workspace_id, table.deal_id, table.created_at),
  index("mca_sms_messages_recipient_idx").on(table.workspace_id, table.recipient_hash, table.created_at),
  check("mca_sms_messages_provider_check", sql`provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text])`),
  check("mca_sms_messages_state_check", sql`state = ANY (ARRAY['pending'::text, 'accepted'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'unknown'::text])`),
])

export const mca_sms_status_events = pgTable("mca_sms_status_events", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), message_id: text().notNull(), provider_message_id: text().notNull(),
  provider_status: text().notNull(), error_code: text(), event_key: text().notNull(), received_at: text().notNull(),
}, (table) => [
  unique("mca_sms_status_events_event_key").on(table.workspace_id, table.event_key),
  index("mca_sms_status_events_message_idx").on(table.workspace_id, table.message_id, table.received_at),
])
