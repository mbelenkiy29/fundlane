import { check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const mca_closing_stipulations = pgTable("mca_closing_stipulations", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  offer_id: text(), offer_revision_id: text(), funder_id: text(), document_category: text().notNull(),
  label: text().notNull(), owner_membership_id: text(), due_date: text(), status: text().notNull(),
  linked_document_id: text(), exception_reason: text(), idempotency_key: text().notNull(),
  created_by_user_id: text(), created_at: text().notNull(), received_at: text(), verified_at: text(), updated_at: text().notNull(),
}, (table) => [
  index("mca_closing_stips_deal_idx").on(table.workspace_id, table.deal_id, table.status),
  unique("mca_closing_stips_identity_key").on(table.workspace_id, table.deal_id, table.idempotency_key),
  check("mca_closing_stips_status_check", sql`status = ANY (ARRAY['open'::text, 'received'::text, 'verified'::text, 'waived'::text])`),
])

export const mca_merchant_upload_links = pgTable("mca_merchant_upload_links", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  stipulation_id: text(), token_hash: text().notNull(), destination_category: text().notNull(),
  expires_at: text().notNull(), max_uploads: integer().default(1).notNull(), used_count: integer().default(0).notNull(),
  revoked_at: text(), idempotency_key: text().notNull(), created_by_user_id: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_merchant_upload_links_token_key").on(table.token_hash),
  unique("mca_merchant_upload_links_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_merchant_upload_links_deal_idx").on(table.workspace_id, table.deal_id, table.created_at),
  check("mca_merchant_upload_links_counts_check", sql`max_uploads > 0 AND used_count >= 0 AND used_count <= max_uploads`),
])

export const mca_closing_previews = pgTable("mca_closing_previews", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  kind: text().notNull(), record_id: text().notNull(), channel: text().notNull(), sender_id: text(),
  recipient_cipher: text().notNull(), subject_cipher: text(), body_cipher: text().notNull(), content_hash: text().notNull(),
  attachment_document_refs_json: text().default('[]').notNull(),
  state: text().default('preview').notNull(), idempotency_key: text().notNull(), created_by_user_id: text(),
  created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_closing_previews_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_closing_previews_record_idx").on(table.workspace_id, table.record_id, table.created_at),
  check("mca_closing_previews_kind_check", sql`kind = ANY (ARRAY['stipulation_request'::text, 'contract_request'::text, 'repricing_request'::text])`),
  check("mca_closing_previews_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text])`),
  check("mca_closing_previews_state_check", sql`state = ANY (ARRAY['preview'::text, 'sent'::text, 'failed'::text])`),
])

export const mca_closing_deliveries = pgTable("mca_closing_deliveries", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  kind: text().notNull(), record_id: text().notNull(), attempt_key: text().notNull(), channel: text().notNull(),
  state: text().notNull(), recipient_cipher: text(), payload_hash: text().notNull(), correlation_id: text().notNull(),
  external_id: text(), error_code: text(), error_message: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_closing_deliveries_attempt_key").on(table.workspace_id, table.kind, table.record_id, table.attempt_key),
  index("mca_closing_deliveries_record_idx").on(table.workspace_id, table.record_id, table.created_at),
  check("mca_closing_deliveries_state_check", sql`state = ANY (ARRAY['pending'::text, 'sent'::text, 'preview'::text, 'failed'::text, 'blocked'::text])`),
  check("mca_closing_deliveries_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text, 'webhook'::text, 'phone'::text])`),
])

