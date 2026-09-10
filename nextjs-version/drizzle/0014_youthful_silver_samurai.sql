CREATE TABLE "mca_distribution_schedule_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"version" integer NOT NULL,
	"start_date" text NOT NULL,
	"installment_count" integer NOT NULL,
	"installment_cents" integer NOT NULL,
	"split_template_id" text NOT NULL,
	"split_template_version" integer NOT NULL,
	"allocation_json" text NOT NULL,
	"reason" text,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_distribution_schedule_versions_key" UNIQUE("workspace_id","schedule_id","version"),
	CONSTRAINT "mca_distribution_schedule_versions_version_check" CHECK ("mca_distribution_schedule_versions"."version" > 0),
	CONSTRAINT "mca_distribution_schedule_versions_count_check" CHECK ("mca_distribution_schedule_versions"."installment_count" > 0),
	CONSTRAINT "mca_distribution_schedule_versions_amount_check" CHECK ("mca_distribution_schedule_versions"."installment_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "mca_distribution_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"reverse_consolidation_id" text NOT NULL,
	"status" text NOT NULL,
	"active_version" integer NOT NULL,
	"start_date" text NOT NULL,
	"installment_count" integer NOT NULL,
	"installment_cents" integer NOT NULL,
	"split_template_id" text NOT NULL,
	"split_template_version" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_distribution_schedules_consolidation_key" UNIQUE("workspace_id","reverse_consolidation_id"),
	CONSTRAINT "mca_distribution_schedules_status_check" CHECK ("mca_distribution_schedules"."status" in ('active','paused','cancelled')),
	CONSTRAINT "mca_distribution_schedules_version_check" CHECK ("mca_distribution_schedules"."active_version" > 0),
	CONSTRAINT "mca_distribution_schedules_count_check" CHECK ("mca_distribution_schedules"."installment_count" > 0),
	CONSTRAINT "mca_distribution_schedules_amount_check" CHECK ("mca_distribution_schedules"."installment_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "mca_reverse_consolidations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"referenced_advance_ids_json" text NOT NULL,
	"schedule_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_user_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "mca_reverse_consolidations_idempotency_key" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "mca_reverse_consolidations_schedule_key" UNIQUE("workspace_id","schedule_id")
);
--> statement-breakpoint
CREATE TABLE "mca_scheduled_installments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"schedule_version" integer NOT NULL,
	"occurrence_date" text NOT NULL,
	"recipient_membership_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"percentage_basis_points" integer NOT NULL,
	"status" text NOT NULL,
	"paid_at" text,
	"snapshot_json" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "mca_scheduled_installments_occurrence_key" UNIQUE("workspace_id","schedule_id","schedule_version","occurrence_date","recipient_membership_id"),
	CONSTRAINT "mca_scheduled_installments_idempotency_key" UNIQUE("workspace_id","schedule_id","idempotency_key"),
	CONSTRAINT "mca_scheduled_installments_status_check" CHECK ("mca_scheduled_installments"."status" in ('expected','paid','void')),
	CONSTRAINT "mca_scheduled_installments_amount_check" CHECK ("mca_scheduled_installments"."amount_cents" >= 0),
	CONSTRAINT "mca_scheduled_installments_percent_check" CHECK ("mca_scheduled_installments"."percentage_basis_points" > 0 and "mca_scheduled_installments"."percentage_basis_points" <= 10000)
);
--> statement-breakpoint
CREATE INDEX "mca_distribution_schedule_versions_schedule_idx" ON "mca_distribution_schedule_versions" USING btree ("workspace_id","schedule_id","version");--> statement-breakpoint
CREATE INDEX "mca_distribution_schedules_status_idx" ON "mca_distribution_schedules" USING btree ("workspace_id","status","start_date");--> statement-breakpoint
CREATE INDEX "mca_reverse_consolidations_deal_idx" ON "mca_reverse_consolidations" USING btree ("workspace_id","deal_id","created_at");--> statement-breakpoint
CREATE INDEX "mca_scheduled_installments_schedule_idx" ON "mca_scheduled_installments" USING btree ("workspace_id","schedule_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "mca_scheduled_installments_recipient_idx" ON "mca_scheduled_installments" USING btree ("workspace_id","recipient_membership_id","status","occurrence_date");