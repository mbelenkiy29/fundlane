CREATE TABLE IF NOT EXISTS platform_admin_audit (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id),
  actor_email text NOT NULL,
  session_id text,
  action text NOT NULL,
  target_workspace_id text REFERENCES workspaces(id),
  target_type text,
  target_id text,
  reason text,
  before_json jsonb,
  after_json jsonb,
  step_up_at text,
  request_id text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_admin_audit_actor_created_idx ON platform_admin_audit (actor_user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_admin_audit_action_created_idx ON platform_admin_audit (action, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_admin_audit_workspace_created_idx ON platform_admin_audit (target_workspace_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS platform_admin_first_access_once_idx ON platform_admin_audit (actor_user_id) WHERE action='super_admin.first_access';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS platform_step_ups (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  verified_at text NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_platform_admin_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_admin_audit is append-only';
END
$$;
--> statement-breakpoint
CREATE TRIGGER platform_admin_audit_append_only BEFORE UPDATE OR DELETE ON platform_admin_audit
  FOR EACH ROW EXECUTE FUNCTION reject_platform_admin_audit_change();
--> statement-breakpoint
ALTER TABLE platform_admin_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_step_ups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_admin_audit, platform_step_ups FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON platform_admin_audit, platform_step_ups FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON platform_admin_audit, platform_step_ups FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT ON platform_admin_audit TO mca_app;
    GRANT SELECT, INSERT, UPDATE ON platform_step_ups TO mca_app;
    CREATE POLICY mca_server_access ON platform_admin_audit TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON platform_step_ups TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;
