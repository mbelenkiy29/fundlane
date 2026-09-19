ALTER TABLE mca_private.ops_control
  ADD COLUMN IF NOT EXISTS document_worker_heartbeat_at timestamptz;
--> statement-breakpoint
