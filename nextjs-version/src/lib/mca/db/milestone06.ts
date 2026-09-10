import { check, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

const smsProviders = sql`provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text])`

export const mca_sms_adapter_credentials = pgTable("mca_sms_adapter_credentials", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  provider: text().notNull(),
  environment: text().notNull(),
  payload_cipher: text().notNull(),
  capabilities_json: text().default("{}").notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_sms_adapter_credentials_provider_env").on(table.workspace_id, table.provider, table.environment),
  index("mca_sms_adapter_credentials_workspace_idx").on(table.workspace_id, table.provider),
  check("mca_sms_adapter_credentials_provider_check", smsProviders),
  check("mca_sms_adapter_credentials_environment_check", sql`environment = ANY (ARRAY['development'::text, 'production'::text])`),
])

export const mca_message_templates = pgTable("mca_message_templates", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  name: text().notNull(),
  channel: text().notNull(),
  scope: text().notNull(),
  published_version_id: text(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_message_templates_name_key").on(table.workspace_id, table.name, table.channel),
  index("mca_message_templates_workspace_idx").on(table.workspace_id, table.channel, table.scope),
  check("mca_message_templates_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text])`),
  check("mca_message_templates_scope_check", sql`scope = ANY (ARRAY['merchant'::text, 'followup'::text, 'digest'::text, 'request_info'::text])`),
])

export const mca_message_template_versions = pgTable("mca_message_template_versions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  template_id: text().notNull(),
  version: integer().notNull(),
  subject: text(),
  body: text().notNull(),
  variable_schema_hash: text().notNull(),
  published: integer().default(0).notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_message_template_versions_version_key").on(table.template_id, table.version),
  index("mca_message_template_versions_template_idx").on(table.workspace_id, table.template_id, table.created_at),
  check("mca_message_template_versions_published_check", sql`published IN (0,1)`),
])

export const mca_followup_policies = pgTable("mca_followup_policies", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  deal_status: text().notNull(),
  channel: text().notNull(),
  local_schedule: text().notNull(),
  template_id: text().notNull(),
  enabled: integer().default(1).notNull(),
  retry_policy_json: text().default("{}").notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  index("mca_followup_policies_workspace_idx").on(table.workspace_id, table.enabled, table.deal_status),
  check("mca_followup_policies_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text])`),
  check("mca_followup_policies_enabled_check", sql`enabled IN (0,1)`),
])

export const mca_followup_occurrences = pgTable("mca_followup_occurrences", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  policy_id: text().notNull(),
  deal_id: text().notNull(),
  occurrence_key: text().notNull(),
  state: text().notNull(),
  skip_reason: text(),
  message_id: text(),
  correlation_id: text().notNull(),
  scheduled_for: text().notNull(),
  attempted_at: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_followup_occurrences_key").on(table.workspace_id, table.policy_id, table.deal_id, table.occurrence_key),
  index("mca_followup_occurrences_due_idx").on(table.workspace_id, table.state, table.scheduled_for),
  check("mca_followup_occurrences_state_check", sql`state = ANY (ARRAY['pending'::text, 'sent'::text, 'skipped'::text, 'failed'::text])`),
])

export const mca_digest_subscriptions = pgTable("mca_digest_subscriptions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  membership_id: text().notNull(),
  enabled: integer().default(0).notNull(),
  timezone: text().notNull(),
  local_send_hour: integer().default(6).notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_digest_subscriptions_member_key").on(table.workspace_id, table.membership_id),
  check("mca_digest_subscriptions_enabled_check", sql`enabled IN (0,1)`),
  check("mca_digest_subscriptions_hour_check", sql`local_send_hour >= 0 AND local_send_hour <= 23`),
])

export const mca_digest_deliveries = pgTable("mca_digest_deliveries", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  membership_id: text().notNull(),
  window_start: text().notNull(),
  window_end: text().notNull(),
  state: text().notNull(),
  correlation_id: text().notNull(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_digest_deliveries_window_key").on(table.workspace_id, table.membership_id, table.window_start),
  check("mca_digest_deliveries_state_check", sql`state = ANY (ARRAY['sent'::text, 'skipped'::text, 'failed'::text])`),
])

export const mca_workflow_webhook_endpoints = pgTable("mca_workflow_webhook_endpoints", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  label: text().notNull(),
  destination_url: text().notNull(),
  events_json: text().notNull(),
  signing_secret_cipher: text().notNull(),
  notify_originator: integer().default(0).notNull(),
  notify_closer: integer().default(0).notNull(),
  enabled: integer().default(1).notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_workflow_webhook_endpoints_label_key").on(table.workspace_id, table.label),
  check("mca_workflow_webhook_endpoints_flags_check", sql`notify_originator IN (0,1) AND notify_closer IN (0,1) AND enabled IN (0,1)`),
])

