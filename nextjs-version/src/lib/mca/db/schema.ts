import { pgTable, uuid, text, integer, bigserial, index, unique, check, foreignKey, uniqueIndex, doublePrecision, primaryKey } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const mca_datamerch_config = pgTable("mca_datamerch_config", {
	workspace_id: text().primaryKey().notNull(),
	enabled: integer().default(0).notNull(),
	credential_cipher: text(),
	credential_expires_at: text(),
	last_diagnostic: text(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const mca_datamerch_checks = pgTable("mca_datamerch_checks", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	deal_version: integer().notNull(),
	status: text().notNull(),
	correlation_id: text().notNull(),
	result_summary: text(),
	record_count: integer().default(0).notNull(),
	query_kind: text(),
	result_cipher: text(),
	lease_token: text(),
	lease_expires_at: text(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_datamerch_checks_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	unique("mca_datamerch_checks_workspace_id_deal_id_correlation_id_key").on(table.correlation_id, table.deal_id, table.workspace_id),
	check("mca_datamerch_checks_status_check", sql`status = ANY (ARRAY['queued'::text, 'no_result'::text, 'records'::text, 'failed'::text])`),
]);

export const workspaces = pgTable("workspaces", {
	clerk_organization_id: text().unique(),
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	logo_url: text(),
	timezone: text().default('America/New_York').notNull(),
	seat_limit: integer().default(5).notNull(),
	feature_flags: text().notNull(),
	page_visibility: text().notNull(),
	action_visibility: text().default('{"createDeal":true,"exportDeals":true,"inviteUsers":true,"manageApiKeys":true,"viewPaymentTable":true,"viewCompanyFinancials":true}').notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, () => [
	check("workspaces_seat_limit_check", sql`seat_limit > 0`),
]);

export const workspace_billing = pgTable("workspace_billing", {
  workspace_id: text().primaryKey().references(() => workspaces.id).notNull(),
  clerk_subscription_id: text().unique().notNull(),
  clerk_plan_id: text().notNull(),
  plan_slug: text().notNull(),
  plan_name: text().notNull(),
  status: text().notNull(),
  period_start: text().notNull(),
  period_end: text(),
  seat_limit: integer().notNull(),
  payment_past_due: integer().default(0).notNull(),
  synced_at: text().notNull(),
});

export const memberships = pgTable("memberships", {
	clerk_membership_id: text().unique(),
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	user_id: text().notNull(),
	role: text().notNull(),
	manager_membership_id: text(),
	status: text().notNull(),
	sender_association: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("memberships_manager_idx").using("btree", table.workspace_id.asc().nullsLast(), table.manager_membership_id.asc().nullsLast()),
	index("memberships_workspace_status_idx").using("btree", table.workspace_id.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.manager_membership_id],
			foreignColumns: [table.id],
			name: "memberships_manager_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "memberships_user_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "memberships_workspace_id_fkey"
		}),
	unique("memberships_workspace_id_user_id_key").on(table.user_id, table.workspace_id),
	check("memberships_role_check", sql`role = ANY (ARRAY['rep'::text, 'manager'::text, 'admin'::text, 'super_admin'::text])`),
	check("memberships_status_check", sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'deactivated'::text])`),
]);

export const users = pgTable("users", {
	supabase_user_id: uuid().unique("users_supabase_user_id_key"),
	clerk_user_id: text().unique(),
	id: text().primaryKey().notNull(),
	email: text().notNull(),
	password_hash: text(),
	name: text().notNull(),
	phone: text(),
	application_identifier: text().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	uniqueIndex("users_email_lower_unique").using("btree", sql`lower(email)`),
	unique("users_application_identifier_key").on(table.application_identifier),
	unique("users_email_key").on(table.email),
]);

export const sessions = pgTable("sessions", {
	id: text().primaryKey().notNull(),
	user_id: text().notNull(),
	membership_id: text().notNull(),
	token_hash: text().notNull(),
	expires_at: text().notNull(),
	created_at: text().notNull(),
	last_seen_at: text().notNull(),
}, (table) => [
	index("sessions_expiry_idx").using("btree", table.expires_at.asc().nullsLast()),
	foreignKey({
			columns: [table.membership_id],
			foreignColumns: [memberships.id],
			name: "sessions_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "sessions_user_id_fkey"
		}),
	unique("sessions_token_hash_key").on(table.token_hash),
]);

export const invitations = pgTable("invitations", {
	clerk_invitation_id: text().unique(),
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	membership_id: text().notNull(),
	email: text().notNull(),
	token_hash: text().notNull(),
	expires_at: text().notNull(),
	status: text().notNull(),
	delivery_status: text().notNull(),
	delivery_correlation_id: text().notNull(),
	created_by: text().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("invitations_membership_idx").using("btree", table.membership_id.asc().nullsLast(), table.created_at.asc().nullsLast()),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [users.id],
			name: "invitations_created_by_fkey"
		}),
	foreignKey({
			columns: [table.membership_id],
			foreignColumns: [memberships.id],
			name: "invitations_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "invitations_workspace_id_fkey"
		}),
	unique("invitations_token_hash_key").on(table.token_hash),
	check("invitations_delivery_status_check", sql`delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'preview'::text, 'failed'::text])`),
	check("invitations_status_check", sql`status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'superseded'::text])`),
]);

export const recovery_tokens = pgTable("recovery_tokens", {
	id: text().primaryKey().notNull(),
	user_id: text().notNull(),
	token_hash: text().notNull(),
	expires_at: text().notNull(),
	used_at: text(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.user_id],
			foreignColumns: [users.id],
			name: "recovery_tokens_user_id_fkey"
		}),
	unique("recovery_tokens_token_hash_key").on(table.token_hash),
]);

export const api_keys = pgTable("api_keys", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	name: text().notNull(),
	prefix: text().notNull(),
	secret_hash: text().notNull(),
	scopes: text().notNull(),
	expires_at: text(),
	last_used_at: text(),
	revoked_at: text(),
	rate_limit_per_minute: integer().default(60).notNull(),
	created_by: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("api_keys_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.created_at.asc().nullsLast()),
	foreignKey({
			columns: [table.created_by],
			foreignColumns: [users.id],
			name: "api_keys_created_by_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "api_keys_workspace_id_fkey"
		}),
	unique("api_keys_secret_hash_key").on(table.secret_hash),
	check("api_keys_rate_limit_per_minute_check", sql`(rate_limit_per_minute >= 1) AND (rate_limit_per_minute <= 10000)`),
]);

export const audit_events = pgTable("audit_events", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	actor_user_id: text(),
	source: text().notNull(),
	action: text().notNull(),
	resource_type: text().notNull(),
	resource_id: text().notNull(),
	metadata: text().notNull(),
	correlation_id: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("audit_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "audit_events_workspace_id_fkey"
		}),
	check("audit_events_source_check", sql`source = ANY (ARRAY['user'::text, 'api_key'::text, 'system'::text])`),
]);

export const mca_merchants = pgTable("mca_merchants", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	legal_name: text(),
	dba_name: text(),
	ein_cipher: text(),
	ein_lookup_hash: text(),
	contact_name: text(),
	contact_email_cipher: text(),
	contact_phone_cipher: text(),
	address_json: text().default("{}").notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_merchants_workspace_id_idx").on(table.workspace_id),
	index("mca_merchants_workspace_ein_lookup_hash_idx")
		.on(table.workspace_id, table.ein_lookup_hash)
		.where(sql`${table.ein_lookup_hash} IS NOT NULL`),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_merchants_workspace_id_fkey",
	}),
]);

export const mca_merchant_owners = pgTable("mca_merchant_owners", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	merchant_id: text().notNull(),
	first_name: text(),
	last_name: text(),
	ownership_percent: doublePrecision(),
	is_primary: integer().default(0).notNull(),
	date_of_birth_cipher: text(),
	identity_last4_cipher: text(),
	identity_last4_lookup_hash: text(),
	email_cipher: text(),
	phone_cipher: text(),
}, (table) => [
	index("mca_merchant_owners_workspace_id_idx").on(table.workspace_id),
	index("mca_merchant_owners_merchant_id_idx").on(table.merchant_id),
	index("mca_merchant_owners_workspace_identity_last4_lookup_hash_idx")
		.on(table.workspace_id, table.identity_last4_lookup_hash)
		.where(sql`${table.identity_last4_lookup_hash} IS NOT NULL`),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_merchant_owners_workspace_id_fkey",
	}),
	foreignKey({
		columns: [table.merchant_id],
		foreignColumns: [mca_merchants.id],
		name: "mca_merchant_owners_merchant_id_fkey",
	}).onDelete("cascade"),
]);

export const deals = pgTable("deals", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	merchant_id: text(),
	display_id: text().notNull(),
	legal_name: text(),
	dba_name: text(),
	ein_cipher: text(),
	ein_lookup_hash: text(),
	entity_type: text(),
	address_json: text().default('{}').notNull(),
	contact_name: text(),
	contact_email_cipher: text(),
	contact_phone_cipher: text(),
	start_date: text(),
	industry: text(),
	naics_code: text(),
	monthly_revenue: doublePrecision(),
	fico_score: integer(),
	funding_purpose: text(),
	requested_amount: doublePrecision(),
	status: text().notNull(),
	pipeline_version: integer().default(1).notNull(),
	draft_state: text().notNull(),
	missing_required_json: text().notNull(),
	field_sources_json: text().notNull(),
	idempotency_key: text(),
	version: integer().default(1).notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("deals_workspace_status_idx").using("btree", table.workspace_id.asc().nullsLast(), table.status.asc().nullsLast(), table.updated_at.desc().nullsFirst()),
	index("deals_merchant_id_idx").on(table.merchant_id),
	index("deals_workspace_ein_lookup_hash_idx").on(table.workspace_id, table.ein_lookup_hash).where(sql`${table.ein_lookup_hash} IS NOT NULL`),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deals_workspace_id_fkey"
		}),
	foreignKey({
			columns: [table.merchant_id],
			foreignColumns: [mca_merchants.id],
			name: "deals_merchant_id_fkey"
		}).onDelete("set null"),
	unique("deals_workspace_id_display_id_key").on(table.display_id, table.workspace_id),
	unique("deals_workspace_id_idempotency_key_key").on(table.idempotency_key, table.workspace_id),
]);

export const deal_owners = pgTable("deal_owners", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	first_name: text(),
	last_name: text(),
	ownership_percent: doublePrecision(),
	is_primary: integer().default(0).notNull(),
	date_of_birth_cipher: text(),
	identity_last4_cipher: text(),
	identity_last4_lookup_hash: text(),
	email_cipher: text(),
	phone_cipher: text(),
}, (table) => [
	index("deal_owners_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast()),
	index("deal_owners_workspace_identity_last4_lookup_hash_idx").on(table.workspace_id, table.identity_last4_lookup_hash).where(sql`${table.identity_last4_lookup_hash} IS NOT NULL`),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_owners_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_owners_workspace_id_fkey"
		}),
]);

export const deal_assignments = pgTable("deal_assignments", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	membership_id: text().notNull(),
	kind: text().notNull(),
	is_primary: integer().default(0).notNull(),
	assigned_at: text().notNull(),
	assigned_by_user_id: text(),
}, (table) => [
	index("deal_assignments_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.membership_id.asc().nullsLast(), table.kind.asc().nullsLast(), table.deal_id.asc().nullsLast()),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_assignments_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.membership_id],
			foreignColumns: [memberships.id],
			name: "deal_assignments_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_assignments_workspace_id_fkey"
		}),
	unique("deal_assignments_deal_id_membership_id_kind_key").on(table.deal_id, table.kind, table.membership_id),
	check("deal_assignments_kind_check", sql`kind = ANY (ARRAY['originator'::text, 'closer'::text])`),
]);

export const deal_notes = pgTable("deal_notes", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	body: text().notNull(),
	actor_user_id: text(),
	created_at: text().notNull(),
}, (table) => [
	index("deal_notes_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_notes_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_notes_workspace_id_fkey"
		}),
]);

export const deal_activity = pgTable("deal_activity", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	action: text().notNull(),
	actor_user_id: text(),
	source: text().notNull(),
	summary: text().notNull(),
	from_status: text(),
	to_status: text(),
	record_version: integer().notNull(),
	correlation_id: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("deal_activity_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_activity_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_activity_workspace_id_fkey"
		}),
]);

export const deal_submissions = pgTable("deal_submissions", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	funder_name: text().notNull(),
	status: text().notNull(),
	funder_id: text(),
	job_id: text(),
	route_kind: text(),
}, (table) => [
	index("deal_submissions_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.funder_name.asc().nullsLast()),
	index("deal_submissions_funder_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.funder_id.asc().nullsLast()),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_submissions_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_submissions_workspace_id_fkey"
		}),
]);

export const deal_offers = pgTable("deal_offers", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	submission_id: text().notNull(),
	status: text().notNull(),
	amount: doublePrecision(),
	rate: doublePrecision(),
	term: integer(),
	frequency: text(),
	commission: doublePrecision(),
	fees_json: text(),
	offer_link: text(),
	source: text(),
	raw_status: text(),
	evidence_json: text(),
	terms_unknown: integer().default(0).notNull(),
}, (table) => [
	index("deal_offers_scope_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast()),
	foreignKey({
			columns: [table.deal_id],
			foreignColumns: [deals.id],
			name: "deal_offers_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.submission_id],
			foreignColumns: [deal_submissions.id],
			name: "deal_offers_submission_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "deal_offers_workspace_id_fkey"
		}),
	check("deal_offers_source_check", sql`source IS NULL OR source = ANY (ARRAY['api'::text, 'email'::text, 'link'::text, 'manual'::text])`),
]);

export const mca_documents = pgTable("mca_documents", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	idempotency_key: text().notNull(),
	original_filename: text().notNull(),
	display_filename: text().notNull(),
	mime_type: text().notNull(),
	byte_length: integer().notNull(),
	checksum: text().notNull(),
	category: text().notNull(),
	lineage_id: text(),
	version: integer().notNull(),
	previous_document_id: text(),
	storage_key: text().notNull(),
	source: text().notNull(),
	source_reference: text(),
	processing_state: text().notNull(),
	scan_provider: text(),
	scan_evidence: text(),
	scan_attempted_at: text(),
	created_by: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_documents_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	uniqueIndex("mca_documents_lineage_version_idx").using("btree", table.workspace_id.asc().nullsLast(), table.lineage_id.asc().nullsLast(), table.version.asc().nullsLast()),
	unique("mca_documents_storage_key_key").on(table.storage_key),
	unique("mca_documents_workspace_id_idempotency_key_key").on(table.idempotency_key, table.workspace_id),
]);

export const mca_application_confirmation_claims = pgTable("mca_application_confirmation_claims", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	source_type: text().notNull(),
	source_id: text().notNull(),
	confirmation_id: text().notNull(),
	attempt_token: text(),
	lease_expires_at: text(),
	state: text().notNull(),
	deal_id: text(),
	source_document_id: text(),
	error: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	unique("mca_application_confirmation__workspace_id_source_type_sour_key").on(table.source_id, table.source_type, table.workspace_id),
	unique("mca_application_confirmation_c_workspace_id_confirmation_id_key").on(table.confirmation_id, table.workspace_id),
]);

export const mca_application_extractions = pgTable("mca_application_extractions", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	document_id: text().notNull(),
	document_version: integer().notNull(),
	extraction_version: integer().notNull(),
	fields: text().notNull(),
	evidence: text().notNull(),
	approved_fields: text().default('{}').notNull(),
	warnings: text().notNull(),
	provider: text().notNull(),
	provider_request_id: text(),
	state: text().notNull(),
	confirmed_deal_id: text(),
	confirmation_id: text(),
	created_by: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_application_extractions_document_idx").using("btree", table.workspace_id.asc().nullsLast(), table.document_id.asc().nullsLast(), table.extraction_version.desc().nullsFirst()),
	unique("mca_application_extractions_workspace_id_confirmation_id_key").on(table.confirmation_id, table.workspace_id),
	unique("mca_application_extractions_workspace_id_document_id_extrac_key").on(table.document_id, table.extraction_version, table.workspace_id),
]);

export const mca_application_scan_drafts = pgTable("mca_application_scan_drafts", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	idempotency_key: text().notNull(),
	filename: text().notNull(),
	mime_type: text().notNull(),
	byte_length: integer().notNull(),
	checksum: text().notNull(),
	storage_key: text().notNull(),
	processing_state: text().notNull(),
	scan_provider: text(),
	scan_evidence: text(),
	extraction_version: integer().default(0).notNull(),
	fields: text().default('{}').notNull(),
	evidence: text().default('{}').notNull(),
	approved_fields: text().default('{}').notNull(),
	warnings: text().default('[]').notNull(),
	extraction_provider: text(),
	provider_request_id: text(),
	state: text().default('uploaded').notNull(),
	confirmed_deal_id: text(),
	confirmation_id: text(),
	created_by: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_application_scan_drafts_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	unique("mca_application_scan_drafts_storage_key_key").on(table.storage_key),
	unique("mca_application_scan_drafts_workspace_id_confirmation_id_key").on(table.confirmation_id, table.workspace_id),
	unique("mca_application_scan_drafts_workspace_id_idempotency_key_key").on(table.idempotency_key, table.workspace_id),
]);

export const mca_pdf_authorizations = pgTable("mca_pdf_authorizations", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	authorized_by: text(),
	merchant_name: text().notNull(),
	authorization_reference: text().notNull(),
	recorded_at: text().notNull(),
	revoked_at: text(),
}, (table) => [
	index("mca_pdf_authorizations_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.recorded_at.desc().nullsFirst()),
]);

export const mca_pdf_generations = pgTable("mca_pdf_generations", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	idempotency_key: text().notNull(),
	document_id: text().notNull(),
	deal_version: integer().notNull(),
	contact_mode: text().notNull(),
	signed_on_behalf: integer().notNull(),
	authorization_id: text(),
	generated_by: text(),
	correlation_id: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	unique("mca_pdf_generations_workspace_id_idempotency_key_key").on(table.idempotency_key, table.workspace_id),
]);

export const mca_funder_criteria = pgTable("mca_funder_criteria", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	funder_id: text().notNull(),
	field: text().notNull(),
	operator: text().notNull(),
	unit: text().notNull(),
	value_json: text(),
	source_text: text(),
	unspecified: integer().default(0).notNull(),
	position: integer().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_funder_criteria_funder_idx").using("btree", table.workspace_id.asc().nullsLast(), table.funder_id.asc().nullsLast(), table.position.asc().nullsLast()),
]);

export const mca_industry_aliases = pgTable("mca_industry_aliases", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	alias: text().notNull(),
	naics: text(),
	normalized_industry: text().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	uniqueIndex("mca_industry_aliases_lower_unique").using("btree", sql`workspace_id`, sql`lower(alias)`),
	index("mca_industry_aliases_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.alias.asc().nullsLast()),
	unique("mca_industry_aliases_workspace_id_alias_key").on(table.alias, table.workspace_id),
]);

export const mca_funders = pgTable("mca_funders", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	idempotency_key: text().notNull(),
	legal_name: text().notNull(),
	nickname: text(),
	website: text(),
	domains: text().default('[]').notNull(),
	products: text().default('[]').notNull(),
	active: integer().default(1).notNull(),
	contacts: text().default('[]').notNull(),
	routes: text().default('[]').notNull(),
	criteria_version: integer().default(1).notNull(),
	profile_version: integer().default(1).notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_funders_legal_name_lower_idx").using("btree", sql`workspace_id`, sql`lower(legal_name)`),
	index("mca_funders_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.legal_name.asc().nullsLast()),
	unique("mca_funders_workspace_id_idempotency_key_key").on(table.idempotency_key, table.workspace_id),
]);

export const mca_funder_groups = pgTable("mca_funder_groups", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	name: text().notNull(),
	funder_ids: text().default('[]').notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_funder_groups_name_lower_idx").using("btree", sql`workspace_id`, sql`lower(name)`),
	index("mca_funder_groups_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.name.asc().nullsLast()),
	unique("mca_funder_groups_workspace_id_name_key").on(table.name, table.workspace_id),
]);

export const import_sources = pgTable("import_sources", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	name: text().notNull(),
	kind: text().notNull(),
	active: integer().default(1).notNull(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "import_sources_workspace_id_fkey"
		}),
	unique("import_sources_workspace_id_name_key").on(table.name, table.workspace_id),
	check("import_sources_kind_check", sql`kind = ANY (ARRAY['spreadsheet'::text, 'drive'::text])`),
]);

export const lead_batches = pgTable("lead_batches", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	source_id: text().notNull(),
	name: text().notNull(),
	purchased_on: text(),
	cost_cents: integer(),
	inactive: integer().default(0).notNull(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.source_id],
			foreignColumns: [import_sources.id],
			name: "lead_batches_source_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "lead_batches_workspace_id_fkey"
		}),
	unique("lead_batches_workspace_id_source_id_name_key").on(table.name, table.source_id, table.workspace_id),
	check("lead_batches_inactive_check", sql`inactive IN (0,1)`),
	check("lead_batches_cost_check", sql`cost_cents IS NULL OR cost_cents >= 0`),
]);

export const import_mapping_profiles = pgTable("import_mapping_profiles", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	name: text().notNull(),
	mapping_json: text().notNull(),
	originator_mapping_json: text().default('{}').notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "import_mapping_profiles_workspace_id_fkey"
		}),
	unique("import_mapping_profiles_workspace_id_name_key").on(table.name, table.workspace_id),
]);

export const import_runs = pgTable("import_runs", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	source_id: text().notNull(),
	batch_id: text().notNull(),
	mode: text().notNull(),
	filename: text().notNull(),
	format: text().notNull(),
	state: text().notNull(),
	preview_revision: integer().notNull(),
	mapping_json: text().notNull(),
	confidence_json: text().notNull(),
	mapping_provider: text().notNull(),
	mapping_warnings_json: text().notNull(),
	assignment_pool_json: text().notNull(),
	cancellation_requested: integer().default(0).notNull(),
	results_csv: text(),
	commit_token: text(),
	lease_expires_at: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("import_runs_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.batch_id],
			foreignColumns: [lead_batches.id],
			name: "import_runs_batch_id_fkey"
		}),
	foreignKey({
			columns: [table.source_id],
			foreignColumns: [import_sources.id],
			name: "import_runs_source_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "import_runs_workspace_id_fkey"
		}),
	check("import_runs_mode_check", sql`mode = ANY (ARRAY['create'::text, 'update'::text, 'drive'::text])`),
]);

export const import_rows = pgTable("import_rows", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	run_id: text().notNull(),
	row_number: integer().notNull(),
	application_json: text().notNull(),
	source_values_json: text().notNull(),
	assignment_membership_id: text(),
	errors_json: text().notNull(),
	warnings_json: text().notNull(),
	duplicate_ids_json: text().notNull(),
	originator_source_value_cipher: text(),
	duplicate_decision: text(),
	update_json: text(),
	state: text().default('staged').notNull(),
	deal_id: text(),
	message: text(),
	checkpoint: integer().default(0).notNull(),
}, (table) => [
	index("import_rows_run_idx").using("btree", table.workspace_id.asc().nullsLast(), table.run_id.asc().nullsLast(), table.row_number.asc().nullsLast()),
	foreignKey({
			columns: [table.run_id],
			foreignColumns: [import_runs.id],
			name: "import_rows_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "import_rows_workspace_id_fkey"
		}),
	unique("import_rows_run_id_row_number_key").on(table.row_number, table.run_id),
	check("import_rows_duplicate_decision_check", sql`duplicate_decision = ANY (ARRAY['create'::text, 'skip'::text])`),
]);

export const import_archive_associations = pgTable("import_archive_associations", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	run_id: text().notNull(),
	row_id: text().notNull(),
	archive_name: text().notNull(),
	entry_path: text().notNull(),
	category: text().notNull(),
	document_id: text(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.row_id],
			foreignColumns: [import_rows.id],
			name: "import_archive_associations_row_id_fkey"
		}),
	foreignKey({
			columns: [table.run_id],
			foreignColumns: [import_runs.id],
			name: "import_archive_associations_run_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "import_archive_associations_workspace_id_fkey"
		}),
	unique("import_archive_associations_run_id_archive_name_entry_path_key").on(table.archive_name, table.entry_path, table.run_id),
]);

export const drive_connections = pgTable("drive_connections", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	folder_id: text().notNull(),
	folder_name: text().notNull(),
	access_token_cipher: text().notNull(),
	refresh_token_cipher: text(),
	expires_at: text(),
	scope: text().notNull(),
	connected_at: text().notNull(),
	revoked_at: text(),
}, (table) => [
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "drive_connections_workspace_id_fkey"
		}),
	unique("drive_connections_workspace_id_key").on(table.workspace_id),
]);

export const drive_transfer_results = pgTable("drive_transfer_results", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	run_id: text().notNull(),
	drive_file_id: text().notNull(),
	name: text().notNull(),
	state: text().notNull(),
	message: text(),
	checksum: text(),
	byte_length: integer(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.run_id],
			foreignColumns: [import_runs.id],
			name: "drive_transfer_results_run_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "drive_transfer_results_workspace_id_fkey"
		}),
	unique("drive_transfer_results_run_id_drive_file_id_key").on(table.drive_file_id, table.run_id),
]);

export const drive_oauth_states = pgTable("drive_oauth_states", {
	state_hash: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	folder_id: text().notNull(),
	expires_at: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "drive_oauth_states_workspace_id_fkey"
		}),
]);

export const intake_integrations = pgTable("intake_integrations", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	provider: text().notNull(),
	display_name: text().notNull(),
	form_id: text(),
	template_id: text(),
	location_id: text(),
	admission_secret_hash: text(),
	signing_secret_cipher: text(),
	credential_cipher: text(),
	credential_expires_at: text(),
	credential_version: integer().default(1).notNull(),
	mapping_json: text().default('{}').notNull(),
	allowed_hosts_json: text().default('[]').notNull(),
	sender_rules_json: text().default('[]').notNull(),
	assignment_pool_json: text().default('[]').notNull(),
	automatic_processing: integer().default(0).notNull(),
	automatic_since: text(),
	initial_status: text().default('lead').notNull(),
	inbound_address: text(),
	enabled: integer().default(1).notNull(),
	approval_state: text().default('approved').notNull(),
	contract_key: text(),
	attachment_method: text(),
	email_gateway: text(),
	provider_server_id: text(),
	provider_evidence_hash: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("intake_integrations_lookup_idx").using("btree", table.provider.asc().nullsLast(), table.form_id.asc().nullsLast(), table.template_id.asc().nullsLast(), table.location_id.asc().nullsLast(), table.enabled.asc().nullsLast()),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "intake_integrations_workspace_id_fkey"
		}),
	unique("intake_integrations_inbound_address_key").on(table.inbound_address),
	unique("intake_integrations_workspace_id_provider_form_id_key").on(table.form_id, table.provider, table.workspace_id),
	unique("intake_integrations_workspace_id_provider_location_id_key").on(table.location_id, table.provider, table.workspace_id),
	unique("intake_integrations_workspace_id_provider_template_id_key").on(table.provider, table.template_id, table.workspace_id),
]);

export const intake_events = pgTable("intake_events", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	provider: text().notNull(),
	provider_event_id: text().notNull(),
	event_namespace: text().default('').notNull(),
	legacy_identity: integer().default(0).notNull(),
	payload_checksum: text().notNull(),
	application_cipher: text().notNull(),
	email_source_cipher: text(),
	email_source_checksum: text(),
	source_reference: text(),
	initial_status: text(),
	state: text().notNull(),
	deal_id: text(),
	integration_id: text(),
	warnings_json: text().default('[]').notNull(),
	error_code: text(),
	error_message: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("intake_events_workspace_state_idx").using("btree", table.workspace_id.asc().nullsLast(), table.state.asc().nullsLast(), table.updated_at.desc().nullsFirst()),
	foreignKey({
			columns: [table.integration_id],
			foreignColumns: [intake_integrations.id],
			name: "intake_events_integration_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "intake_events_workspace_id_fkey"
		}),
	unique("intake_events_scoped_event_key").on(table.workspace_id, table.event_namespace, table.provider, table.provider_event_id),
	check("intake_events_state_check", sql`state = ANY (ARRAY['received'::text, 'validated'::text, 'created'::text, 'file_pending'::text, 'error'::text])`),
]);

export const intake_attachment_jobs = pgTable("intake_attachment_jobs", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	intake_id: text().notNull(),
	attachment_id: text().notNull(),
	source_url_cipher: text(),
	filename: text().notNull(),
	mime_type: text().notNull(),
	category: text().notNull(),
	state: text().notNull(),
	attempt_count: integer().default(0).notNull(),
	next_attempt_at: text(),
	document_id: text(),
	last_error: text(),
	lease_token: text(),
	lease_expires_at: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("intake_attachment_jobs_due_idx").using("btree", table.state.asc().nullsLast(), table.next_attempt_at.asc().nullsLast(), table.updated_at.asc().nullsLast()),
	foreignKey({
			columns: [table.intake_id],
			foreignColumns: [intake_events.id],
			name: "intake_attachment_jobs_intake_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "intake_attachment_jobs_workspace_id_fkey"
		}),
	unique("intake_attachment_jobs_intake_id_attachment_id_key").on(table.attachment_id, table.intake_id),
	check("intake_attachment_jobs_state_check", sql`state = ANY (ARRAY['pending'::text, 'fetching'::text, 'stored'::text, 'retryable'::text, 'failed'::text])`),
]);

export const intake_attribution_tokens = pgTable("intake_attribution_tokens", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	integration_id: text().notNull(),
	membership_id: text().notNull(),
	token_hash: text().notNull(),
	created_at: text().notNull(),
	revoked_at: text(),
}, (table) => [
	foreignKey({
			columns: [table.integration_id],
			foreignColumns: [intake_integrations.id],
			name: "intake_attribution_tokens_integration_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.membership_id],
			foreignColumns: [memberships.id],
			name: "intake_attribution_tokens_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "intake_attribution_tokens_workspace_id_fkey"
		}),
	unique("intake_attribution_tokens_integration_id_membership_id_key").on(table.integration_id, table.membership_id),
	unique("intake_attribution_tokens_token_hash_key").on(table.token_hash),
]);

export const intake_receipts = pgTable("intake_receipts", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	intake_id: text().notNull(),
	recipient_cipher: text().notNull(),
	deal_link_cipher: text(),
	add_document_link_cipher: text(),
	warnings_json: text().default('[]').notNull(),
	state: text().notNull(),
	attempt_count: integer().default(0).notNull(),
	provider_message_id: text(),
	last_error: text(),
	lease_token: text(),
	lease_expires_at: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.intake_id],
			foreignColumns: [intake_events.id],
			name: "intake_receipts_intake_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.workspace_id],
			foreignColumns: [workspaces.id],
			name: "intake_receipts_workspace_id_fkey"
		}),
	unique("intake_receipts_intake_id_recipient_cipher_key").on(table.intake_id, table.recipient_cipher),
	check("intake_receipts_state_check", sql`state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text])`),
]);

export const mca_completeness_settings = pgTable("mca_completeness_settings", {
	workspace_id: text().primaryKey().notNull(),
	required_statement_months: integer().notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
}, () => [
	check("mca_completeness_settings_required_statement_months_check", sql`(required_statement_months >= 1) AND (required_statement_months <= 24)`),
]);

export const mca_completeness_results = pgTable("mca_completeness_results", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	ready: integer().notNull(),
	version: integer().notNull(),
	rule_snapshot: text().notNull(),
	findings_json: text().notNull(),
	findings_fingerprint: text().notNull(),
	checked_at: text().notNull(),
}, (table) => [
	index("mca_completeness_results_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.version.desc().nullsFirst()),
	unique("mca_completeness_results_workspace_id_deal_id_version_key").on(table.deal_id, table.version, table.workspace_id),
]);

export const mca_readiness_events = pgTable("mca_readiness_events", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	completeness_version: integer().notNull(),
	ready: integer().notNull(),
	findings_fingerprint: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_readiness_events_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
]);

export const mca_statement_months = pgTable("mca_statement_months", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	document_id: text().notNull(),
	account_kind: text().notNull(),
	period: text().notNull(),
	account_suffix: text(),
	deposits: text().notNull(),
	deposit_count: text().notNull(),
	average_daily_balance: text().notNull(),
	nsf_count: text().notNull(),
	negative_days: text().notNull(),
	ending_balance: text().notNull(),
	duplicate_of_id: text(),
	extraction_version: integer().notNull(),
	corrected: integer().default(0).notNull(),
	correction_reason: text(),
	corrected_by_user_id: text(),
	corrected_at: text(),
	original_extraction: text().default('{}').notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_statement_months_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.period.asc().nullsLast()),
	unique("mca_statement_months_workspace_id_document_id_key").on(table.document_id, table.workspace_id),
]);

export const mca_existing_positions = pgTable("mca_existing_positions", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	document_id: text(),
	label: text().notNull(),
	estimated_payment: doublePrecision(),
	evidence: text().notNull(),
	status: text().notNull(),
	corrected: integer().default(0).notNull(),
	correction_reason: text(),
	corrected_by_user_id: text(),
	corrected_at: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_existing_positions_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.asc().nullsLast()),
]);

export const api_rate_windows = pgTable("api_rate_windows", {
	api_key_id: text().notNull(),
	bucket_start: integer().notNull(),
	request_count: integer().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.api_key_id],
			foreignColumns: [api_keys.id],
			name: "api_rate_windows_api_key_id_fkey"
		}),
	primaryKey({ columns: [table.api_key_id, table.bucket_start], name: "api_rate_windows_pkey"}),
]);

export const request_rate_windows = pgTable("request_rate_windows", {
	rate_key: text().notNull(),
	bucket_start: integer().notNull(),
	request_count: integer().notNull(),
}, (table) => [
	primaryKey({ columns: [table.bucket_start, table.rate_key], name: "request_rate_windows_pkey"}),
]);

export const mca_funder_criteria_meta = pgTable("mca_funder_criteria_meta", {
	workspace_id: text().notNull(),
	funder_id: text().notNull(),
	fingerprint: text().notNull(),
	published_at: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.funder_id, table.workspace_id], name: "mca_funder_criteria_meta_pkey"}),
]);

export const mca_underwriting_aggregates = pgTable("mca_underwriting_aggregates", {
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	version: integer().notNull(),
	monthly_revenue: text().notNull(),
	average_daily_balance: text().notNull(),
	nsf_count: text().notNull(),
	negative_days: text().notNull(),
	position_count: integer().notNull(),
	stale: integer().notNull(),
	source_fingerprint: text().notNull(),
	computed_at: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.deal_id, table.workspace_id], name: "mca_underwriting_aggregates_pkey"}),
]);

export const mca_data_migrations = pgTable("mca_data_migrations", {
	id: text().primaryKey().notNull(),
	snapshot_sha256: text().notNull(),
	row_digest: text().notNull(),
	table_counts_json: text().notNull(),
	imported_at: text().notNull(),
}, (table) => [
	unique("mca_data_migrations_snapshot_sha256_key").on(table.snapshot_sha256),
]);

export const mca_funder_criteria_scans = pgTable("mca_funder_criteria_scans", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	funder_id: text().notNull(),
	document_id: text().notNull(),
	version: integer().notNull(),
	status: text().notNull(),
	rules_json: text().notNull(),
	previous_rules_json: text().default('[]').notNull(),
	warnings_json: text().notNull(),
	evidence_json: text().notNull(),
	ambiguous_json: text().default('[]').notNull(),
	provider: text().notNull(),
	request_id: text(),
	rolled_back_at: text(),
	accepted_at: text(),
	rejected_at: text(),
	created_by: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_funder_criteria_scans_funder_idx").on(table.workspace_id, table.funder_id, table.version.desc()),
	uniqueIndex("mca_funder_criteria_scans_proposed_doc_idx")
		.on(table.workspace_id, table.funder_id, table.document_id)
		.where(sql`status = 'proposed'`),
	check("mca_funder_criteria_scans_status_check", sql`status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text])`),
]);

export const mca_score_snapshots = pgTable("mca_score_snapshots", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	policy_version: integer().notNull(),
	underwriting_version: integer().notNull(),
	completeness_version: integer().notNull(),
	deal_version: integer().notNull(),
	criteria_versions: text().notNull(),
	mode: text().notNull(),
	top_n: integer().notNull(),
	scores_json: text().notNull(),
	stale: integer().default(0).notNull(),
	aggregate_computed_at: text().default('').notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_score_snapshots_deal_idx").on(table.workspace_id, table.deal_id, table.created_at.desc()),
]);

export const mca_analysis_settings = pgTable("mca_analysis_settings", {
	workspace_id: text().primaryKey().notNull(),
	mode: text().notNull(),
	top_n: integer().notNull(),
	review_notification_channel: text().notNull(),
	automatic_send_enabled: integer().default(0).notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const mca_analysis_runs = pgTable("mca_analysis_runs", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	snapshot_id: text().notNull(),
	completeness_version: integer().notNull(),
	trigger: text().notNull(),
	mode: text().notNull(),
	state: text().notNull(),
	top_n: integer().notNull(),
	review_notification_channel: text().notNull(),
	selected_funder_ids: text().notNull(),
	destinations_json: text().notNull(),
	settings_snapshot: text().notNull(),
	reason: text().notNull(),
	queued: integer().default(0).notNull(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_analysis_runs_deal_idx").on(table.workspace_id, table.deal_id, table.created_at.desc()),
	uniqueIndex("mca_analysis_runs_idempotency_idx").on(
		table.workspace_id,
		table.deal_id,
		table.snapshot_id,
		table.completeness_version,
		table.mode,
		table.top_n,
		table.review_notification_channel,
	),
]);

export const mca_review_settings = pgTable("mca_review_settings", {
	workspace_id: text().primaryKey().notNull(),
	recipient_roles: text().notNull(),
	cc_emails: text().notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const mca_review_approvals = pgTable("mca_review_approvals", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	run_id: text().notNull(),
	snapshot_id: text().notNull(),
	selected_funder_ids: text().notNull(),
	actor_user_id: text(),
	created_at: text().notNull(),
}, (table) => [
	unique("mca_review_approvals_workspace_id_run_id_snapshot_id_key").on(table.workspace_id, table.run_id, table.snapshot_id),
]);

export const mca_email_senders = pgTable("mca_email_senders", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	provider: text().notNull(),
	purpose: text().notNull(),
	from_name: text().notNull(),
	from_address: text().notNull(),
	signature: text(),
	credential_cipher: text(),
	state: text().notNull(),
	is_default: integer().default(0).notNull(),
	verified_at: text(),
	last_error: text(),
	created_by_user_id: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_email_senders_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.purpose.asc().nullsLast()),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_email_senders_workspace_id_fkey",
	}),
	check("mca_email_senders_provider_check", sql`provider = ANY (ARRAY['google'::text, 'microsoft'::text, 'smtp'::text, 'sendgrid'::text])`),
	check("mca_email_senders_purpose_check", sql`purpose = ANY (ARRAY['merchant'::text, 'submission'::text, 'fallback'::text])`),
	check("mca_email_senders_state_check", sql`state = ANY (ARRAY['pending'::text, 'verified'::text, 'expired'::text, 'revoked'::text])`),
]);

export const mca_email_sender_members = pgTable("mca_email_sender_members", {
	sender_id: text().notNull(),
	membership_id: text().notNull(),
	workspace_id: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	primaryKey({ columns: [table.sender_id, table.membership_id] }),
	foreignKey({
		columns: [table.sender_id],
		foreignColumns: [mca_email_senders.id],
		name: "mca_email_sender_members_sender_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.membership_id],
		foreignColumns: [memberships.id],
		name: "mca_email_sender_members_membership_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_email_sender_members_workspace_id_fkey",
	}),
]);

export const mca_email_oauth_states = pgTable("mca_email_oauth_states", {
	state_hash: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	sender_id: text(),
	provider: text().notNull(),
	purpose: text().notNull(),
	expires_at: text().notNull(),
	created_at: text().notNull(),
}, (table) => [
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_email_oauth_states_workspace_id_fkey",
	}),
]);

export const mca_submission_jobs = pgTable("mca_submission_jobs", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	deal_id: text().notNull(),
	funder_id: text().notNull(),
	display_funder_name: text().notNull(),
	route_kind: text().notNull(),
	route_json: text().notNull(),
	state: text().notNull(),
	confirmation_key: text().notNull(),
	attempt_key: text().notNull(),
	analysis_run_id: text(),
	deal_version: integer().notNull(),
	document_versions_json: text().notNull(),
	package_json: text().notNull(),
	preflight_errors_json: text().notNull(),
	reason: text(),
	created_by_user_id: text(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_submission_jobs_deal_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	index("mca_submission_jobs_funder_idx").using("btree", table.workspace_id.asc().nullsLast(), table.deal_id.asc().nullsLast(), table.funder_id.asc().nullsLast()),
	unique("mca_submission_jobs_confirmation_key").on(table.workspace_id, table.confirmation_key, table.funder_id),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_submission_jobs_workspace_id_fkey",
	}),
	foreignKey({
		columns: [table.deal_id],
		foreignColumns: [deals.id],
		name: "mca_submission_jobs_deal_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.funder_id],
		foreignColumns: [mca_funders.id],
		name: "mca_submission_jobs_funder_id_fkey",
	}),
	check("mca_submission_jobs_route_kind_check", sql`route_kind = ANY (ARRAY['email'::text, 'api'::text, 'manual_portal'::text, 'custom_webhook'::text])`),
	check("mca_submission_jobs_state_check", sql`state = ANY (ARRAY['preflight_failed'::text, 'queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'pending_portal'::text, 'blocked_duplicate'::text])`),
]);

