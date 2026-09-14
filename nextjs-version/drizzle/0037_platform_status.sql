CREATE SCHEMA IF NOT EXISTS mca_private;
CREATE TABLE mca_private.ops_health (
  checked_at timestamptz PRIMARY KEY, website_ok boolean NOT NULL, database_ok boolean NOT NULL,
  website_ms integer, database_ms integer, deployment text,
  metrics jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE mca_private.ops_errors (
  id uuid PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(),
  component text NOT NULL, code text NOT NULL, route text, correlation_id text, deployment text
);
CREATE INDEX ops_errors_time ON mca_private.ops_errors(occurred_at DESC,id);
CREATE TABLE mca_private.ops_activity (
  day date NOT NULL, user_id text NOT NULL, last_seen_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,user_id)
);
CREATE TABLE mca_private.ops_incidents (
  component text PRIMARY KEY, opened_at timestamptz, bad_checks integer NOT NULL DEFAULT 0,
  good_checks integer NOT NULL DEFAULT 0, last_sent_at timestamptz, pending_kind text,
  pending_id uuid, delivery_state text, last_attempt_at timestamptz
);
CREATE TABLE mca_private.ops_alert_attempts (
  id uuid PRIMARY KEY, component text NOT NULL, kind text NOT NULL,
  state text NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mca_private.ops_control (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), started_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz, last_started_at timestamptz
);
INSERT INTO mca_private.ops_control(id) VALUES(true);
REVOKE ALL ON mca_private.ops_health,mca_private.ops_errors,mca_private.ops_activity,mca_private.ops_incidents,mca_private.ops_alert_attempts,mca_private.ops_control FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON mca_private.ops_health,mca_private.ops_errors,mca_private.ops_activity,mca_private.ops_incidents,mca_private.ops_alert_attempts,mca_private.ops_control FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
    GRANT USAGE ON SCHEMA mca_private TO mca_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON mca_private.ops_health,mca_private.ops_errors,mca_private.ops_activity,mca_private.ops_incidents,mca_private.ops_alert_attempts,mca_private.ops_control TO mca_app;
  END IF;
END $$;

CREATE INDEX ops_activity_seen ON mca_private.ops_activity(last_seen_at);
CREATE INDEX ops_alert_attempts_time ON mca_private.ops_alert_attempts(attempted_at);
