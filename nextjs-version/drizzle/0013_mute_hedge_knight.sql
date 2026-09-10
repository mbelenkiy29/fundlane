CREATE TABLE "mca_followup_sender_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"sender_mode" text NOT NULL,
	"bcc_fallback" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by_user_id" text,
	CONSTRAINT "mca_followup_sender_settings_mode_check" CHECK (sender_mode = ANY (ARRAY['originator'::text, 'workspace_shared'::text])),
	CONSTRAINT "mca_followup_sender_settings_bcc_check" CHECK (bcc_fallback IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "mca_followup_template_copy" (
	"workspace_id" text NOT NULL,
	"template_id" text NOT NULL,
	"cc_emails" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_followup_template_copy_pkey" PRIMARY KEY("workspace_id","template_id")
);
