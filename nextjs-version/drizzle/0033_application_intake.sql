ALTER TABLE intake_integrations ADD COLUMN automatic_processing integer NOT NULL DEFAULT 0;
ALTER TABLE intake_integrations ADD COLUMN automatic_since text;
--> statement-breakpoint
ALTER TABLE intake_events DROP CONSTRAINT intake_events_workspace_id_provider_provider_event_id_key;
ALTER TABLE intake_events ADD COLUMN event_namespace text NOT NULL DEFAULT '';
ALTER TABLE intake_events ADD COLUMN legacy_identity integer NOT NULL DEFAULT 0;
UPDATE intake_events SET legacy_identity=1;
UPDATE intake_events SET event_namespace = COALESCE(integration_id, '');
ALTER TABLE intake_events ADD CONSTRAINT intake_events_scoped_event_key UNIQUE(workspace_id, event_namespace, provider, provider_event_id);
--> statement-breakpoint
CREATE TABLE intake_processing (
  intake_id text PRIMARY KEY REFERENCES intake_events(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  fingerprint text,
  generation integer NOT NULL DEFAULT 0,
  job_id text REFERENCES mca_background_jobs(id),
  progress_json text NOT NULL DEFAULT '{}',
  checked_at text NOT NULL,
  updated_at text NOT NULL
);
ALTER TABLE intake_processing ENABLE ROW LEVEL SECURITY;
CREATE INDEX intake_processing_workspace_idx ON intake_processing(workspace_id);
--> statement-breakpoint
REVOKE ALL ON intake_processing FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON intake_processing FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON intake_processing FROM authenticated; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON intake_processing TO mca_app;
    CREATE POLICY mca_server_access ON intake_processing TO mca_app USING (true) WITH CHECK (true);
  END IF;
END $$;
