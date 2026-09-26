CREATE TABLE IF NOT EXISTS company_trial_grants (
  workspace_id text PRIMARY KEY,
  stripe_subscription_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  owner_email text NOT NULL,
  email_domain text NOT NULL,
  card_fingerprint text,
  trial_started_at text NOT NULL,
  fingerprint_flagged_at text,
  fingerprint_prior_workspace_id text,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_grants_owner_user_idx ON company_trial_grants (owner_user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_grants_owner_email_idx ON company_trial_grants (owner_email);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_grants_domain_idx ON company_trial_grants (email_domain);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_grants_fingerprint_idx ON company_trial_grants (card_fingerprint) WHERE card_fingerprint IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS company_trial_reservations (
  workspace_id text PRIMARY KEY,
  checkout_session_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  owner_email text NOT NULL,
  email_domain text NOT NULL,
  expires_at text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_reservations_owner_user_idx ON company_trial_reservations (owner_user_id, expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_reservations_owner_email_idx ON company_trial_reservations (owner_email, expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS company_trial_reservations_domain_idx ON company_trial_reservations (email_domain, expires_at);
--> statement-breakpoint
ALTER TABLE company_trial_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_trial_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_trial_grants FROM PUBLIC;
REVOKE ALL ON company_trial_reservations FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON company_trial_grants FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON company_trial_grants FROM authenticated; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON company_trial_reservations FROM anon; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON company_trial_reservations FROM authenticated; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON company_trial_grants TO mca_app;
    CREATE POLICY mca_server_access ON company_trial_grants TO mca_app USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON company_trial_reservations TO mca_app;
    CREATE POLICY mca_server_access ON company_trial_reservations TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;
