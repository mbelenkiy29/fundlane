CREATE TABLE "mca_review_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"run_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"selected_funder_ids" text NOT NULL,
	"actor_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_review_approvals_workspace_id_run_id_snapshot_id_key" UNIQUE("workspace_id","run_id","snapshot_id")
);
--> statement-breakpoint
CREATE TABLE "mca_review_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"recipient_roles" text NOT NULL,
	"cc_emails" text NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
