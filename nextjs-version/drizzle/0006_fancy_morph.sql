CREATE TABLE "mca_adapter_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"adapter_slug" text NOT NULL,
	"environment" text NOT NULL,
	"credential_cipher" text,
	"capabilities_json" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_adapter_credentials_scope_key" UNIQUE("workspace_id","funder_id","environment"),
	CONSTRAINT "mca_adapter_credentials_environment_check" CHECK (environment = ANY (ARRAY['development'::text, 'production'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_compress_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"automatic_email" integer DEFAULT 0 NOT NULL,
	"max_payload_bytes" integer DEFAULT 25000000 NOT NULL,
	"exclusions_json" text DEFAULT '[]' NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "mca_email_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"sender_id" text,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_email_sender_members" (
	"sender_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_email_sender_members_sender_id_membership_id_pk" PRIMARY KEY("sender_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "mca_email_senders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"purpose" text NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"signature" text,
	"credential_cipher" text,
	"state" text NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"verified_at" text,
	"last_error" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_email_senders_provider_check" CHECK (provider = ANY (ARRAY['google'::text, 'microsoft'::text, 'smtp'::text, 'sendgrid'::text])),
	CONSTRAINT "mca_email_senders_purpose_check" CHECK (purpose = ANY (ARRAY['merchant'::text, 'submission'::text, 'fallback'::text])),
	CONSTRAINT "mca_email_senders_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'verified'::text, 'expired'::text, 'revoked'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_funder_replies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"thread_id" text,
	"from_address" text NOT NULL,
	"subject" text,
	"body_cipher" text,
	"matched_deal_id" text,
	"matched_job_id" text,
	"match_evidence" text,
	"state" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_funder_replies_provider_message_key" UNIQUE("workspace_id","sender_id","provider_message_id"),
	CONSTRAINT "mca_funder_replies_state_check" CHECK (state = ANY (ARRAY['pending_review'::text, 'matched'::text, 'ignored'::text, 'processed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_outgoing_derivatives" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"original_document_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"job_id" text,
	"stage" text NOT NULL,
	"document_id" text NOT NULL,
	"original_checksum" text NOT NULL,
	"output_checksum" text NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_outgoing_derivatives_identity_key" UNIQUE("original_document_id","funder_id","stage","template_version"),
	CONSTRAINT "mca_outgoing_derivatives_stage_check" CHECK (stage = ANY (ARRAY['stamp'::text, 'watermark'::text, 'compress'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_stamp_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"exclusions_json" text DEFAULT '[]' NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE TABLE "mca_submission_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"attempt_key" text NOT NULL,
	"transport" text NOT NULL,
	"state" text NOT NULL,
	"correlation_id" text NOT NULL,
	"external_ref" text,
	"error_code" text,
	"error_message" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_submission_attempts_job_attempt_key" UNIQUE("job_id","attempt_key"),
	CONSTRAINT "mca_submission_attempts_state_check" CHECK (state = ANY (ARRAY['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_submission_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"funder_id" text NOT NULL,
	"display_funder_name" text NOT NULL,
	"route_kind" text NOT NULL,
	"route_json" text NOT NULL,
	"state" text NOT NULL,
	"confirmation_key" text NOT NULL,
	"attempt_key" text NOT NULL,
	"analysis_run_id" text,
	"deal_version" integer NOT NULL,
	"document_versions_json" text NOT NULL,
	"package_json" text NOT NULL,
	"preflight_errors_json" text NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_submission_jobs_confirmation_key" UNIQUE("workspace_id","confirmation_key","funder_id"),
	CONSTRAINT "mca_submission_jobs_route_kind_check" CHECK (route_kind = ANY (ARRAY['email'::text, 'api'::text, 'manual_portal'::text, 'custom_webhook'::text])),
	CONSTRAINT "mca_submission_jobs_state_check" CHECK (state = ANY (ARRAY['preflight_failed'::text, 'queued'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text, 'pending_portal'::text, 'blocked_duplicate'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_submission_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"payload_json" text NOT NULL,
	"available_at" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_submission_outbox_job_id_key" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "mca_submission_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"funder_id" text,
	"subject_template" text NOT NULL,
	"body_template" text NOT NULL,
	"prefix" text,
	"cc_originator" integer DEFAULT 0 NOT NULL,
	"cc_closer" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_watermark_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"logo_document_id" text,
	"exclusions_json" text DEFAULT '[]' NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "amount" double precision;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "rate" double precision;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "term" integer;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "frequency" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "commission" double precision;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "fees_json" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "offer_link" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "raw_status" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "evidence_json" text;--> statement-breakpoint
ALTER TABLE "deal_offers" ADD COLUMN "terms_unknown" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deal_submissions" ADD COLUMN "funder_id" text;--> statement-breakpoint
ALTER TABLE "deal_submissions" ADD COLUMN "job_id" text;--> statement-breakpoint
ALTER TABLE "deal_submissions" ADD COLUMN "route_kind" text;--> statement-breakpoint
ALTER TABLE "mca_adapter_credentials" ADD CONSTRAINT "mca_adapter_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_adapter_credentials" ADD CONSTRAINT "mca_adapter_credentials_funder_id_fkey" FOREIGN KEY ("funder_id") REFERENCES "public"."mca_funders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_email_oauth_states" ADD CONSTRAINT "mca_email_oauth_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_email_sender_members" ADD CONSTRAINT "mca_email_sender_members_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."mca_email_senders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_email_sender_members" ADD CONSTRAINT "mca_email_sender_members_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_email_sender_members" ADD CONSTRAINT "mca_email_sender_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_email_senders" ADD CONSTRAINT "mca_email_senders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_funder_replies" ADD CONSTRAINT "mca_funder_replies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_funder_replies" ADD CONSTRAINT "mca_funder_replies_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."mca_email_senders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_outgoing_derivatives" ADD CONSTRAINT "mca_outgoing_derivatives_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_outgoing_derivatives" ADD CONSTRAINT "mca_outgoing_derivatives_original_document_id_fkey" FOREIGN KEY ("original_document_id") REFERENCES "public"."mca_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_attempts" ADD CONSTRAINT "mca_submission_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."mca_submission_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_attempts" ADD CONSTRAINT "mca_submission_attempts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_jobs" ADD CONSTRAINT "mca_submission_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_jobs" ADD CONSTRAINT "mca_submission_jobs_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_jobs" ADD CONSTRAINT "mca_submission_jobs_funder_id_fkey" FOREIGN KEY ("funder_id") REFERENCES "public"."mca_funders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_outbox" ADD CONSTRAINT "mca_submission_outbox_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."mca_submission_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_outbox" ADD CONSTRAINT "mca_submission_outbox_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_submission_templates" ADD CONSTRAINT "mca_submission_templates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mca_email_senders_workspace_idx" ON "mca_email_senders" USING btree ("workspace_id","purpose");--> statement-breakpoint
CREATE INDEX "mca_funder_replies_state_idx" ON "mca_funder_replies" USING btree ("workspace_id","state","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_submission_attempts_job_idx" ON "mca_submission_attempts" USING btree ("job_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_submission_jobs_deal_idx" ON "mca_submission_jobs" USING btree ("workspace_id","deal_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "mca_submission_jobs_funder_idx" ON "mca_submission_jobs" USING btree ("workspace_id","deal_id","funder_id");--> statement-breakpoint
CREATE INDEX "mca_submission_outbox_available_idx" ON "mca_submission_outbox" USING btree ("available_at","processed_at");--> statement-breakpoint
CREATE INDEX "mca_submission_templates_workspace_idx" ON "mca_submission_templates" USING btree ("workspace_id","funder_id");--> statement-breakpoint
CREATE INDEX "deal_submissions_funder_idx" ON "deal_submissions" USING btree ("workspace_id","deal_id","funder_id");--> statement-breakpoint
ALTER TABLE "deal_offers" ADD CONSTRAINT "deal_offers_source_check" CHECK (source IS NULL OR source = ANY (ARRAY['api'::text, 'email'::text, 'link'::text, 'manual'::text]));