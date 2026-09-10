CREATE TABLE "workspace_billing" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"clerk_subscription_id" text NOT NULL,
	"clerk_plan_id" text NOT NULL,
	"plan_slug" text NOT NULL,
	"plan_name" text NOT NULL,
	"status" text NOT NULL,
	"period_start" text NOT NULL,
	"period_end" text,
	"seat_limit" integer NOT NULL,
	"payment_past_due" integer DEFAULT 0 NOT NULL,
	"synced_at" text NOT NULL,
	CONSTRAINT "workspace_billing_clerk_subscription_id_unique" UNIQUE("clerk_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_billing" ADD CONSTRAINT "workspace_billing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;