CREATE TABLE "mca_accounting_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_accounting_adjustments_correlation_key" UNIQUE("workspace_id","payment_id","correlation_id"),
	CONSTRAINT "mca_accounting_adjustments_nonzero_check" CHECK ("mca_accounting_adjustments"."amount_cents" <> 0)
);
--> statement-breakpoint
CREATE TABLE "mca_accounting_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"advance_id" text NOT NULL,
	"funding_event_id" text,
	"type" text NOT NULL,
	"origin" text NOT NULL,
	"originator_membership_id" text,
	"expected_amount_cents" integer NOT NULL,
	"received_amount_cents" integer DEFAULT 0 NOT NULL,
	"expected_at" text,
	"received_at" text,
	"status" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_accounting_payments_idempotency_key" UNIQUE("workspace_id","advance_id","type","idempotency_key"),
	CONSTRAINT "mca_accounting_payments_type_check" CHECK ("mca_accounting_payments"."type" in ('commission','fee')),
	CONSTRAINT "mca_accounting_payments_origin_check" CHECK ("mca_accounting_payments"."origin" in ('automatic','manual','historical')),
	CONSTRAINT "mca_accounting_payments_status_check" CHECK ("mca_accounting_payments"."status" in ('expected','partial','received','void')),
	CONSTRAINT "mca_accounting_payments_amounts_check" CHECK ("mca_accounting_payments"."expected_amount_cents" >= 0 and "mca_accounting_payments"."received_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mca_advance_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"advance_id" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"effective_at" text NOT NULL,
	"actor_user_id" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_advance_status_history_correlation_key" UNIQUE("workspace_id","advance_id","correlation_id"),
	CONSTRAINT "mca_advance_status_history_status_check" CHECK ("mca_advance_status_history"."status" in ('on_track','missed_payment','default','renewed','closed'))
);
--> statement-breakpoint
CREATE TABLE "mca_payment_distributions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"recipient_membership_id" text NOT NULL,
	"template_id" text,
	"template_version" integer,
	"percentage_basis_points" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"expected_at" text,
	"paid_at" text,
	"snapshot_json" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_payment_distributions_idempotency_key" UNIQUE("workspace_id","payment_id","recipient_membership_id","idempotency_key"),
	CONSTRAINT "mca_payment_distributions_percent_check" CHECK ("mca_payment_distributions"."percentage_basis_points" > 0 and "mca_payment_distributions"."percentage_basis_points" <= 10000),
	CONSTRAINT "mca_payment_distributions_amount_check" CHECK ("mca_payment_distributions"."amount_cents" >= 0),
	CONSTRAINT "mca_payment_distributions_status_check" CHECK ("mca_payment_distributions"."status" in ('expected','paid','void'))
);
--> statement-breakpoint
CREATE TABLE "mca_renewal_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_advance_id" text NOT NULL,
	"renewed_deal_id" text,
	"policy_version" integer NOT NULL,
	"eligible_at" text NOT NULL,
	"state" text NOT NULL,
	"message_subject" text NOT NULL,
	"message_body" text NOT NULL,
	"documentation_requested_at" text,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_renewal_actions_idempotency_key" UNIQUE("workspace_id","source_advance_id","idempotency_key"),
	CONSTRAINT "mca_renewal_actions_state_check" CHECK ("mca_renewal_actions"."state" in ('eligible','contacted','documents_requested','converted','dismissed'))
);
--> statement-breakpoint
CREATE TABLE "mca_renewal_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"paid_in_threshold_basis_points" integer NOT NULL,
	"minimum_days_since_funding" integer DEFAULT 0 NOT NULL,
	"version" integer NOT NULL,
	"updated_by_user_id" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_renewal_policies_threshold_check" CHECK ("mca_renewal_policies"."paid_in_threshold_basis_points" between 0 and 10000),
	CONSTRAINT "mca_renewal_policies_days_check" CHECK ("mca_renewal_policies"."minimum_days_since_funding" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mca_split_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"allocation_json" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_split_template_versions_key" UNIQUE("workspace_id","template_id","version"),
	CONSTRAINT "mca_split_template_versions_version_check" CHECK ("mca_split_template_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "mca_split_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"active_version" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_split_templates_name_key" UNIQUE("workspace_id","name"),
	CONSTRAINT "mca_split_templates_version_check" CHECK ("mca_split_templates"."active_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "mca_closing_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"kind" text NOT NULL,
	"record_id" text NOT NULL,
	"attempt_key" text NOT NULL,
	"channel" text NOT NULL,
	"state" text NOT NULL,
	"recipient_cipher" text,
	"payload_hash" text NOT NULL,
	"correlation_id" text NOT NULL,
	"external_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_closing_deliveries_attempt_key" UNIQUE("workspace_id","kind","record_id","attempt_key"),
	CONSTRAINT "mca_closing_deliveries_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'sent'::text, 'preview'::text, 'failed'::text, 'blocked'::text])),
	CONSTRAINT "mca_closing_deliveries_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text, 'webhook'::text, 'phone'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_closing_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"kind" text NOT NULL,
	"record_id" text NOT NULL,
	"channel" text NOT NULL,
	"sender_id" text,
	"recipient_cipher" text NOT NULL,
	"subject_cipher" text,
	"body_cipher" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'preview' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_closing_previews_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_closing_previews_kind_check" CHECK (kind = ANY (ARRAY['stipulation_request'::text, 'contract_request'::text, 'repricing_request'::text])),
	CONSTRAINT "mca_closing_previews_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text])),
	CONSTRAINT "mca_closing_previews_state_check" CHECK (state = ANY (ARRAY['preview'::text, 'sent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_closing_stipulations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text,
	"offer_revision_id" text,
	"funder_id" text,
	"document_category" text NOT NULL,
	"label" text NOT NULL,
	"owner_membership_id" text,
	"due_date" text,
	"status" text NOT NULL,
	"linked_document_id" text,
	"exception_reason" text,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"received_at" text,
	"verified_at" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_closing_stips_identity_key" UNIQUE("workspace_id","deal_id","idempotency_key"),
	CONSTRAINT "mca_closing_stips_status_check" CHECK (status = ANY (ARRAY['open'::text, 'received'::text, 'verified'::text, 'waived'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_contract_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"offer_revision_number" integer NOT NULL,
	"funder_id" text,
	"funder_name" text NOT NULL,
	"state" text NOT NULL,
	"recipient_cipher" text,
	"attached_document_ids_json" text DEFAULT '[]' NOT NULL,
	"outstanding_stips_json" text DEFAULT '[]' NOT NULL,
	"accepted_at" text,
	"contract_requested_at" text,
	"contract_sent_at" text,
	"signed_at" text,
	"final_review_at" text,
	"repricing_requested_at" text,
	"signature_source" text,
	"signature_external_id" text,
	"signature_evidence_document_id" text,
	"manual_signature_reason" text,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_contract_workflows_revision_key" UNIQUE("workspace_id","deal_id","offer_revision_id"),
	CONSTRAINT "mca_contract_workflows_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_contract_workflows_state_check" CHECK (state = ANY (ARRAY['accepted'::text, 'contract_requested'::text, 'contract_sent'::text, 'repricing_requested'::text, 'signed'::text, 'final_review'::text])),
	CONSTRAINT "mca_contract_signature_source_check" CHECK (signature_source IS NULL OR signature_source = ANY (ARRAY['external'::text, 'manual'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_merchant_upload_links" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"stipulation_id" text,
	"token_hash" text NOT NULL,
	"destination_category" text NOT NULL,
	"expires_at" text NOT NULL,
	"max_uploads" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" text,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_merchant_upload_links_token_key" UNIQUE("token_hash"),
	CONSTRAINT "mca_merchant_upload_links_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_merchant_upload_links_counts_check" CHECK (max_uploads > 0 AND used_count >= 0 AND used_count <= max_uploads)
);
--> statement-breakpoint
CREATE TABLE "mca_offer_message_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"offer_revision_number" integer NOT NULL,
	"offer_revision_ids_json" text DEFAULT '[]' NOT NULL,
	"selection_mode" text NOT NULL,
	"channel" text NOT NULL,
	"sender_id" text,
	"recipient_cipher" text NOT NULL,
	"subject_cipher" text,
	"body_cipher" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_offer_message_previews_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_offer_message_previews_mode_check" CHECK (selection_mode = ANY (ARRAY['selected'::text, 'all'::text, 'highest'::text])),
	CONSTRAINT "mca_offer_message_previews_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text])),
	CONSTRAINT "mca_offer_message_previews_state_check" CHECK (state = ANY (ARRAY['preview'::text, 'sent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_pitch_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"message_preview_id" text,
	"channel" text NOT NULL,
	"transport_succeeded" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" text,
	"pitched_at" text NOT NULL,
	CONSTRAINT "mca_pitch_events_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_pitch_events_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text, 'phone'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_psf_config" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"visible_to_reps" integer DEFAULT 0 NOT NULL,
	"destination_cipher" text,
	"signing_secret_cipher" text,
	"updated_by_user_id" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_psf_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"offer_revision_number" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"bank_name_cipher" text NOT NULL,
	"routing_number_cipher" text NOT NULL,
	"account_number_cipher" text NOT NULL,
	"business_name_cipher" text NOT NULL,
	"contact_name_cipher" text NOT NULL,
	"contact_email_cipher" text NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"external_request_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"delivered_at" text,
	"signed_at" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_psf_requests_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_psf_requests_revision_key" UNIQUE("workspace_id","deal_id","offer_revision_id"),
	CONSTRAINT "mca_psf_requests_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text, 'signed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_advances" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"funding_event_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"funded_at" text NOT NULL,
	"principal_cents" integer NOT NULL,
	"payback_cents" integer,
	"periodic_payment_cents" integer,
	"payment_count" integer,
	"payment_frequency" text,
	"calendar_convention" text,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"expected_commission_at" text,
	"source" text NOT NULL,
	"calculation_snapshot_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"correction_of_advance_id" text,
	"reversed_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_advances_funding_event_key" UNIQUE("workspace_id","funding_event_id"),
	CONSTRAINT "mca_advances_offer_revision_key" UNIQUE("workspace_id","offer_revision_id"),
	CONSTRAINT "mca_advances_source_check" CHECK (source IN ('live','manual','historical')),
	CONSTRAINT "mca_advances_status_check" CHECK (status IN ('active','reversed','corrected')),
	CONSTRAINT "mca_advances_money_check" CHECK (principal_cents > 0 AND commission_cents >= 0 AND fee_cents >= 0 AND (payback_cents IS NULL OR payback_cents >= principal_cents) AND (periodic_payment_cents IS NULL OR periodic_payment_cents > 0) AND (payment_count IS NULL OR payment_count > 0))
);
--> statement-breakpoint
CREATE TABLE "mca_funding_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"advance_id" text NOT NULL,
	"manual_submission_id" text,
	"idempotency_key" text NOT NULL,
	"funded_at" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"commission_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"expected_commission_at" text,
	"splits_json" text DEFAULT '[]' NOT NULL,
	"accounting_record_ids_json" text DEFAULT '[]' NOT NULL,
	"source" text NOT NULL,
	"state" text DEFAULT 'committed' NOT NULL,
	"correction_of_event_id" text,
	"reversed_at" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_funding_events_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_funding_events_advance_id_key" UNIQUE("workspace_id","advance_id"),
	CONSTRAINT "mca_funding_events_source_check" CHECK (source IN ('live','manual','historical')),
	CONSTRAINT "mca_funding_events_state_check" CHECK (state IN ('committed','reversed','corrected'))
);
--> statement-breakpoint
CREATE TABLE "mca_historical_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text NOT NULL,
	"external_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"normalized_json" text NOT NULL,
	"validation_errors_json" text DEFAULT '[]' NOT NULL,
	"duplicate" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"funding_event_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_historical_import_rows_external_key" UNIQUE("workspace_id","external_id"),
	CONSTRAINT "mca_historical_import_rows_run_row_key" UNIQUE("run_id","row_number"),
	CONSTRAINT "mca_historical_import_rows_outcome_check" CHECK (outcome IN ('pending','created','duplicate','invalid'))
);
--> statement-breakpoint
CREATE TABLE "mca_historical_import_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"state" text NOT NULL,
	"preview_revision" integer DEFAULT 1 NOT NULL,
	"totals_json" text DEFAULT '{}' NOT NULL,
	"reconciliation_json" text DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"committed_at" text,
	CONSTRAINT "mca_historical_import_runs_batch_key" UNIQUE("workspace_id","source_id","batch_id"),
	CONSTRAINT "mca_historical_import_runs_state_check" CHECK (state IN ('preview','committed','failed'))
);
--> statement-breakpoint
CREATE TABLE "mca_manual_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"funder_id" text,
	"funder_name" text NOT NULL,
	"historical_at" text NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"offer_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_manual_submissions_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_manual_submissions_state_check" CHECK (state IN ('submitted','approved','funded')),
	CONSTRAINT "mca_manual_submissions_source_check" CHECK (source IN ('manual','historical'))
);
--> statement-breakpoint
CREATE TABLE "mca_offer_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"state" text NOT NULL,
	"product" text,
	"amount_cents" integer,
	"factor_rate_millionths" integer,
	"buy_rate_millionths" integer,
	"term_months" integer,
	"payment_amount_cents" integer,
	"payment_frequency" text,
	"fee_cents" integer,
	"commission_cents" integer,
	"stipulations_json" text DEFAULT '[]' NOT NULL,
	"incomplete_fields_json" text DEFAULT '[]' NOT NULL,
	"effective_at" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_offer_revisions_offer_number_key" UNIQUE("workspace_id","offer_id","revision_number"),
	CONSTRAINT "mca_offer_revisions_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "mca_offer_revisions_state_check" CHECK (state IN ('active','withdrawn','superseded','funded')),
	CONSTRAINT "mca_offer_revisions_amount_check" CHECK (amount_cents IS NULL OR amount_cents > 0),
	CONSTRAINT "mca_offer_revisions_money_check" CHECK ((payment_amount_cents IS NULL OR payment_amount_cents >= 0) AND (fee_cents IS NULL OR fee_cents >= 0) AND (commission_cents IS NULL OR commission_cents >= 0))
);
--> statement-breakpoint
CREATE TABLE "mca_offer_selections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"offer_id" text NOT NULL,
	"offer_revision_id" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"selected_by_user_id" text,
	"selected_at" text NOT NULL,
	"deselected_by_user_id" text,
	"deselected_at" text,
	"reason" text,
	CONSTRAINT "mca_offer_selections_active_check" CHECK (active IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "mca_offers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"submission_id" text,
	"funder_id" text,
	"funder_name" text NOT NULL,
	"source" text NOT NULL,
	"external_id" text,
	"current_revision_id" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_offers_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "mca_offers_source_check" CHECK (source IN ('api','email','link','manual','historical'))
);
--> statement-breakpoint
CREATE INDEX "mca_accounting_adjustments_payment_idx" ON "mca_accounting_adjustments" USING btree ("workspace_id","payment_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_accounting_payments_filter_idx" ON "mca_accounting_payments" USING btree ("workspace_id","status","expected_at");--> statement-breakpoint
CREATE INDEX "mca_accounting_payments_advance_idx" ON "mca_accounting_payments" USING btree ("workspace_id","advance_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_advance_status_history_advance_idx" ON "mca_advance_status_history" USING btree ("workspace_id","advance_id","effective_at");--> statement-breakpoint
CREATE INDEX "mca_payment_distributions_recipient_idx" ON "mca_payment_distributions" USING btree ("workspace_id","recipient_membership_id","status","expected_at");--> statement-breakpoint
CREATE INDEX "mca_renewal_actions_followup_idx" ON "mca_renewal_actions" USING btree ("workspace_id","state","eligible_at");--> statement-breakpoint
CREATE INDEX "mca_split_template_versions_template_idx" ON "mca_split_template_versions" USING btree ("workspace_id","template_id","version");--> statement-breakpoint
CREATE INDEX "mca_closing_deliveries_record_idx" ON "mca_closing_deliveries" USING btree ("workspace_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_closing_previews_record_idx" ON "mca_closing_previews" USING btree ("workspace_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_closing_stips_deal_idx" ON "mca_closing_stipulations" USING btree ("workspace_id","deal_id","status");--> statement-breakpoint
CREATE INDEX "mca_contract_workflows_deal_idx" ON "mca_contract_workflows" USING btree ("workspace_id","deal_id","updated_at");--> statement-breakpoint
CREATE INDEX "mca_merchant_upload_links_deal_idx" ON "mca_merchant_upload_links" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_offer_message_previews_deal_idx" ON "mca_offer_message_previews" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_pitch_events_deal_idx" ON "mca_pitch_events" USING btree ("workspace_id","deal_id","pitched_at");--> statement-breakpoint
CREATE INDEX "mca_psf_requests_deal_idx" ON "mca_psf_requests" USING btree ("workspace_id","deal_id","updated_at");--> statement-breakpoint
CREATE INDEX "mca_advances_deal_idx" ON "mca_advances" USING btree ("workspace_id","deal_id","funded_at");--> statement-breakpoint
CREATE INDEX "mca_funding_events_deal_idx" ON "mca_funding_events" USING btree ("workspace_id","deal_id","funded_at");--> statement-breakpoint
CREATE INDEX "mca_manual_submissions_deal_idx" ON "mca_manual_submissions" USING btree ("workspace_id","deal_id","historical_at");--> statement-breakpoint
CREATE INDEX "mca_offer_revisions_offer_idx" ON "mca_offer_revisions" USING btree ("workspace_id","offer_id","revision_number");--> statement-breakpoint
CREATE INDEX "mca_offer_selections_deal_idx" ON "mca_offer_selections" USING btree ("workspace_id","deal_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "mca_offer_selections_active_offer_unique" ON "mca_offer_selections" USING btree ("workspace_id","deal_id","offer_id") WHERE active = 1;--> statement-breakpoint
CREATE INDEX "mca_offers_deal_idx" ON "mca_offers" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mca_offers_external_unique" ON "mca_offers" USING btree ("workspace_id","source","external_id") WHERE external_id IS NOT NULL;