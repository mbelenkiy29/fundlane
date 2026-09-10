CREATE TABLE "mca_sms_account_members" (
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"assigned_at" text NOT NULL,
	"assigned_by_user_id" text,
	CONSTRAINT "mca_sms_account_members_pkey" PRIMARY KEY("account_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "mca_sms_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"sender_kind" text NOT NULL,
	"sender_identity_cipher" text NOT NULL,
	"credential_ref" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_sms_accounts_label_key" UNIQUE("workspace_id","label"),
	CONSTRAINT "mca_sms_accounts_provider_check" CHECK (provider = 'twilio'),
	CONSTRAINT "mca_sms_accounts_sender_kind_check" CHECK (sender_kind = ANY (ARRAY['phone_number'::text, 'messaging_service'::text])),
	CONSTRAINT "mca_sms_accounts_state_check" CHECK (state = ANY (ARRAY['active'::text, 'revoked'::text])),
	CONSTRAINT "mca_sms_accounts_default_check" CHECK (is_default IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "mca_sms_consent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_cipher" text NOT NULL,
	"state" text NOT NULL,
	"source" text NOT NULL,
	"evidence" text,
	"idempotency_key" text NOT NULL,
	"actor_user_id" text,
	"effective_at" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_sms_consent_events_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_sms_consent_events_state_check" CHECK (state = ANY (ARRAY['opted_in'::text, 'opted_out'::text])),
	CONSTRAINT "mca_sms_consent_events_source_check" CHECK (source = ANY (ARRAY['manual'::text, 'provider_webhook'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_sms_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider" text NOT NULL,
	"sender_identity_cipher" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_cipher" text NOT NULL,
	"body_cipher" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text NOT NULL,
	"provider_message_id" text,
	"provider_status" text,
	"error_code" text,
	"error_message" text,
	"idempotency_key" text NOT NULL,
	"correlation_id" text NOT NULL,
	"actor_user_id" text,
	"accepted_at" text,
	"delivered_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_sms_messages_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_sms_messages_provider_id_key" UNIQUE("workspace_id","provider","provider_message_id"),
	CONSTRAINT "mca_sms_messages_provider_check" CHECK (provider = 'twilio'),
	CONSTRAINT "mca_sms_messages_state_check" CHECK (state = ANY (ARRAY['pending'::text, 'accepted'::text, 'sent'::text, 'delivered'::text, 'failed'::text, 'unknown'::text]))
);
--> statement-breakpoint
CREATE TABLE "mca_sms_status_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"provider_status" text NOT NULL,
	"error_code" text,
	"event_key" text NOT NULL,
	"received_at" text NOT NULL,
	CONSTRAINT "mca_sms_status_events_event_key" UNIQUE("workspace_id","event_key")
);
--> statement-breakpoint
CREATE INDEX "mca_sms_account_members_member_idx" ON "mca_sms_account_members" USING btree ("workspace_id","membership_id","account_id");--> statement-breakpoint
CREATE INDEX "mca_sms_accounts_route_idx" ON "mca_sms_accounts" USING btree ("workspace_id","state","is_default");--> statement-breakpoint
CREATE INDEX "mca_sms_consent_events_current_idx" ON "mca_sms_consent_events" USING btree ("workspace_id","deal_id","recipient_hash","effective_at");--> statement-breakpoint
CREATE INDEX "mca_sms_messages_deal_idx" ON "mca_sms_messages" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_sms_messages_recipient_idx" ON "mca_sms_messages" USING btree ("workspace_id","recipient_hash","created_at");--> statement-breakpoint
CREATE INDEX "mca_sms_status_events_message_idx" ON "mca_sms_status_events" USING btree ("workspace_id","message_id","received_at");