-- Additive foundation only. No worker schedules are enabled by this migration.
CREATE SCHEMA IF NOT EXISTS mca_private;
REVOKE ALL ON SCHEMA mca_private FROM PUBLIC, anon, authenticated;

CREATE TABLE mca_private.worker_controls (
  subsystem text PRIMARY KEY CHECK (subsystem IN ('documents','messaging','maintenance','assistant')),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  enabled boolean NOT NULL DEFAULT false,
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 4),
  lock_value boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO mca_private.worker_controls(subsystem,concurrency) VALUES
  ('documents',2),('messaging',4),('maintenance',1),('assistant',1);

CREATE TABLE mca_private.worker_executions (
  token uuid PRIMARY KEY,
  subsystem text NOT NULL REFERENCES mca_private.worker_controls(subsystem),
  generation bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX worker_executions_active ON mca_private.worker_executions(subsystem,expires_at);

CREATE TABLE mca_private.job_checkpoints (
  job_id text PRIMARY KEY REFERENCES public.mca_background_jobs(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  stage text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  input_hash text NOT NULL,
  payload_cipher text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE mca_private.worker_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_private.worker_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_private.job_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA mca_private FROM PUBLIC, anon, authenticated;
-- Runtime grants are deliberate; controls remain read-only to the application role.
GRANT USAGE ON SCHEMA mca_private TO mca_app;
GRANT SELECT ON mca_private.worker_controls TO mca_app;
-- SELECT FOR SHARE requires UPDATE permission. This inert column permits locking
-- without allowing runtime credentials to enable workers or change generations.
GRANT UPDATE(lock_value) ON mca_private.worker_controls TO mca_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mca_private.worker_executions, mca_private.job_checkpoints TO mca_app;
CREATE POLICY worker_controls_runtime ON mca_private.worker_controls TO mca_app USING (true);
CREATE POLICY worker_executions_runtime ON mca_private.worker_executions TO mca_app USING (true) WITH CHECK (true);
CREATE POLICY job_checkpoints_runtime ON mca_private.job_checkpoints TO mca_app USING (true) WITH CHECK (true);

CREATE TABLE mca_private.verisys_scans (
  id uuid PRIMARY KEY,
  job_id text NOT NULL REFERENCES public.mca_background_jobs(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 26214400),
  provider_id uuid UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','clean','infected','error')),
  evidence_json jsonb,
  submit_token uuid,
  submit_expires_at timestamptz,
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,sha256)
);
ALTER TABLE mca_private.verisys_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_private.verisys_scans FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mca_private.verisys_scans TO mca_app;
CREATE POLICY verisys_scans_runtime ON mca_private.verisys_scans TO mca_app USING (true) WITH CHECK (true);