export const mca_submission_attempts = pgTable("mca_submission_attempts", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	job_id: text().notNull(),
	attempt_key: text().notNull(),
	transport: text().notNull(),
	state: text().notNull(),
	correlation_id: text().notNull(),
	external_ref: text(),
	error_code: text(),
	error_message: text(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_submission_attempts_job_idx").using("btree", table.job_id.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	unique("mca_submission_attempts_job_attempt_key").on(table.job_id, table.attempt_key),
	foreignKey({
		columns: [table.job_id],
		foreignColumns: [mca_submission_jobs.id],
		name: "mca_submission_attempts_job_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_submission_attempts_workspace_id_fkey",
	}),
	check("mca_submission_attempts_state_check", sql`state = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])`),
]);

export const mca_submission_outbox = pgTable("mca_submission_outbox", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	job_id: text().notNull(),
	payload_json: text().notNull(),
	available_at: text().notNull(),
	attempts: integer().default(0).notNull(),
	processed_at: text(),
	last_error: text(),
	created_at: text().notNull(),
}, (table) => [
	index("mca_submission_outbox_available_idx").using("btree", table.available_at.asc().nullsLast(), table.processed_at.asc().nullsLast()),
	unique("mca_submission_outbox_job_id_key").on(table.job_id),
	foreignKey({
		columns: [table.job_id],
		foreignColumns: [mca_submission_jobs.id],
		name: "mca_submission_outbox_job_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_submission_outbox_workspace_id_fkey",
	}),
]);

