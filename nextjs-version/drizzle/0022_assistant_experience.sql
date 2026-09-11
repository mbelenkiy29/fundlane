CREATE TABLE "mca_assistant_cleanup" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_conversation_meta" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"title_cipher" text,
	"summary_cipher" text,
	"summary_sequence" integer DEFAULT 0 NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload_cipher" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_files" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name_cipher" text NOT NULL,
	"mime" text NOT NULL,
	"byte_length" integer NOT NULL,
	"checksum" text NOT NULL,
	"storage_key" text NOT NULL,
	"state" text NOT NULL,
	"parent_id" text,
	"provenance_cipher" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"settings_id" text NOT NULL,
	"category" text NOT NULL,
	"content_cipher" text,
	"source_conversation_id" text,
	"fingerprint" text NOT NULL,
	"deleted_at" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_memory_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_message_parts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"payload_cipher" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"questions_cipher" text NOT NULL,
	"answer_cipher" text,
	"answer_request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_assistant_run_meta" (
	"run_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 2 NOT NULL,
	"elapsed_ms" integer DEFAULT 0 NOT NULL,
	"active_since" text,
	"search_calls" integer DEFAULT 0 NOT NULL,
	"code_calls" integer DEFAULT 0 NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"attachments_cipher" text,
	"memory_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DROP INDEX "assistant_one_active_run";--> statement-breakpoint
ALTER TABLE "mca_assistant_conversation_meta" ADD CONSTRAINT "mca_assistant_conversation_meta_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_events" ADD CONSTRAINT "mca_assistant_events_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_files" ADD CONSTRAINT "mca_assistant_files_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_files" ADD CONSTRAINT "mca_assistant_files_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_memories" ADD CONSTRAINT "mca_assistant_memories_settings_id_mca_assistant_memory_settings_id_fk" FOREIGN KEY ("settings_id") REFERENCES "public"."mca_assistant_memory_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_memories" ADD CONSTRAINT "mca_assistant_memories_source_conversation_id_mca_assistant_conversations_id_fk" FOREIGN KEY ("source_conversation_id") REFERENCES "public"."mca_assistant_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_message_parts" ADD CONSTRAINT "mca_assistant_message_parts_message_id_mca_assistant_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mca_assistant_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_message_parts" ADD CONSTRAINT "mca_assistant_message_parts_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_questions" ADD CONSTRAINT "mca_assistant_questions_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_assistant_run_meta" ADD CONSTRAINT "mca_assistant_run_meta_run_id_mca_assistant_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."mca_assistant_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_cleanup_resource" ON "mca_assistant_cleanup" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_event_sequence" ON "mca_assistant_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "assistant_files_expiry" ON "mca_assistant_files" USING btree ("expires_at") WHERE "mca_assistant_files"."state" = 'ready';--> statement-breakpoint
CREATE INDEX "assistant_files_owner" ON "mca_assistant_files" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_memory_fingerprint" ON "mca_assistant_memories" USING btree ("settings_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_memory_owner" ON "mca_assistant_memory_settings" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_question_call" ON "mca_assistant_questions" USING btree ("run_id","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_answer_request" ON "mca_assistant_questions" USING btree ("run_id","answer_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_one_active_run" ON "mca_assistant_runs" USING btree ("conversation_id") WHERE "mca_assistant_runs"."status" IN ('running','awaiting_approval','awaiting_input');