CREATE TABLE IF NOT EXISTS retention_holds (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  deal_id text REFERENCES deals(id),
  reason text NOT NULL CHECK (reason IN ('dispute', 'chargeback', 'subpoena', 'regulator_request')),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000 AND note = btrim(note)),
  placed_by text NOT NULL REFERENCES users(id),
  placed_at timestamptz(3) NOT NULL DEFAULT now(),
  released_by text REFERENCES users(id),
  released_at timestamptz(3),
  CONSTRAINT retention_holds_release_check CHECK ((released_at IS NULL) = (released_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS retention_holds_active_workspace_idx ON retention_holds (workspace_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS retention_holds_active_deal_idx ON retention_holds (workspace_id, deal_id) WHERE released_at IS NULL AND deal_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE retention_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON retention_holds FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON retention_holds FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON retention_holds FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE ON retention_holds TO mca_app;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname = 'public' AND tablename = 'retention_holds' AND policyname = 'mca_server_access') THEN
      CREATE POLICY mca_server_access ON retention_holds TO mca_app USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$grants$;
