CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text NOT NULL,
	"expires_at" text,
	"last_used_at" text,
	"revoked_at" text,
	"rate_limit_per_minute" integer DEFAULT 60 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "api_keys_secret_hash_key" UNIQUE("secret_hash"),
	CONSTRAINT "api_keys_rate_limit_per_minute_check" CHECK ((rate_limit_per_minute >= 1) AND (rate_limit_per_minute <= 10000))
);
--> statement-breakpoint
CREATE TABLE "api_rate_windows" (
	"api_key_id" text NOT NULL,
	"bucket_start" integer NOT NULL,
	"request_count" integer NOT NULL,
	CONSTRAINT "api_rate_windows_pkey" PRIMARY KEY("api_key_id","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "audit_events_source_check" CHECK (source = ANY (ARRAY['user'::text, 'api_key'::text, 'system'::text]))
);
--> statement-breakpoint
CREATE TABLE "deal_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text,
	"source" text NOT NULL,
	"summary" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"record_version" integer NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"kind" text NOT NULL,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"assigned_at" text NOT NULL,
	"assigned_by_user_id" text,
	CONSTRAINT "deal_assignments_deal_id_membership_id_kind_key" UNIQUE("deal_id","kind","membership_id"),
	CONSTRAINT "deal_assignments_kind_check" CHECK (kind = ANY (ARRAY['originator'::text, 'closer'::text]))
);
--> statement-breakpoint
CREATE TABLE "deal_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"body" text NOT NULL,
	"actor_user_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_owners" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"ownership_percent" double precision,
	"is_primary" integer DEFAULT 0 NOT NULL,
	"date_of_birth_cipher" text,
	"identity_last4_cipher" text,
	"email_cipher" text,
	"phone_cipher" text
);
--> statement-breakpoint
CREATE TABLE "deal_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"funder_name" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"display_id" text NOT NULL,
	"legal_name" text,
	"dba_name" text,
	"ein_cipher" text,
	"entity_type" text,
	"address_json" text DEFAULT '{}' NOT NULL,
	"contact_name" text,
	"contact_email_cipher" text,
	"contact_phone_cipher" text,
	"start_date" text,
	"industry" text,
	"naics_code" text,
	"monthly_revenue" double precision,
	"fico_score" integer,
	"funding_purpose" text,
	"requested_amount" double precision,
	"status" text NOT NULL,
	"pipeline_version" integer DEFAULT 1 NOT NULL,
	"draft_state" text NOT NULL,
	"missing_required_json" text NOT NULL,
	"field_sources_json" text NOT NULL,
	"idempotency_key" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "deals_workspace_id_display_id_key" UNIQUE("display_id","workspace_id"),
	CONSTRAINT "deals_workspace_id_idempotency_key_key" UNIQUE("idempotency_key","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "drive_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"folder_name" text NOT NULL,
	"access_token_cipher" text NOT NULL,
	"refresh_token_cipher" text,
	"expires_at" text,
	"scope" text NOT NULL,
	"connected_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "drive_connections_workspace_id_key" UNIQUE("workspace_id")
);
--> statement-breakpoint
CREATE TABLE "drive_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_transfer_results" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"drive_file_id" text NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"message" text,
	"checksum" text,
	"byte_length" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "drive_transfer_results_run_id_drive_file_id_key" UNIQUE("drive_file_id","run_id")
);
--> statement-breakpoint
CREATE TABLE "import_archive_associations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"row_id" text NOT NULL,
	"archive_name" text NOT NULL,
	"entry_path" text NOT NULL,
	"category" text NOT NULL,
	"document_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "import_archive_associations_run_id_archive_name_entry_path_key" UNIQUE("archive_name","entry_path","run_id")
);
--> statement-breakpoint
CREATE TABLE "import_mapping_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"mapping_json" text NOT NULL,
	"originator_mapping_json" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "import_mapping_profiles_workspace_id_name_key" UNIQUE("name","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"application_json" text NOT NULL,
	"source_values_json" text NOT NULL,
	"assignment_membership_id" text,
	"errors_json" text NOT NULL,
	"warnings_json" text NOT NULL,
	"duplicate_ids_json" text NOT NULL,
	"originator_source_value_cipher" text,
	"duplicate_decision" text,
	"update_json" text,
	"state" text DEFAULT 'staged' NOT NULL,
	"deal_id" text,
	"message" text,
	"checkpoint" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "import_rows_run_id_row_number_key" UNIQUE("row_number","run_id"),
	CONSTRAINT "import_rows_duplicate_decision_check" CHECK (duplicate_decision = ANY (ARRAY['create'::text, 'skip'::text]))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"mode" text NOT NULL,
	"filename" text NOT NULL,
	"format" text NOT NULL,
	"state" text NOT NULL,
	"preview_revision" integer NOT NULL,
	"mapping_json" text NOT NULL,
	"confidence_json" text NOT NULL,
	"mapping_provider" text NOT NULL,
	"mapping_warnings_json" text NOT NULL,
	"assignment_pool_json" text NOT NULL,
	"cancellation_requested" integer DEFAULT 0 NOT NULL,
	"results_csv" text,
	"commit_token" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "import_runs_mode_check" CHECK (mode = ANY (ARRAY['create'::text, 'update'::text, 'drive'::text]))
);
--> statement-breakpoint
CREATE TABLE "import_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "import_sources_workspace_id_name_key" UNIQUE("name","workspace_id"),
	CONSTRAINT "import_sources_kind_check" CHECK (kind = ANY (ARRAY['spreadsheet'::text, 'drive'::text]))
);
--> statement-breakpoint
CREATE TABLE "intake_attachment_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"intake_id" text NOT NULL,
	"attachment_id" text NOT NULL,
	"source_url_cipher" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"category" text NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text,
	"document_id" text,
	"last_error" text,
	"lease_token" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "intake_attachment_jobs_intake_id_attachment_id_key" UNIQUE("attachment_id","intake_id"),
	CONSTRAINT "intake_attachment_jobs_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'fetching'::text, 'stored'::text, 'retryable'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "intake_attribution_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"integration_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "intake_attribution_tokens_integration_id_membership_id_key" UNIQUE("integration_id","membership_id"),
	CONSTRAINT "intake_attribution_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "intake_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"payload_checksum" text NOT NULL,
	"application_cipher" text NOT NULL,
	"source_reference" text,
	"initial_status" text,
	"state" text NOT NULL,
	"deal_id" text,
	"integration_id" text,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"error_code" text,
	"error_message" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "intake_events_workspace_id_provider_provider_event_id_key" UNIQUE("provider","provider_event_id","workspace_id"),
	CONSTRAINT "intake_events_state_check" CHECK (state = ANY (ARRAY['received'::text, 'validated'::text, 'created'::text, 'file_pending'::text, 'error'::text]))
);
--> statement-breakpoint
CREATE TABLE "intake_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"form_id" text,
	"template_id" text,
	"location_id" text,
	"admission_secret_hash" text,
	"signing_secret_cipher" text,
	"credential_cipher" text,
	"credential_expires_at" text,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"mapping_json" text DEFAULT '{}' NOT NULL,
	"allowed_hosts_json" text DEFAULT '[]' NOT NULL,
	"sender_rules_json" text DEFAULT '[]' NOT NULL,
	"assignment_pool_json" text DEFAULT '[]' NOT NULL,
	"initial_status" text DEFAULT 'lead' NOT NULL,
	"inbound_address" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"approval_state" text DEFAULT 'approved' NOT NULL,
	"contract_key" text,
	"attachment_method" text,
	"email_gateway" text,
	"provider_server_id" text,
	"provider_evidence_hash" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "intake_integrations_inbound_address_key" UNIQUE("inbound_address"),
	CONSTRAINT "intake_integrations_workspace_id_provider_form_id_key" UNIQUE("form_id","provider","workspace_id"),
	CONSTRAINT "intake_integrations_workspace_id_provider_location_id_key" UNIQUE("location_id","provider","workspace_id"),
	CONSTRAINT "intake_integrations_workspace_id_provider_template_id_key" UNIQUE("provider","template_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "intake_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"intake_id" text NOT NULL,
	"recipient_cipher" text NOT NULL,
	"deal_link_cipher" text,
	"add_document_link_cipher" text,
	"warnings_json" text DEFAULT '[]' NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"last_error" text,
	"lease_token" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "intake_receipts_intake_id_recipient_cipher_key" UNIQUE("intake_id","recipient_cipher"),
	CONSTRAINT "intake_receipts_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"status" text NOT NULL,
	"delivery_status" text NOT NULL,
	"delivery_correlation_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "invitations_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "invitations_delivery_status_check" CHECK (delivery_status = ANY (ARRAY['pending'::text, 'sent'::text, 'preview'::text, 'failed'::text])),
	CONSTRAINT "invitations_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'superseded'::text]))
);
--> statement-breakpoint
CREATE TABLE "lead_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "lead_batches_workspace_id_source_id_name_key" UNIQUE("name","source_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_application_confirmation_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"confirmation_id" text NOT NULL,
	"attempt_token" text,
	"lease_expires_at" text,
	"state" text NOT NULL,
	"deal_id" text,
	"source_document_id" text,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_application_confirmation__workspace_id_source_type_sour_key" UNIQUE("source_id","source_type","workspace_id"),
	CONSTRAINT "mca_application_confirmation_c_workspace_id_confirmation_id_key" UNIQUE("confirmation_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_application_extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"document_id" text NOT NULL,
	"document_version" integer NOT NULL,
	"extraction_version" integer NOT NULL,
	"fields" text NOT NULL,
	"evidence" text NOT NULL,
	"approved_fields" text DEFAULT '{}' NOT NULL,
	"warnings" text NOT NULL,
	"provider" text NOT NULL,
	"provider_request_id" text,
	"state" text NOT NULL,
	"confirmed_deal_id" text,
	"confirmation_id" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_application_extractions_workspace_id_confirmation_id_key" UNIQUE("confirmation_id","workspace_id"),
	CONSTRAINT "mca_application_extractions_workspace_id_document_id_extrac_key" UNIQUE("document_id","extraction_version","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_application_scan_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"checksum" text NOT NULL,
	"storage_key" text NOT NULL,
	"processing_state" text NOT NULL,
	"scan_provider" text,
	"scan_evidence" text,
	"extraction_version" integer DEFAULT 0 NOT NULL,
	"fields" text DEFAULT '{}' NOT NULL,
	"evidence" text DEFAULT '{}' NOT NULL,
	"approved_fields" text DEFAULT '{}' NOT NULL,
	"warnings" text DEFAULT '[]' NOT NULL,
	"extraction_provider" text,
	"provider_request_id" text,
	"state" text DEFAULT 'uploaded' NOT NULL,
	"confirmed_deal_id" text,
	"confirmation_id" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_application_scan_drafts_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "mca_application_scan_drafts_workspace_id_confirmation_id_key" UNIQUE("confirmation_id","workspace_id"),
	CONSTRAINT "mca_application_scan_drafts_workspace_id_idempotency_key_key" UNIQUE("idempotency_key","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_completeness_results" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"ready" integer NOT NULL,
	"version" integer NOT NULL,
	"rule_snapshot" text NOT NULL,
	"findings_json" text NOT NULL,
	"findings_fingerprint" text NOT NULL,
	"checked_at" text NOT NULL,
	CONSTRAINT "mca_completeness_results_workspace_id_deal_id_version_key" UNIQUE("deal_id","version","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_completeness_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"required_statement_months" integer NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "mca_completeness_settings_required_statement_months_check" CHECK ((required_statement_months >= 1) AND (required_statement_months <= 24))
);
--> statement-breakpoint
CREATE TABLE "mca_data_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"row_digest" text NOT NULL,
	"table_counts_json" text NOT NULL,
	"imported_at" text NOT NULL,
	CONSTRAINT "mca_data_migrations_snapshot_sha256_key" UNIQUE("snapshot_sha256")
);
--> statement-breakpoint
CREATE TABLE "mca_datamerch_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"deal_version" integer NOT NULL,
	"status" text NOT NULL,
	"correlation_id" text NOT NULL,
	"result_summary" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"query_kind" text,
	"result_cipher" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_datamerch_checks_workspace_id_deal_id_correlation_id_key" UNIQUE("correlation_id","deal_id","workspace_id"),
	CONSTRAINT "mca_datamerch_checks_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'no_result'::text, 'records'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_datamerch_config" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"credential_cipher" text,
	"credential_expires_at" text,
	"last_diagnostic" text,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "mca_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"display_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"checksum" text NOT NULL,
	"category" text NOT NULL,
	"lineage_id" text,
	"version" integer NOT NULL,
	"previous_document_id" text,
	"storage_key" text NOT NULL,
	"source" text NOT NULL,
	"source_reference" text,
	"processing_state" text NOT NULL,
	"scan_provider" text,
	"scan_evidence" text,
	"scan_attempted_at" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_documents_storage_key_key" UNIQUE("storage_key"),
	CONSTRAINT "mca_documents_workspace_id_idempotency_key_key" UNIQUE("idempotency_key","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_existing_positions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"document_id" text,
	"label" text NOT NULL,
	"estimated_payment" double precision,
	"evidence" text NOT NULL,
	"status" text NOT NULL,
	"corrected" integer DEFAULT 0 NOT NULL,
	"correction_reason" text,
	"corrected_by_user_id" text,
	"corrected_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_funder_criteria" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"field" text NOT NULL,
	"operator" text NOT NULL,
	"unit" text NOT NULL,
	"value_json" text,
	"source_text" text,
	"unspecified" integer DEFAULT 0 NOT NULL,
	"position" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_funder_criteria_meta" (
	"workspace_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"published_at" text NOT NULL,
	CONSTRAINT "mca_funder_criteria_meta_pkey" PRIMARY KEY("funder_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_funder_criteria_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"rules_json" text NOT NULL,
	"previous_rules_json" text DEFAULT '[]' NOT NULL,
	"warnings_json" text NOT NULL,
	"evidence_json" text NOT NULL,
	"ambiguous_json" text DEFAULT '[]' NOT NULL,
	"provider" text NOT NULL,
	"request_id" text,
	"rolled_back_at" text,
	"accepted_at" text,
	"rejected_at" text,
	"created_by" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_funder_criteria_scans_status_check" CHECK (status = ANY (ARRAY['proposed'::text, 'accepted'::text, 'rejected'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_funder_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"funder_ids" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_funder_groups_workspace_id_name_key" UNIQUE("name","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_funders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"legal_name" text NOT NULL,
	"nickname" text,
	"website" text,
	"domains" text DEFAULT '[]' NOT NULL,
	"products" text DEFAULT '[]' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"contacts" text DEFAULT '[]' NOT NULL,
	"routes" text DEFAULT '[]' NOT NULL,
	"criteria_version" integer DEFAULT 1 NOT NULL,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_funders_workspace_id_idempotency_key_key" UNIQUE("idempotency_key","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_industry_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"alias" text NOT NULL,
	"naics" text,
	"normalized_industry" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_industry_aliases_workspace_id_alias_key" UNIQUE("alias","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_pdf_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"authorized_by" text,
	"merchant_name" text NOT NULL,
	"authorization_reference" text NOT NULL,
	"recorded_at" text NOT NULL,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "mca_pdf_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"document_id" text NOT NULL,
	"deal_version" integer NOT NULL,
	"contact_mode" text NOT NULL,
	"signed_on_behalf" integer NOT NULL,
	"authorization_id" text,
	"generated_by" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_pdf_generations_workspace_id_idempotency_key_key" UNIQUE("idempotency_key","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_readiness_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"completeness_version" integer NOT NULL,
	"ready" integer NOT NULL,
	"findings_fingerprint" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_score_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"underwriting_version" integer NOT NULL,
	"completeness_version" integer NOT NULL,
	"deal_version" integer NOT NULL,
	"criteria_versions" text NOT NULL,
	"mode" text NOT NULL,
	"top_n" integer NOT NULL,
	"scores_json" text NOT NULL,
	"stale" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_statement_months" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"document_id" text NOT NULL,
	"account_kind" text NOT NULL,
	"period" text NOT NULL,
	"account_suffix" text,
	"deposits" text NOT NULL,
	"deposit_count" text NOT NULL,
	"average_daily_balance" text NOT NULL,
	"nsf_count" text NOT NULL,
	"negative_days" text NOT NULL,
	"ending_balance" text NOT NULL,
	"duplicate_of_id" text,
	"extraction_version" integer NOT NULL,
	"corrected" integer DEFAULT 0 NOT NULL,
	"correction_reason" text,
	"corrected_by_user_id" text,
	"corrected_at" text,
	"original_extraction" text DEFAULT '{}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_statement_months_workspace_id_document_id_key" UNIQUE("document_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "mca_underwriting_aggregates" (
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"version" integer NOT NULL,
	"monthly_revenue" text NOT NULL,
	"average_daily_balance" text NOT NULL,
	"nsf_count" text NOT NULL,
	"negative_days" text NOT NULL,
	"position_count" integer NOT NULL,
	"stale" integer NOT NULL,
	"source_fingerprint" text NOT NULL,
	"computed_at" text NOT NULL,
	CONSTRAINT "mca_underwriting_aggregates_pkey" PRIMARY KEY("deal_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"manager_membership_id" text,
	"status" text NOT NULL,
	"sender_association" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_key" UNIQUE("user_id","workspace_id"),
	CONSTRAINT "memberships_role_check" CHECK (role = ANY (ARRAY['rep'::text, 'manager'::text, 'admin'::text, 'super_admin'::text])),
	CONSTRAINT "memberships_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'deactivated'::text]))
);
--> statement-breakpoint
CREATE TABLE "recovery_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "recovery_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "request_rate_windows" (
	"rate_key" text NOT NULL,
	"bucket_start" integer NOT NULL,
	"request_count" integer NOT NULL,
	CONSTRAINT "request_rate_windows_pkey" PRIMARY KEY("bucket_start","rate_key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text NOT NULL,
	"phone" text,
	"application_identifier" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "users_application_identifier_key" UNIQUE("application_identifier"),
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"logo_url" text,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"seat_limit" integer DEFAULT 5 NOT NULL,
	"feature_flags" text NOT NULL,
	"page_visibility" text NOT NULL,
	"action_visibility" text DEFAULT '{"createDeal":true,"exportDeals":true,"inviteUsers":true,"manageApiKeys":true,"viewPaymentTable":true,"viewCompanyFinancials":true}' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "workspaces_seat_limit_check" CHECK (seat_limit > 0)
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_rate_windows" ADD CONSTRAINT "api_rate_windows_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_activity" ADD CONSTRAINT "deal_activity_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_activity" ADD CONSTRAINT "deal_activity_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_assignments" ADD CONSTRAINT "deal_assignments_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_assignments" ADD CONSTRAINT "deal_assignments_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_assignments" ADD CONSTRAINT "deal_assignments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_notes" ADD CONSTRAINT "deal_notes_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_notes" ADD CONSTRAINT "deal_notes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD CONSTRAINT "deal_offers_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD CONSTRAINT "deal_offers_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."deal_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD CONSTRAINT "deal_offers_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_owners" ADD CONSTRAINT "deal_owners_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_owners" ADD CONSTRAINT "deal_owners_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_submissions" ADD CONSTRAINT "deal_submissions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_submissions" ADD CONSTRAINT "deal_submissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_connections" ADD CONSTRAINT "drive_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_oauth_states" ADD CONSTRAINT "drive_oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_transfer_results" ADD CONSTRAINT "drive_transfer_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_transfer_results" ADD CONSTRAINT "drive_transfer_results_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_archive_associations" ADD CONSTRAINT "import_archive_associations_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "public"."import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_archive_associations" ADD CONSTRAINT "import_archive_associations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_archive_associations" ADD CONSTRAINT "import_archive_associations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mapping_profiles" ADD CONSTRAINT "import_mapping_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."lead_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."import_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_sources" ADD CONSTRAINT "import_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_attachment_jobs" ADD CONSTRAINT "intake_attachment_jobs_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "public"."intake_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_attachment_jobs" ADD CONSTRAINT "intake_attachment_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_attribution_tokens" ADD CONSTRAINT "intake_attribution_tokens_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."intake_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_attribution_tokens" ADD CONSTRAINT "intake_attribution_tokens_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_attribution_tokens" ADD CONSTRAINT "intake_attribution_tokens_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "public"."intake_integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_events" ADD CONSTRAINT "intake_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_integrations" ADD CONSTRAINT "intake_integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_receipts" ADD CONSTRAINT "intake_receipts_intake_id_fkey" FOREIGN KEY ("intake_id") REFERENCES "public"."intake_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_receipts" ADD CONSTRAINT "intake_receipts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_batches" ADD CONSTRAINT "lead_batches_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."import_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_batches" ADD CONSTRAINT "lead_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_manager_membership_id_fkey" FOREIGN KEY ("manager_membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_tokens" ADD CONSTRAINT "recovery_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_workspace_idx" ON "api_keys" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_workspace_idx" ON "audit_events" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "deal_activity_scope_idx" ON "deal_activity" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "deal_assignments_scope_idx" ON "deal_assignments" USING btree ("workspace_id","membership_id","kind","deal_id");--> statement-breakpoint
CREATE INDEX "deal_notes_scope_idx" ON "deal_notes" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "deal_offers_scope_idx" ON "deal_offers" USING btree ("workspace_id","deal_id");--> statement-breakpoint
CREATE INDEX "deal_owners_scope_idx" ON "deal_owners" USING btree ("workspace_id","deal_id");--> statement-breakpoint
CREATE INDEX "deal_submissions_scope_idx" ON "deal_submissions" USING btree ("workspace_id","deal_id","funder_name");--> statement-breakpoint
CREATE INDEX "deals_workspace_status_idx" ON "deals" USING btree ("workspace_id","status","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "import_rows_run_idx" ON "import_rows" USING btree ("workspace_id","run_id","row_number");--> statement-breakpoint
CREATE INDEX "import_runs_workspace_idx" ON "import_runs" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "intake_attachment_jobs_due_idx" ON "intake_attachment_jobs" USING btree ("state","next_attempt_at","updated_at");--> statement-breakpoint
CREATE INDEX "intake_events_workspace_state_idx" ON "intake_events" USING btree ("workspace_id","state","updated_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "intake_integrations_lookup_idx" ON "intake_integrations" USING btree ("provider","form_id","template_id","location_id","enabled");--> statement-breakpoint
CREATE INDEX "invitations_membership_idx" ON "invitations" USING btree ("membership_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_application_extractions_document_idx" ON "mca_application_extractions" USING btree ("workspace_id","document_id","extraction_version" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_application_scan_drafts_workspace_idx" ON "mca_application_scan_drafts" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_completeness_results_deal_idx" ON "mca_completeness_results" USING btree ("workspace_id","deal_id","version" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_datamerch_checks_deal_idx" ON "mca_datamerch_checks" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_documents_deal_idx" ON "mca_documents" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "mca_documents_lineage_version_idx" ON "mca_documents" USING btree ("workspace_id","lineage_id","version");--> statement-breakpoint
CREATE INDEX "mca_existing_positions_deal_idx" ON "mca_existing_positions" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_funder_criteria_funder_idx" ON "mca_funder_criteria" USING btree ("workspace_id","funder_id","position");--> statement-breakpoint
CREATE INDEX "mca_funder_criteria_scans_funder_idx" ON "mca_funder_criteria_scans" USING btree ("workspace_id","funder_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "mca_funder_criteria_scans_proposed_doc_idx" ON "mca_funder_criteria_scans" USING btree ("workspace_id","funder_id","document_id") WHERE status = 'proposed';--> statement-breakpoint
CREATE INDEX "mca_funder_groups_name_lower_idx" ON "mca_funder_groups" USING btree (workspace_id,lower(name));--> statement-breakpoint
CREATE INDEX "mca_funder_groups_workspace_idx" ON "mca_funder_groups" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "mca_funders_legal_name_lower_idx" ON "mca_funders" USING btree (workspace_id,lower(legal_name));--> statement-breakpoint
CREATE INDEX "mca_funders_workspace_idx" ON "mca_funders" USING btree ("workspace_id","legal_name");--> statement-breakpoint
CREATE UNIQUE INDEX "mca_industry_aliases_lower_unique" ON "mca_industry_aliases" USING btree (workspace_id,lower(alias));--> statement-breakpoint
CREATE INDEX "mca_industry_aliases_workspace_idx" ON "mca_industry_aliases" USING btree ("workspace_id","alias");--> statement-breakpoint
CREATE INDEX "mca_pdf_authorizations_deal_idx" ON "mca_pdf_authorizations" USING btree ("workspace_id","deal_id","recorded_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_readiness_events_deal_idx" ON "mca_readiness_events" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_score_snapshots_deal_idx" ON "mca_score_snapshots" USING btree ("workspace_id","deal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mca_statement_months_deal_idx" ON "mca_statement_months" USING btree ("workspace_id","deal_id","period");--> statement-breakpoint
CREATE INDEX "memberships_manager_idx" ON "memberships" USING btree ("workspace_id","manager_membership_id");--> statement-breakpoint
CREATE INDEX "memberships_workspace_status_idx" ON "memberships" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower(email));