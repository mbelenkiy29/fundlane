CREATE TABLE "mca_deal_acquisition_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"source_id" text,
	"batch_id" text,
	"cost_cents" integer,
	"purchased_on" text,
	"actor_user_id" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_deal_acquisition_events_correlation_key" UNIQUE("workspace_id","correlation_id")
);
--> statement-breakpoint
CREATE TABLE "mca_digest_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"state" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_digest_deliveries_window_key" UNIQUE("workspace_id","membership_id","window_start"),
	CONSTRAINT "mca_digest_deliveries_state_check" CHECK (state = ANY (ARRAY['sent'::text, 'skipped'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_digest_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"timezone" text NOT NULL,
	"local_send_hour" integer DEFAULT 6 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_digest_subscriptions_member_key" UNIQUE("workspace_id","membership_id"),
	CONSTRAINT "mca_digest_subscriptions_enabled_check" CHECK (enabled IN (0,1)),
	CONSTRAINT "mca_digest_subscriptions_hour_check" CHECK (local_send_hour >= 0 AND local_send_hour <= 23)
);
--> statement-breakpoint
CREATE TABLE "mca_export_download_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" text NOT NULL,
	"downloaded_at" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_export_download_tokens_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mca_export_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"filter_snapshot_json" text NOT NULL,
	"field_manifest_json" text NOT NULL,
	"state" text NOT NULL,
	"checksum" text,
	"row_count" integer,
	"actor_user_id" text,
	"correlation_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_export_jobs_kind_check" CHECK (kind = ANY (ARRAY['deals'::text, 'offers'::text, 'all_deals_owners'::text, 'funded_deals'::text])),
	CONSTRAINT "mca_export_jobs_state_check" CHECK (state = ANY (ARRAY['queued'::text, 'ready'::text, 'failed'::text, 'expired'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_followup_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"occurrence_key" text NOT NULL,
	"state" text NOT NULL,
	"skip_reason" text,
	"message_id" text,
	"correlation_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"attempted_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_followup_occurrences_key" UNIQUE("workspace_id","policy_id","deal_id","occurrence_key"),
	CONSTRAINT "mca_followup_occurrences_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'sent'::text, 'skipped'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_followup_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_status" text NOT NULL,
	"channel" text NOT NULL,
	"local_schedule" text NOT NULL,
	"template_id" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"retry_policy_json" text DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_followup_policies_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text])),
	CONSTRAINT "mca_followup_policies_enabled_check" CHECK (enabled IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "mca_funder_reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"job_id" text NOT NULL,
	"sender_id" text,
	"thread_id" text,
	"in_reply_to" text,
	"references_json" text DEFAULT '[]' NOT NULL,
	"state" text NOT NULL,
	"last_reminded_at" text,
	"correlation_id" text NOT NULL,
	"actor_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_funder_reminders_state_check" CHECK (state = ANY (ARRAY['previewed'::text, 'sent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_message_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"variable_schema_hash" text NOT NULL,
	"published" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_message_template_versions_version_key" UNIQUE("template_id","version"),
	CONSTRAINT "mca_message_template_versions_published_check" CHECK (published IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "mca_message_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"scope" text NOT NULL,
	"published_version_id" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_message_templates_name_key" UNIQUE("workspace_id","name","channel"),
	CONSTRAINT "mca_message_templates_channel_check" CHECK (channel = ANY (ARRAY['email'::text, 'sms'::text])),
	CONSTRAINT "mca_message_templates_scope_check" CHECK (scope = ANY (ARRAY['merchant'::text, 'followup'::text, 'digest'::text, 'request_info'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_sms_adapter_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"environment" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"capabilities_json" text DEFAULT '{}' NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_sms_adapter_credentials_provider_env" UNIQUE("workspace_id","provider","environment"),
	CONSTRAINT "mca_sms_adapter_credentials_provider_check" CHECK (provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text])),
	CONSTRAINT "mca_sms_adapter_credentials_environment_check" CHECK (environment = ANY (ARRAY['development'::text, 'production'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_workflow_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"outbox_id" text NOT NULL,
	"event_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"http_status" integer,
	"state" text NOT NULL,
	"error" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_workflow_webhook_deliveries_attempt_key" UNIQUE("workspace_id","outbox_id","attempt"),
	CONSTRAINT "mca_workflow_webhook_deliveries_state_check" CHECK (state = ANY (ARRAY['delivered'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_workflow_webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"destination_url" text NOT NULL,
	"events_json" text NOT NULL,
	"signing_secret_cipher" text NOT NULL,
	"notify_originator" integer DEFAULT 0 NOT NULL,
	"notify_closer" integer DEFAULT 0 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_workflow_webhook_endpoints_label_key" UNIQUE("workspace_id","label"),
	CONSTRAINT "mca_workflow_webhook_endpoints_flags_check" CHECK (notify_originator IN (0,1) AND notify_closer IN (0,1) AND enabled IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "mca_workflow_webhook_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_workflow_webhook_outbox_event_key" UNIQUE("workspace_id","endpoint_id","event_id"),
	CONSTRAINT "mca_workflow_webhook_outbox_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "mca_sms_accounts" DROP CONSTRAINT "mca_sms_accounts_provider_check";--> statement-breakpoint
ALTER TABLE "mca_sms_messages" DROP CONSTRAINT "mca_sms_messages_provider_check";--> statement-breakpoint
ALTER TABLE "lead_batches" ADD COLUMN "purchased_on" text;--> statement-breakpoint
ALTER TABLE "lead_batches" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "lead_batches" ADD COLUMN "inactive" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "mca_deal_acquisition_events_deal_idx" ON "mca_deal_acquisition_events" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_export_download_tokens_job_idx" ON "mca_export_download_tokens" USING btree ("workspace_id","job_id");--> statement-breakpoint
CREATE INDEX "mca_export_jobs_workspace_idx" ON "mca_export_jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_followup_occurrences_due_idx" ON "mca_followup_occurrences" USING btree ("workspace_id","state","scheduled_for");--> statement-breakpoint
CREATE INDEX "mca_followup_policies_workspace_idx" ON "mca_followup_policies" USING btree ("workspace_id","enabled","deal_status");--> statement-breakpoint
CREATE INDEX "mca_funder_reminders_job_idx" ON "mca_funder_reminders" USING btree ("workspace_id","job_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_message_template_versions_template_idx" ON "mca_message_template_versions" USING btree ("workspace_id","template_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_message_templates_workspace_idx" ON "mca_message_templates" USING btree ("workspace_id","channel","scope");--> statement-breakpoint
CREATE INDEX "mca_sms_adapter_credentials_workspace_idx" ON "mca_sms_adapter_credentials" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "mca_workflow_webhook_outbox_due_idx" ON "mca_workflow_webhook_outbox" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
ALTER TABLE "lead_batches" ADD CONSTRAINT "lead_batches_inactive_check" CHECK (inactive IN (0,1));--> statement-breakpoint
ALTER TABLE "lead_batches" ADD CONSTRAINT "lead_batches_cost_check" CHECK (cost_cents IS NULL OR cost_cents >= 0);--> statement-breakpoint
ALTER TABLE "mca_sms_accounts" ADD CONSTRAINT "mca_sms_accounts_provider_check" CHECK (provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text]));--> statement-breakpoint
ALTER TABLE "mca_sms_messages" ADD CONSTRAINT "mca_sms_messages_provider_check" CHECK (provider = ANY (ARRAY['twilio'::text, 'entrance'::text, 'texttorrent'::text, 'textus'::text, 'openphone'::text, 'gohighlevel'::text]));