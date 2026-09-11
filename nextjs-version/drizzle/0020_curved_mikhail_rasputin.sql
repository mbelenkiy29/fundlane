CREATE TABLE "mca_assistant_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"preview_cipher" text NOT NULL,
	"fingerprint" text NOT NULL,
	"call_id" text,
	"result_cipher" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"status" text NOT NULL,
	"result_cipher" text,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"sequence" bigserial NOT NULL,
	"role" text NOT NULL,
	"content_cipher" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"request_id" text NOT NULL,
	"status" text NOT NULL,
	"state_cipher" text,
	"error" text,
	"usage_json" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mca_assistant_approvals" ADD CONSTRAINT "mca_assistant_approvals_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_executions" ADD CONSTRAINT "mca_assistant_executions_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_messages" ADD CONSTRAINT "mca_assistant_messages_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_runs" ADD CONSTRAINT "mca_assistant_runs_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_run_approvals" ON "mca_assistant_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_conversation_owner" ON "mca_assistant_conversations" USING btree ("workspace_id","user_id","deal_id");--> statement-breakpoint
CREATE INDEX "assistant_run_executions" ON "mca_assistant_executions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "assistant_message_history" ON "mca_assistant_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_request_once" ON "mca_assistant_runs" USING btree ("conversation_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_one_active_run" ON "mca_assistant_runs" USING btree ("conversation_id") WHERE "mca_assistant_runs"."status" IN ('running','awaiting_approval');