export const mca_workflow_webhook_outbox = pgTable("mca_workflow_webhook_outbox", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  endpoint_id: text().notNull(),
  event_id: text().notNull(),
  event_type: text().notNull(),
  payload_json: text().notNull(),
  state: text().notNull(),
  attempts: integer().default(0).notNull(),
  last_error: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_workflow_webhook_outbox_event_key").on(table.workspace_id, table.endpoint_id, table.event_id),
  index("mca_workflow_webhook_outbox_due_idx").on(table.workspace_id, table.state, table.created_at),
  check("mca_workflow_webhook_outbox_state_check", sql`state = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text])`),
])

export const mca_workflow_webhook_deliveries = pgTable("mca_workflow_webhook_deliveries", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  outbox_id: text().notNull(),
  event_id: text().notNull(),
  attempt: integer().notNull(),
  http_status: integer(),
  state: text().notNull(),
  error: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_workflow_webhook_deliveries_attempt_key").on(table.workspace_id, table.outbox_id, table.attempt),
  check("mca_workflow_webhook_deliveries_state_check", sql`state = ANY (ARRAY['delivered'::text, 'failed'::text])`),
])

export const mca_export_jobs = pgTable("mca_export_jobs", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  kind: text().notNull(),
  filter_snapshot_json: text().notNull(),
  field_manifest_json: text().notNull(),
  state: text().notNull(),
  checksum: text(),
  row_count: integer(),
  actor_user_id: text(),
  correlation_id: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  index("mca_export_jobs_workspace_idx").on(table.workspace_id, table.created_at),
  check("mca_export_jobs_kind_check", sql`kind = ANY (ARRAY['deals'::text, 'offers'::text, 'all_deals_owners'::text, 'funded_deals'::text])`),
  check("mca_export_jobs_state_check", sql`state = ANY (ARRAY['queued'::text, 'ready'::text, 'failed'::text, 'expired'::text])`),
])

export const mca_export_download_tokens = pgTable("mca_export_download_tokens", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  job_id: text().notNull(),
  token_hash: text().notNull(),
  expires_at: text().notNull(),
  downloaded_at: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_export_download_tokens_hash_key").on(table.token_hash),
  index("mca_export_download_tokens_job_idx").on(table.workspace_id, table.job_id),
])

export const mca_deal_acquisition_events = pgTable("mca_deal_acquisition_events", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  deal_id: text().notNull(),
  source_id: text(),
  batch_id: text(),
  cost_cents: integer(),
  purchased_on: text(),
  actor_user_id: text(),
  correlation_id: text().notNull(),
  created_at: text().notNull(),
}, (table) => [
  index("mca_deal_acquisition_events_deal_idx").on(table.workspace_id, table.deal_id, table.created_at),
  unique("mca_deal_acquisition_events_correlation_key").on(table.workspace_id, table.correlation_id),
])

export const mca_funder_reminders = pgTable("mca_funder_reminders", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  job_id: text().notNull(),
  sender_id: text(),
  thread_id: text(),
  in_reply_to: text(),
  references_json: text().default("[]").notNull(),
  state: text().notNull(),
  last_reminded_at: text(),
  correlation_id: text().notNull(),
  actor_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  index("mca_funder_reminders_job_idx").on(table.workspace_id, table.job_id, table.created_at),
  check("mca_funder_reminders_state_check", sql`state = ANY (ARRAY['previewed'::text, 'sent'::text, 'failed'::text])`),
])

export const mca_followup_sender_settings = pgTable("mca_followup_sender_settings", {
  workspace_id: text().primaryKey().notNull(),
  id: text().notNull(),
  sender_mode: text().notNull(),
  bcc_fallback: integer().default(0).notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
  updated_by_user_id: text(),
}, (table) => [
  check("mca_followup_sender_settings_mode_check", sql`sender_mode = ANY (ARRAY['originator'::text, 'workspace_shared'::text])`),
  check("mca_followup_sender_settings_bcc_check", sql`bcc_fallback IN (0,1)`),
])

export const mca_followup_template_copy = pgTable("mca_followup_template_copy", {
  workspace_id: text().notNull(),
  template_id: text().notNull(),
  cc_emails: text().default("[]").notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  primaryKey({ columns: [table.workspace_id, table.template_id], name: "mca_followup_template_copy_pkey" }),
])
