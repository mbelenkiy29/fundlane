CREATE TABLE IF NOT EXISTS mca_background_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,
  resource_id text NOT NULL,
  idempotency_key text NOT NULL,
  actor_json text NOT NULL,
  payload_json text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','complete','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token text,
  lease_expires_at text,
  available_at text NOT NULL,
  result_json text,
  error_code text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (workspace_id,kind,idempotency_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mca_background_jobs_claim_idx ON mca_background_jobs(state,available_at,created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mca_document_uploads (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  owner_key text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('document','draft','merchant','task_file')),
  idempotency_key text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 26214400),
  checksum text NOT NULL,
  mime_type text NOT NULL,
  filename text NOT NULL,
  payload_json text NOT NULL,
  actor_json text NOT NULL,
  job_id text REFERENCES mca_background_jobs(id),
  expires_at text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (workspace_id,owner_key,purpose,idempotency_key)
);
--> statement-breakpoint
ALTER TABLE mca_background_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mca_document_uploads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON mca_background_jobs,mca_document_uploads FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON mca_background_jobs,mca_document_uploads FROM authenticated;
  END IF;
END $$;
