SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE mca_historical_import_runs, mca_historical_import_rows IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "mca_historical_import_runs" ADD COLUMN IF NOT EXISTS "request_id" text;
--> statement-breakpoint
ALTER TABLE "mca_historical_import_runs" ADD COLUMN IF NOT EXISTS "input_hash" text;
--> statement-breakpoint
ALTER TABLE "mca_historical_import_runs" DROP CONSTRAINT IF EXISTS "mca_historical_import_runs_batch_key";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'mca_historical_import_runs'::regclass AND conname = 'mca_historical_import_runs_request_key') THEN
    ALTER TABLE mca_historical_import_runs ADD CONSTRAINT mca_historical_import_runs_request_key UNIQUE (workspace_id, request_id);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "mca_historical_import_rows" DROP CONSTRAINT IF EXISTS "mca_historical_import_rows_external_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mca_historical_import_rows_created_key" ON "mca_historical_import_rows" ("workspace_id", "source_id", "external_id") WHERE outcome = 'created';
--> statement-breakpoint
-- Keep obsolete deployments from using the pre-migration writer after cutover.
CREATE OR REPLACE FUNCTION mca_private.require_historical_writer_v2() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF current_setting('mca.historical_writer', true) IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'Historical imports are being upgraded. Refresh and retry shortly.' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS historical_runs_writer_version ON mca_historical_import_runs;
CREATE TRIGGER historical_runs_writer_version BEFORE INSERT OR UPDATE OR DELETE ON mca_historical_import_runs
FOR EACH STATEMENT EXECUTE FUNCTION mca_private.require_historical_writer_v2();
--> statement-breakpoint
DROP TRIGGER IF EXISTS historical_rows_writer_version ON mca_historical_import_rows;
CREATE TRIGGER historical_rows_writer_version BEFORE INSERT OR UPDATE OR DELETE ON mca_historical_import_rows
FOR EACH STATEMENT EXECUTE FUNCTION mca_private.require_historical_writer_v2();
