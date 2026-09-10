ALTER TABLE "mca_historical_import_rows" DROP CONSTRAINT "mca_historical_import_rows_external_key";--> statement-breakpoint
ALTER TABLE "mca_closing_previews" ADD COLUMN "attachment_document_refs_json" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "mca_historical_import_rows" ADD COLUMN "source_id" text;--> statement-breakpoint
UPDATE "mca_historical_import_rows" AS historical_row
SET "source_id" = run."source_id"
FROM "mca_historical_import_runs" AS run
WHERE historical_row."workspace_id" = run."workspace_id" AND historical_row."run_id" = run."id";--> statement-breakpoint
ALTER TABLE "mca_historical_import_rows" ALTER COLUMN "source_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mca_historical_import_rows" ADD CONSTRAINT "mca_historical_import_rows_external_key" UNIQUE("workspace_id","source_id","external_id");
