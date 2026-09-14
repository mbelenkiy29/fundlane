CREATE TABLE IF NOT EXISTS mca_calendar_activities (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), deal_id text NOT NULL REFERENCES deals(id),
 assignee_id text NOT NULL REFERENCES memberships(id), kind text NOT NULL CHECK (kind IN ('call','followup','submission_task')),
 title text NOT NULL, starts_at text NOT NULL, ends_at text NOT NULL, all_day integer NOT NULL DEFAULT 0,
 timezone text NOT NULL, notes_cipher text, status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
 version integer NOT NULL DEFAULT 1, created_by text NOT NULL, created_at text NOT NULL, updated_at text NOT NULL,
 CHECK (all_day IN (0,1)), CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS mca_calendar_activities_range_idx ON mca_calendar_activities(workspace_id,starts_at,ends_at);
CREATE INDEX IF NOT EXISTS mca_calendar_activities_assignee_idx ON mca_calendar_activities(workspace_id,assignee_id);
CREATE TABLE IF NOT EXISTS mca_calendar_connections (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), user_id text NOT NULL REFERENCES users(id),
 membership_id text NOT NULL REFERENCES memberships(id), email text NOT NULL, credential_cipher text NOT NULL,
 calendar_id text, status text NOT NULL DEFAULT 'pending', last_sync_at text, next_sync_at text NOT NULL,
 failures integer NOT NULL DEFAULT 0, error text, created_at text NOT NULL, UNIQUE(workspace_id,user_id)
);
CREATE INDEX IF NOT EXISTS mca_calendar_connections_due_idx ON mca_calendar_connections(next_sync_at);
CREATE TABLE IF NOT EXISTS mca_calendar_oauth_states (
 state_hash text PRIMARY KEY, workspace_id text NOT NULL, user_id text NOT NULL, membership_id text NOT NULL,
 verifier_cipher text NOT NULL, expires_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS mca_calendar_sources (
 connection_id text NOT NULL REFERENCES mca_calendar_connections(id) ON DELETE CASCADE,
 calendar_id text NOT NULL, name text NOT NULL, selected integer NOT NULL DEFAULT 0, sync_token text,
 channel_id text, channel_token_hash text, resource_id text, channel_expires_at text,
 PRIMARY KEY(connection_id,calendar_id)
);
CREATE TABLE IF NOT EXISTS mca_calendar_external_events (
 connection_id text NOT NULL REFERENCES mca_calendar_connections(id) ON DELETE CASCADE,
 calendar_id text NOT NULL, event_id text NOT NULL, event_cipher text NOT NULL,
 PRIMARY KEY(connection_id,calendar_id,event_id)
);
CREATE TABLE IF NOT EXISTS mca_calendar_event_links (
 connection_id text NOT NULL REFERENCES mca_calendar_connections(id) ON DELETE CASCADE,
 activity_id text NOT NULL REFERENCES mca_calendar_activities(id), event_id text NOT NULL,
 etag text, local_version integer NOT NULL DEFAULT 0, baseline_json text,
 conflict_json text, resolution text CHECK (resolution IN ('local','google')),
 PRIMARY KEY(connection_id,activity_id), UNIQUE(connection_id,event_id)
);
-- Runtime grants are applied by db:secure, including these tables discovered from the journal.
ALTER TABLE mca_calendar_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_calendar_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_calendar_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_calendar_external_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE mca_calendar_event_links ENABLE ROW LEVEL SECURITY;

-- Preserve the first actual delivery timestamp; attempt creation can precede sending.
ALTER TABLE mca_submission_attempts ADD COLUMN IF NOT EXISTS sent_at text;
CREATE OR REPLACE FUNCTION mca_submission_capture_sent_at() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 IF NEW.state='sent' AND NEW.sent_at IS NULL THEN
   NEW.sent_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mca_submission_sent_at ON mca_submission_attempts;
CREATE TRIGGER mca_submission_sent_at BEFORE INSERT OR UPDATE OF state ON mca_submission_attempts
 FOR EACH ROW EXECUTE FUNCTION mca_submission_capture_sent_at();
CREATE UNIQUE INDEX IF NOT EXISTS mca_calendar_sources_channel_idx ON mca_calendar_sources(channel_id) WHERE channel_id IS NOT NULL;

-- Match db:secure without rotating credentials; safe during an additive release.
DO $$
DECLARE calendar_table text;
BEGIN
 FOR calendar_table IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
 ('mca_calendar_activities','mca_calendar_connections','mca_calendar_oauth_states','mca_calendar_sources','mca_calendar_external_events','mca_calendar_event_links') LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', calendar_table);
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', calendar_table); END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', calendar_table); END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
   EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO mca_app', calendar_table);
   EXECUTE format('DROP POLICY IF EXISTS mca_server_access ON public.%I', calendar_table);
   EXECUTE format('CREATE POLICY mca_server_access ON public.%I TO mca_app USING (true) WITH CHECK (true)', calendar_table);
  END IF;
 END LOOP;
END;
$$;
