CREATE TABLE company_signup_intents (
 id text PRIMARY KEY,
 token_hash text NOT NULL UNIQUE,
 token_cipher text NOT NULL,
 checkout_session_id text UNIQUE,
 checkout_email text,
 payment_method_id text,
 livemode integer NOT NULL CHECK (livemode IN (0,1)),
 state text NOT NULL CHECK (state IN ('pending','ready','activating','paid_initializing','paid_required','active')),
 workspace_id text UNIQUE REFERENCES workspaces(id),
 user_id text REFERENCES users(id),
 activation_started_at text,
 subscription_id text UNIQUE,
 email_sent_at text,
 email_retry_until text,
 expires_at text NOT NULL,
 created_at text NOT NULL,
 updated_at text NOT NULL
);
--> statement-breakpoint
ALTER TABLE company_signup_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON company_signup_intents FROM PUBLIC;
DO $grants$
BEGIN
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON company_signup_intents FROM anon; END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON company_signup_intents FROM authenticated; END IF;
 IF EXISTS (SELECT FROM pg_roles WHERE rolname='mca_app') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON company_signup_intents TO mca_app;
  CREATE POLICY mca_server_access ON company_signup_intents TO mca_app USING (true) WITH CHECK (true);
 END IF;
END $grants$;
