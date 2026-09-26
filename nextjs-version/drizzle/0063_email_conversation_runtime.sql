CREATE TABLE mca_email_runtime_lease (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_started_at timestamptz NOT NULL,
  last_completed_at timestamptz
);
--> statement-breakpoint
ALTER TABLE mca_email_runtime_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_email_runtime_lease FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON mca_email_runtime_lease FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON mca_email_runtime_lease FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mca_email_runtime_lease TO mca_app;
    CREATE POLICY mca_server_access ON mca_email_runtime_lease TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;
