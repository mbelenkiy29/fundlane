CREATE TABLE "sms_number_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number_id" text NOT NULL,
	"membership_id" text,
	"actor_user_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_companies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"email_verified_at" text,
	"profile_cipher" text,
	"review_state" text DEFAULT 'draft' NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"registration_state" text DEFAULT 'not_started' NOT NULL,
	"provider_cipher" text,
	"suspended" integer DEFAULT 0 NOT NULL,
	"number_limit" integer DEFAULT 0 NOT NULL,
	"monthly_limit_cents" integer DEFAULT 0 NOT NULL,
	"registration_limit_cents" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "sms_company_limits" CHECK ("sms_companies"."number_limit" >= 0 AND "sms_companies"."monthly_limit_cents" >= 0 AND "sms_companies"."registration_limit_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sms_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"recipient_cipher" text NOT NULL,
	"deal_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_email_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"used_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"direction" text NOT NULL,
	"body_cipher" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_sid" text NOT NULL,
	"phone" text NOT NULL,
	"membership_id" text,
	"state" text NOT NULL,
	"monthly_cents" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_key" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"result_cipher" text,
	"error_code" text,
	"lease_until" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_conversation_reads" (
	"conversation_id" text NOT NULL,
	"membership_id" text NOT NULL,
	"read_at" text NOT NULL,
	CONSTRAINT "sms_conversation_reads_conversation_id_membership_id_pk" PRIMARY KEY("conversation_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "sms_suppressions" (
	"workspace_id" text NOT NULL,
	"recipient_hash" text NOT NULL,
	"state" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "sms_suppressions_workspace_id_recipient_hash_pk" PRIMARY KEY("workspace_id","recipient_hash")
);
--> statement-breakpoint
CREATE TABLE "sms_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period" text NOT NULL,
	"category" text NOT NULL,
	"estimated_cents" integer DEFAULT 0 NOT NULL,
	"actual_cents" integer,
	"quantity" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_companies" ADD CONSTRAINT "sms_companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_companies" ADD CONSTRAINT "sms_companies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_email_tokens" ADD CONSTRAINT "sms_email_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_email_tokens" ADD CONSTRAINT "sms_email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_numbers" ADD CONSTRAINT "sms_numbers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_operations" ADD CONSTRAINT "sms_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_conversation_identity" ON "sms_conversations" USING btree ("workspace_id","account_id","recipient_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_inbox_provider" ON "sms_inbox_messages" USING btree ("workspace_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_number_provider" ON "sms_numbers" USING btree ("provider_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_number_account" ON "sms_numbers" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_employee_number" ON "sms_numbers" USING btree ("workspace_id","membership_id") WHERE "sms_numbers"."state" <> 'released';--> statement-breakpoint
CREATE UNIQUE INDEX "sms_operation_retry" ON "sms_operations" USING btree ("workspace_id","request_key");