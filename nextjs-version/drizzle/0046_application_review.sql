ALTER TABLE intake_events ADD COLUMN answers_cipher text;
--> statement-breakpoint
ALTER TABLE mca_submission_jobs ADD COLUMN approved_package_cipher text;
--> statement-breakpoint
CREATE TABLE intake_notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  intake_id text NOT NULL REFERENCES intake_events(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id),
  created_at text NOT NULL,
  read_at text,
  UNIQUE (workspace_id, intake_id, user_id)
);
--> statement-breakpoint
CREATE INDEX intake_notifications_recipient_idx ON intake_notifications(workspace_id, user_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE intake_submission_previews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  intake_id text NOT NULL REFERENCES intake_events(id) ON DELETE CASCADE,
  deal_id text NOT NULL REFERENCES deals(id),
  created_by_user_id text REFERENCES users(id),
  snapshot_cipher text NOT NULL,
  fingerprint text NOT NULL,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  confirmed_at text
);
--> statement-breakpoint
CREATE INDEX intake_submission_previews_intake_idx ON intake_submission_previews(workspace_id, intake_id, created_at DESC);
--> statement-breakpoint
UPDATE intake_integrations SET automatic_processing=1,
  automatic_since=to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
WHERE enabled=1 AND approval_state='approved' AND automatic_processing=0
  AND provider IN ('native','fundlane','jotform','highlevel','zoho','custom','fillout','docuseal');
--> statement-breakpoint
ALTER TABLE intake_notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE intake_submission_previews ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON intake_notifications, intake_submission_previews FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON intake_notifications, intake_submission_previews FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON intake_notifications, intake_submission_previews FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='mca_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON intake_notifications,intake_submission_previews TO mca_app;
    CREATE POLICY mca_server_access ON intake_notifications TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON intake_submission_previews TO mca_app USING (true) WITH CHECK (true);
  END IF;
END $$;

--> statement-breakpoint
UPDATE intake_events e SET integration_id=i.id,event_namespace=i.id
FROM intake_integrations i WHERE e.provider='native' AND e.event_namespace=''
AND e.workspace_id=i.workspace_id AND i.provider='native' AND i.form_id='apply'
AND NOT EXISTS (SELECT 1 FROM intake_events other WHERE other.workspace_id=e.workspace_id
 AND other.provider=e.provider AND other.provider_event_id=e.provider_event_id AND other.event_namespace=i.id);