export const mca_adapter_credentials = pgTable("mca_adapter_credentials", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	funder_id: text().notNull(),
	adapter_slug: text().notNull(),
	environment: text().notNull(),
	credential_cipher: text(),
	capabilities_json: text().notNull(),
	active: integer().default(1).notNull(),
	updated_by_user_id: text(),
	updated_at: text().notNull(),
}, (table) => [
	unique("mca_adapter_credentials_scope_key").on(table.workspace_id, table.funder_id, table.environment),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_adapter_credentials_workspace_id_fkey",
	}),
	foreignKey({
		columns: [table.funder_id],
		foreignColumns: [mca_funders.id],
		name: "mca_adapter_credentials_funder_id_fkey",
	}),
	check("mca_adapter_credentials_environment_check", sql`environment = ANY (ARRAY['development'::text, 'production'::text])`),
]);

export const mca_outgoing_derivatives = pgTable("mca_outgoing_derivatives", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	original_document_id: text().notNull(),
	funder_id: text().notNull(),
	job_id: text(),
	stage: text().notNull(),
	document_id: text().notNull(),
	original_checksum: text().notNull(),
	output_checksum: text().notNull(),
	template_version: integer().default(1).notNull(),
	byte_length: integer().notNull(),
	created_at: text().notNull(),
}, (table) => [
	unique("mca_outgoing_derivatives_identity_key").on(table.original_document_id, table.funder_id, table.stage, table.template_version),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_outgoing_derivatives_workspace_id_fkey",
	}),
	foreignKey({
		columns: [table.original_document_id],
		foreignColumns: [mca_documents.id],
		name: "mca_outgoing_derivatives_original_document_id_fkey",
	}),
	check("mca_outgoing_derivatives_stage_check", sql`stage = ANY (ARRAY['stamp'::text, 'watermark'::text, 'compress'::text])`),
]);