export const mca_contract_workflows = pgTable("mca_contract_workflows", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  offer_id: text().notNull(), offer_revision_id: text().notNull(), offer_revision_number: integer().notNull(),
  funder_id: text(), funder_name: text().notNull(), state: text().notNull(), recipient_cipher: text(),
  attached_document_ids_json: text().default('[]').notNull(), outstanding_stips_json: text().default('[]').notNull(),
  accepted_at: text(), contract_requested_at: text(), contract_sent_at: text(), signed_at: text(), final_review_at: text(),
  repricing_requested_at: text(), signature_source: text(), signature_external_id: text(), signature_evidence_document_id: text(),
  manual_signature_reason: text(), idempotency_key: text().notNull(), created_by_user_id: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_contract_workflows_revision_key").on(table.workspace_id, table.deal_id, table.offer_revision_id),
  unique("mca_contract_workflows_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_contract_workflows_deal_idx").on(table.workspace_id, table.deal_id, table.updated_at),
  check("mca_contract_workflows_state_check", sql`state = ANY (ARRAY['accepted'::text, 'contract_requested'::text, 'contract_sent'::text, 'repricing_requested'::text, 'signed'::text, 'final_review'::text])`),
  check("mca_contract_signature_source_check", sql`signature_source IS NULL OR signature_source = ANY (ARRAY['external'::text, 'manual'::text])`),
])

export const mca_psf_config = pgTable("mca_psf_config", {
  workspace_id: text().primaryKey().notNull(), enabled: integer().default(0).notNull(),
  visible_to_reps: integer().default(0).notNull(), destination_cipher: text(), signing_secret_cipher: text(),
  updated_by_user_id: text(), updated_at: text().notNull(),
})

export const mca_psf_requests = pgTable("mca_psf_requests", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  offer_id: text().notNull(), offer_revision_id: text().notNull(), offer_revision_number: integer().notNull(),
  amount_cents: integer().notNull(), bank_name_cipher: text().notNull(), routing_number_cipher: text().notNull(),
  account_number_cipher: text().notNull(), business_name_cipher: text().notNull(), contact_name_cipher: text().notNull(),
  contact_email_cipher: text().notNull(), payload_version: integer().default(1).notNull(), payload_hash: text().notNull(),
  state: text().notNull(), idempotency_key: text().notNull(), correlation_id: text().notNull(), external_request_id: text(),
  last_error_code: text(), last_error_message: text(), delivered_at: text(), signed_at: text(),
  created_by_user_id: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_psf_requests_idempotency_key").on(table.workspace_id, table.idempotency_key),
  unique("mca_psf_requests_revision_key").on(table.workspace_id, table.deal_id, table.offer_revision_id),
  index("mca_psf_requests_deal_idx").on(table.workspace_id, table.deal_id, table.updated_at),
  check("mca_psf_requests_state_check", sql`state = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'signed'::text])`),
])

export const mca_offer_message_previews = pgTable("mca_offer_message_previews", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  offer_id: text().notNull(), offer_revision_id: text().notNull(), offer_revision_number: integer().notNull(),
  offer_revision_ids_json: text().default('[]').notNull(),
  selection_mode: text().notNull(), channel: text().notNull(), sender_id: text(), recipient_cipher: text().notNull(),
  subject_cipher: text(), body_cipher: text().notNull(), content_hash: text().notNull(), state: text().notNull(),
  idempotency_key: text().notNull(), created_by_user_id: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (table) => [
  unique("mca_offer_message_previews_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_offer_message_previews_deal_idx").on(table.workspace_id, table.deal_id, table.created_at),
  check("mca_offer_message_previews_mode_check", sql`selection_mode = ANY (ARRAY['selected'::text, 'all'::text, 'highest'::text])`),
  check("mca_offer_message_previews_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text])`),
  check("mca_offer_message_previews_state_check", sql`state = ANY (ARRAY['preview'::text, 'sent'::text, 'failed'::text])`),
])

export const mca_pitch_events = pgTable("mca_pitch_events", {
  id: text().primaryKey().notNull(), workspace_id: text().notNull(), deal_id: text().notNull(),
  offer_id: text().notNull(), offer_revision_id: text().notNull(), message_preview_id: text(),
  channel: text().notNull(), transport_succeeded: integer().default(0).notNull(), notes: text(),
  idempotency_key: text().notNull(), actor_user_id: text(), pitched_at: text().notNull(),
}, (table) => [
  unique("mca_pitch_events_idempotency_key").on(table.workspace_id, table.idempotency_key),
  index("mca_pitch_events_deal_idx").on(table.workspace_id, table.deal_id, table.pitched_at),
  check("mca_pitch_events_channel_check", sql`channel = ANY (ARRAY['email'::text, 'sms'::text, 'phone'::text])`),
])
