CREATE TABLE "mca_chatkit_items" (
	"thread_id" text NOT NULL,
	"id" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "mca_chatkit_items_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	CONSTRAINT "mca_chatkit_items_thread_id_id_pk" PRIMARY KEY("thread_id","id")
);
--> statement-breakpoint
CREATE TABLE "mca_chatkit_references" (
	"thread_id" text NOT NULL,
	"deal_id" text NOT NULL,
	CONSTRAINT "mca_chatkit_references_thread_id_deal_id_pk" PRIMARY KEY("thread_id","deal_id")
);
--> statement-breakpoint
CREATE TABLE "mca_chatkit_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" text NOT NULL,
	"is_turn" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_chatkit_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"access_stamp" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mca_chatkit_items" ADD CONSTRAINT "mca_chatkit_items_thread_id_mca_chatkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mca_chatkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_chatkit_references" ADD CONSTRAINT "mca_chatkit_references_thread_id_mca_chatkit_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mca_chatkit_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_chatkit_requests" ADD CONSTRAINT "mca_chatkit_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_chatkit_requests" ADD CONSTRAINT "mca_chatkit_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_chatkit_threads" ADD CONSTRAINT "mca_chatkit_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mca_chatkit_threads" ADD CONSTRAINT "mca_chatkit_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mca_chatkit_items_page_idx" ON "mca_chatkit_items" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "mca_chatkit_requests_owner_idx" ON "mca_chatkit_requests" USING btree ("workspace_id","user_id","expires_at");--> statement-breakpoint
CREATE INDEX "mca_chatkit_threads_owner_idx" ON "mca_chatkit_threads" USING btree ("workspace_id","user_id","created_at","id");