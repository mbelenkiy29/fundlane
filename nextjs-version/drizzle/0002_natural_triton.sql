CREATE TABLE "mca_analysis_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"completeness_version" integer NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"top_n" integer NOT NULL,
	"review_notification_channel" text NOT NULL,
	"selected_funder_ids" text NOT NULL,
	"destinations_json" text NOT NULL,
	"settings_snapshot" text NOT NULL,
	"reason" text NOT NULL,
	"queued" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mca_analysis_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"top_n" integer NOT NULL,
	"review_notification_channel" text NOT NULL,
	"automatic_send_enabled" integer DEFAULT 0 NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
CREATE INDEX "mca_analysis_runs_deal_idx" ON "mca_analysis_runs" USING btree ("workspace_id","deal_id","created_at" DESC NULLS LAST);