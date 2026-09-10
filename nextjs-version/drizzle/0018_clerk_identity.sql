CREATE TABLE "clerk_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "clerk_invitation_id" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "clerk_membership_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "clerk_organization_id" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_clerk_invitation_id_unique" UNIQUE("clerk_invitation_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_clerk_membership_id_unique" UNIQUE("clerk_membership_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_clerk_organization_id_unique" UNIQUE("clerk_organization_id");