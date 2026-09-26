CREATE TABLE IF NOT EXISTS mca_auto_submit_settings (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'off',
  min_match_score integer NOT NULL DEFAULT 80,
  max_funders_per_deal integer NOT NULL DEFAULT 3,
  eligible_funder_ids text NOT NULL DEFAULT '[]',
  updated_at text NOT NULL,
  updated_by_user_id text,
  CONSTRAINT mca_auto_submit_mode_check CHECK (mode IN ('off','score_only','auto_submit')),
  CONSTRAINT mca_auto_submit_score_check CHECK (min_match_score BETWEEN 0 AND 100),
  CONSTRAINT mca_auto_submit_max_check CHECK (max_funders_per_deal BETWEEN 1 AND 25)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mca_auto_submit_decisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deal_id text NOT NULL,
  deal_version integer NOT NULL,
  completeness_version integer NOT NULL,
  funder_id text NOT NULL,
  score integer NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL,
  submission_job_id text,
  retry_count integer NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  CONSTRAINT mca_auto_submit_decisions_unique UNIQUE (workspace_id,deal_id,funder_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mca_auto_submit_decisions_deal_idx ON mca_auto_submit_decisions (workspace_id,deal_id,created_at DESC);
--> statement-breakpoint
ALTER TABLE mca_auto_submit_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_auto_submit_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_auto_submit_settings, mca_auto_submit_decisions FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON mca_auto_submit_settings, mca_auto_submit_decisions FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON mca_auto_submit_settings, mca_auto_submit_decisions FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mca_auto_submit_settings, mca_auto_submit_decisions TO mca_app;
    CREATE POLICY mca_server_access ON mca_auto_submit_settings TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON mca_auto_submit_decisions TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;
