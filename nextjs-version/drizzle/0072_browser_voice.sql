CREATE TABLE voice_config (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),
 number_id text NOT NULL REFERENCES sms_numbers(id),
 application_sid text NOT NULL,
 callbacks_confirmed integer NOT NULL DEFAULT 0 CHECK(callbacks_confirmed IN (0,1)),
 updated_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE voice_presence (
 workspace_id text NOT NULL REFERENCES workspaces(id),
 membership_id text NOT NULL REFERENCES memberships(id),
 identity text NOT NULL UNIQUE,
 expires_at text NOT NULL,
 PRIMARY KEY(workspace_id,membership_id)
);
--> statement-breakpoint
CREATE TABLE voice_dial_intents (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 membership_id text NOT NULL REFERENCES memberships(id),
 deal_id text NOT NULL REFERENCES deals(id),
 number_id text NOT NULL REFERENCES sms_numbers(id),
 phone_cipher text NOT NULL,
 expires_at text NOT NULL,
 consumed_at text,
 canceled_at text,
 created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE voice_calls (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id),
 number_id text NOT NULL REFERENCES sms_numbers(id),
 account_sid text NOT NULL,
 provider_call_sid text NOT NULL,
 membership_id text REFERENCES memberships(id),
 recipient_memberships text NOT NULL DEFAULT '[]',
 deal_id text REFERENCES deals(id),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 state text NOT NULL CHECK(state IN ('ringing','completed','busy','no-answer','failed','canceled','missed')),
 phone_cipher text NOT NULL,
 company_phone_cipher text NOT NULL,
 terminal_at text,
 alert_pending integer NOT NULL DEFAULT 0 CHECK(alert_pending IN (0,1)),
 created_at text NOT NULL,
 UNIQUE(workspace_id,provider_call_sid)
);
--> statement-breakpoint
CREATE INDEX voice_history_workspace_idx ON voice_calls(workspace_id,created_at DESC);
CREATE INDEX voice_presence_lease_idx ON voice_presence(workspace_id,expires_at);
CREATE INDEX voice_intent_expiry_idx ON voice_dial_intents(workspace_id,expires_at);
--> statement-breakpoint
ALTER TABLE voice_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_dial_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON voice_config,voice_presence,voice_dial_intents,voice_calls FROM PUBLIC;
-- Reviewed server-runtime access follows existing mca_app trust boundaries.
-- Tenant/member authorization remains in the authenticated service; browser roles have no access.
--> statement-breakpoint
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON voice_config,voice_presence,voice_dial_intents,voice_calls FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON voice_config,voice_presence,voice_dial_intents,voice_calls FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT,INSERT,UPDATE ON voice_config,voice_dial_intents,voice_calls TO mca_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON voice_presence TO mca_app;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='voice_config' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON voice_config TO mca_app USING(true) WITH CHECK(true);
    END IF;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='voice_presence' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON voice_presence TO mca_app USING(true) WITH CHECK(true);
    END IF;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='voice_dial_intents' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON voice_dial_intents TO mca_app USING(true) WITH CHECK(true);
    END IF;
    IF NOT EXISTS(SELECT FROM pg_policies WHERE schemaname='public' AND tablename='voice_calls' AND policyname='mca_server_access') THEN
      CREATE POLICY mca_server_access ON voice_calls TO mca_app USING(true) WITH CHECK(true);
    END IF;
  END IF;
END
$grants$;
