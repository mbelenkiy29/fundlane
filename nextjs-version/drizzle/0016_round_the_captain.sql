CREATE TABLE "sms_registration_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number_sid" text NOT NULL,
	"state" text NOT NULL,
	"provider_time" text NOT NULL,
	"created_at" text NOT NULL
);
