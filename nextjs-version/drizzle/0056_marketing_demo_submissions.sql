CREATE TABLE IF NOT EXISTS marketing_demo_submissions (
  request_id text PRIMARY KEY,
  payload_digest text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  brokerage text NOT NULL,
  team_size text NOT NULL,
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS marketing_demo_submissions_created_idx ON marketing_demo_submissions (created_at DESC);
--> statement-breakpoint
ALTER TABLE marketing_demo_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON marketing_demo_submissions FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON marketing_demo_submissions FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON marketing_demo_submissions FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT ON marketing_demo_submissions TO mca_app;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'public' AND tablename = 'marketing_demo_submissions' AND policyname = 'mca_server_access') THEN
      CREATE POLICY mca_server_access ON marketing_demo_submissions TO mca_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$grants$;