export const mca_funder_replies = pgTable("mca_funder_replies", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	sender_id: text().notNull(),
	provider_message_id: text().notNull(),
	thread_id: text(),
	from_address: text().notNull(),
	subject: text(),
	body_cipher: text(),
	matched_deal_id: text(),
	matched_job_id: text(),
	match_evidence: text(),
	state: text().notNull(),
	created_at: text().notNull(),
	updated_at: text().notNull(),
}, (table) => [
	unique("mca_funder_replies_provider_message_key").on(table.workspace_id, table.sender_id, table.provider_message_id),
	index("mca_funder_replies_state_idx").using("btree", table.workspace_id.asc().nullsLast(), table.state.asc().nullsLast(), table.created_at.desc().nullsFirst()),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_funder_replies_workspace_id_fkey",
	}),
	foreignKey({
		columns: [table.sender_id],
		foreignColumns: [mca_email_senders.id],
		name: "mca_funder_replies_sender_id_fkey",
	}),
	check("mca_funder_replies_state_check", sql`state = ANY (ARRAY['pending_review'::text, 'matched'::text, 'ignored'::text, 'processed'::text])`),
]);

export const mca_submission_templates = pgTable("mca_submission_templates", {
	id: text().primaryKey().notNull(),
	workspace_id: text().notNull(),
	funder_id: text(),
	subject_template: text().notNull(),
	body_template: text().notNull(),
	prefix: text(),
	cc_originator: integer().default(0).notNull(),
	cc_closer: integer().default(0).notNull(),
	updated_by_user_id: text(),
	updated_at: text().notNull(),
}, (table) => [
	index("mca_submission_templates_workspace_idx").using("btree", table.workspace_id.asc().nullsLast(), table.funder_id.asc().nullsLast()),
	foreignKey({
		columns: [table.workspace_id],
		foreignColumns: [workspaces.id],
		name: "mca_submission_templates_workspace_id_fkey",
	}),
]);

