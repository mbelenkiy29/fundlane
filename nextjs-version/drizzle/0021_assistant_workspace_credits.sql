CREATE TABLE "mca_assistant_references" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"deal_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_credit_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"purchased_balance" integer DEFAULT 0 NOT NULL,
	"purchased_reserved" integer DEFAULT 0 NOT NULL,
	"alert_episode" integer DEFAULT 0 NOT NULL,
	"low_sent" integer DEFAULT 0 NOT NULL,
	"exhausted_sent" integer DEFAULT 0 NOT NULL,
	"alert_dirty" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "credit_reserved_nonnegative" CHECK ("mca_credit_accounts"."purchased_reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "mca_credit_alert_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"error_code" text
);
--> statement-breakpoint
CREATE TABLE "mca_credit_alert_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'percent' NOT NULL,
	"threshold" integer DEFAULT 20 NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_credit_balance_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"month" text NOT NULL,
	"allowance" integer NOT NULL,
	"included" integer NOT NULL,
	"purchased" integer NOT NULL,
	"threshold_mode" text NOT NULL,
	"threshold_value" integer NOT NULL,
	"created_at" text NOT NULL,
	"processed_at" text
);
--> statement-breakpoint
CREATE TABLE "mca_credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"amount" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_credit_months" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"month" text NOT NULL,
	"allowance" integer NOT NULL,
	"effective_allowance" integer NOT NULL,
	"remaining" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credit_month_balances" CHECK ("mca_credit_months"."remaining" >= 0 AND "mca_credit_months"."reserved" >= 0 AND "mca_credit_months"."reserved" <= "mca_credit_months"."remaining")
);
--> statement-breakpoint
CREATE TABLE "mca_credit_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"account_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"episode" integer NOT NULL,
	"kind" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"created_at" text NOT NULL,
	"read_at" text
);
--> statement-breakpoint
CREATE TABLE "mca_credit_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"buyer_user_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"session_id" text,
	"payment_intent_id" text,
	"credits" integer DEFAULT 100 NOT NULL,
	"amount" integer DEFAULT 1000 NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"state" text NOT NULL,
	"granted" integer DEFAULT 0 NOT NULL,
	"reversed" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_credit_reservations" (
	"run_id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"month" text NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mca_assistant_conversations" ALTER COLUMN "deal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mca_assistant_runs" ADD COLUMN "selected_deal_id" text;--> statement-breakpoint
ALTER TABLE "mca_assistant_runs" ADD COLUMN "mutation_deal_id" text;--> statement-breakpoint
ALTER TABLE "mca_assistant_runs" ADD COLUMN "model_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mca_assistant_references" ADD CONSTRAINT "mca_assistant_references_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_alert_emails" ADD CONSTRAINT "mca_credit_alert_emails_id_mca_credit_notifications_id_fk" FOREIGN KEY ("id") REFERENCES "public"."mca_credit_notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_balance_events" ADD CONSTRAINT "mca_credit_balance_events_account_id_mca_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mca_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_ledger" ADD CONSTRAINT "mca_credit_ledger_account_id_mca_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mca_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_months" ADD CONSTRAINT "mca_credit_months_account_id_mca_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mca_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_notifications" ADD CONSTRAINT "mca_credit_notifications_account_id_mca_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mca_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_reservations" ADD CONSTRAINT "mca_credit_reservations_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_credit_reservations" ADD CONSTRAINT "mca_credit_reservations_account_id_mca_credit_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mca_credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_reference_once" ON "mca_assistant_references" USING btree ("conversation_id","deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_account_owner" ON "mca_credit_accounts" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "credit_balance_events_pending" ON "mca_credit_balance_events" USING btree ("account_id","id") WHERE "mca_credit_balance_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_event_once" ON "mca_credit_ledger" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_account" ON "mca_credit_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_month_once" ON "mca_credit_months" USING btree ("account_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_alert_once" ON "mca_credit_notifications" USING btree ("account_id","recipient_user_id","episode","kind");--> statement-breakpoint
CREATE INDEX "credit_alert_inbox" ON "mca_credit_notifications" USING btree ("workspace_id","recipient_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchase_request" ON "mca_credit_purchases" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_purchase_session" ON "mca_credit_purchases" USING btree ("session_id");