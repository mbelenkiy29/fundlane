CREATE TABLE mca_application_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  integration_id text NOT NULL REFERENCES intake_integrations(id),
  form_id text NOT NULL,
  membership_id text NOT NULL REFERENCES memberships(id),
  client_name text NOT NULL,
  email_cipher text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_cipher text NOT NULL,
  request_key text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  revoked_at text,
  copied_at text,
  sent_at text,
  opened_at text,
  started_at text,
  submitted_at text,
  submission_event_id text,
  intake_id text REFERENCES intake_events(id),
  deal_id text REFERENCES deals(id),
  UNIQUE(workspace_id, membership_id, request_key),
  UNIQUE(workspace_id, integration_id, submission_event_id),
  UNIQUE(workspace_id, deal_id)
);
CREATE INDEX application_invitation_cohort_idx ON mca_application_invitations(workspace_id, created_at, membership_id);
--> statement-breakpoint
CREATE TABLE mca_application_invitation_events (
  invitation_id text NOT NULL REFERENCES mca_application_invitations(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK(kind IN ('opened','started')),
  occurred_at text NOT NULL,
  PRIMARY KEY(invitation_id, kind)
);
--> statement-breakpoint
CREATE TABLE mca_application_invitation_deliveries (
  id text PRIMARY KEY,
  invitation_id text NOT NULL REFERENCES mca_application_invitations(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  request_key text NOT NULL,
  job_id text REFERENCES mca_background_jobs(id),
  delivery text CHECK(delivery IN ('sent','preview')),
  created_at text NOT NULL,
  accepted_at text,
  UNIQUE(invitation_id, request_key)
);
CREATE INDEX application_invitation_delivery_idx ON mca_application_invitation_deliveries(workspace_id, invitation_id, created_at);
--> statement-breakpoint
ALTER TABLE mca_application_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_application_invitation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_application_invitation_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mca_application_invitations,mca_application_invitation_events,mca_application_invitation_deliveries FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_application_invitations,mca_application_invitation_events,mca_application_invitation_deliveries FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_application_invitations,mca_application_invitation_events,mca_application_invitation_deliveries FROM authenticated; END IF;
END $$;

--> statement-breakpoint
-- Existing deployments use a restricted server role. Keep new tables available
-- in the same transaction as migration, while browser roles remain denied.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON mca_application_invitations,mca_application_invitation_events,mca_application_invitation_deliveries TO mca_app;
    CREATE POLICY mca_server_access ON mca_application_invitations TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON mca_application_invitation_events TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON mca_application_invitation_deliveries TO mca_app USING (true) WITH CHECK (true);
  END IF;
END $$;