export const mca_stamp_settings = pgTable("mca_stamp_settings", {
	workspace_id: text().primaryKey().notNull(),
	enabled: integer().default(0).notNull(),
	exclusions_json: text().default('[]').notNull(),
	template_version: integer().default(1).notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const mca_watermark_settings = pgTable("mca_watermark_settings", {
	workspace_id: text().primaryKey().notNull(),
	enabled: integer().default(0).notNull(),
	logo_document_id: text(),
	exclusions_json: text().default('[]').notNull(),
	template_version: integer().default(1).notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const mca_compress_settings = pgTable("mca_compress_settings", {
	workspace_id: text().primaryKey().notNull(),
	automatic_email: integer().default(0).notNull(),
	max_payload_bytes: integer().default(25000000).notNull(),
	exclusions_json: text().default('[]').notNull(),
	updated_at: text().notNull(),
	updated_by_user_id: text(),
});

export const clerkWebhookEvents = pgTable("clerk_webhook_events", {
  id: text().primaryKey().notNull(),
  event_type: text().notNull(),
  processed_at: text().notNull(),
});

// Private assistant state. Content and SDK state use workspace-bound encryption.
export const mcaAssistantConversations = pgTable("mca_assistant_conversations", {
  id: text().primaryKey(), workspace_id: text().notNull(), user_id: text().notNull(), deal_id: text(), created_at: text().notNull(),
}, t => [uniqueIndex("assistant_conversation_owner").on(t.workspace_id,t.user_id,t.deal_id)]);
export const mcaAssistantMessages = pgTable("mca_assistant_messages", {
  id: text().primaryKey(), conversation_id: text().notNull().references(()=>mcaAssistantConversations.id,{onDelete:"cascade"}),
  sequence: bigserial({mode:"number"}).notNull(), role: text().notNull(), content_cipher: text().notNull(), created_at: text().notNull(),
}, t => [index("assistant_message_history").on(t.conversation_id,t.sequence)]);
export const mcaAssistantRuns = pgTable("mca_assistant_runs", {
  id: text().primaryKey(), conversation_id: text().notNull().references(()=>mcaAssistantConversations.id,{onDelete:"cascade"}),
  request_id: text().notNull(), selected_deal_id: text(), mutation_deal_id: text(), model_turns: integer().default(0).notNull(), status: text().notNull(), state_cipher: text(), error: text(), usage_json: text(), created_at: text().notNull(), expires_at: text().notNull(),
}, t => [uniqueIndex("assistant_request_once").on(t.conversation_id,t.request_id),
  uniqueIndex("assistant_one_active_run").on(t.conversation_id).where(sql`${t.status} IN ('running','awaiting_approval','awaiting_input')`)]);
export const mcaAssistantApprovals = pgTable("mca_assistant_approvals", {
  id: text().primaryKey(), run_id: text().notNull().references(()=>mcaAssistantRuns.id,{onDelete:"cascade"}), kind: text().notNull(), status: text().notNull(),
  payload_cipher: text().notNull(), preview_cipher: text().notNull(), fingerprint: text().notNull(), call_id: text(), result_cipher: text(), created_at: text().notNull(),
}, t => [index("assistant_run_approvals").on(t.run_id)]);
export const mcaAssistantExecutions = pgTable("mca_assistant_executions", {
  id: text().primaryKey(), run_id: text().notNull().references(()=>mcaAssistantRuns.id,{onDelete:"cascade"}), tool_name: text().notNull(), status: text().notNull(),
  result_cipher: text(), created_at: text().notNull(), completed_at: text(),
}, t => [index("assistant_run_executions").on(t.run_id)]);

export const intake_processing = pgTable("intake_processing", {
  intake_id: text().primaryKey().references(() => intake_events.id),
  workspace_id: text().notNull().references(() => workspaces.id),
  fingerprint: text(), generation: integer().default(0).notNull(),
  job_id: text(), progress_json: text().default('{}').notNull(),
  checked_at: text().notNull(), updated_at: text().notNull(),
}, table => [index("intake_processing_workspace_idx").on(table.workspace_id)]);

// Client invitation attribution remains independent of mutable deal assignments.
export const applicationInvitations = pgTable("mca_application_invitations", {
  id: text().primaryKey(), workspace_id: text().notNull().references(() => workspaces.id),
  integration_id: text().notNull().references(() => intake_integrations.id),
  form_id: text().notNull(),
  membership_id: text().notNull().references(() => memberships.id),
  client_name: text().notNull(), email_cipher: text().notNull(), token_hash: text().notNull().unique(), token_cipher: text().notNull(), request_key: text().notNull(),
  created_at: text().notNull(), expires_at: text().notNull(), revoked_at: text(), copied_at: text(), sent_at: text(), opened_at: text(), started_at: text(), submitted_at: text(),
  submission_event_id: text(), intake_id: text().references(() => intake_events.id), deal_id: text().references(() => deals.id),
}, t => [unique().on(t.workspace_id,t.membership_id,t.request_key), unique().on(t.workspace_id,t.integration_id,t.submission_event_id), unique().on(t.workspace_id,t.deal_id),
  index("application_invitation_cohort_idx").on(t.workspace_id,t.created_at,t.membership_id)]);
export const applicationInvitationEvents = pgTable("mca_application_invitation_events", {
  invitation_id: text().notNull().references(() => applicationInvitations.id), workspace_id: text().notNull().references(() => workspaces.id),
  kind: text().notNull(), occurred_at: text().notNull(),
}, t => [primaryKey({columns:[t.invitation_id,t.kind]}),check("mca_application_invitation_events_kind_check",sql`kind IN ('opened','started')`)]);
export const applicationInvitationDeliveries = pgTable("mca_application_invitation_deliveries", {
  id: text().primaryKey(), invitation_id: text().notNull().references(() => applicationInvitations.id), workspace_id: text().notNull().references(() => workspaces.id),
  request_key: text().notNull(), job_id: text(), delivery: text(), created_at: text().notNull(), accepted_at: text(),
}, t => [unique().on(t.invitation_id,t.request_key), index("application_invitation_delivery_idx").on(t.workspace_id,t.invitation_id,t.created_at),
  check("mca_application_invitation_deliveries_delivery_check",sql`delivery IN ('sent','preview')`)]);
