-- Existing companies require explicit ownership assignment; do not guess from roles.
ALTER TABLE memberships ADD CONSTRAINT memberships_workspace_id_id_unique UNIQUE (workspace_id, id);
--> statement-breakpoint
CREATE TABLE workspace_owners (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  membership_id text NOT NULL,
  updated_at text NOT NULL,
  FOREIGN KEY (workspace_id, membership_id) REFERENCES memberships(workspace_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
-- These grants are provisioned by a database operator, never by company APIs.
CREATE TABLE platform_admin_grants (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  granted_at text NOT NULL,
  granted_by text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  revoked_at text
);
--> statement-breakpoint
ALTER TABLE workspace_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workspace_owners, platform_admin_grants FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_owners TO mca_app;
    CREATE POLICY mca_server_access ON workspace_owners TO mca_app USING (true) WITH CHECK (true);
    REVOKE ALL ON platform_admin_grants FROM mca_app;
    GRANT SELECT ON platform_admin_grants TO mca_app;
    CREATE POLICY mca_server_access ON platform_admin_grants FOR SELECT TO mca_app USING (true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON workspace_owners, platform_admin_grants FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON workspace_owners, platform_admin_grants FROM authenticated;
  END IF;
END $$;
