-- Additive TOTP 2FA: nullable workspace policy plus user-scoped secrets and codes.
ALTER TABLE workspaces ADD COLUMN require_2fa boolean;
--> statement-breakpoint
CREATE TABLE user_totp_factors (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  secret_cipher text NOT NULL,
  last_used_counter bigint,
  confirmed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT user_totp_factors_status_check CHECK (status = ANY (ARRAY['pending'::text, 'enabled'::text]))
);
--> statement-breakpoint
CREATE TABLE user_totp_recovery_codes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at text,
  created_at text NOT NULL,
  CONSTRAINT user_totp_recovery_codes_user_hash_key UNIQUE (user_id, code_hash)
);
--> statement-breakpoint
CREATE INDEX user_totp_recovery_codes_user_idx ON user_totp_recovery_codes (user_id, used_at);
--> statement-breakpoint
CREATE TABLE auth_session_totp (
  session_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method text NOT NULL,
  verified_at text,
  created_at text NOT NULL,
  CONSTRAINT auth_session_totp_method_check CHECK (method = ANY (ARRAY['pending'::text, 'totp'::text, 'recovery'::text, 'google'::text, 'not_required'::text]))
);
--> statement-breakpoint
CREATE INDEX auth_session_totp_user_idx ON auth_session_totp (user_id);
--> statement-breakpoint
ALTER TABLE user_totp_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_totp_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_session_totp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_totp_factors, user_totp_recovery_codes, auth_session_totp FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON user_totp_factors, user_totp_recovery_codes, auth_session_totp FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON user_totp_factors, user_totp_recovery_codes, auth_session_totp FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_totp_factors, user_totp_recovery_codes, auth_session_totp TO mca_app;
    CREATE POLICY mca_server_access ON user_totp_factors TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON user_totp_recovery_codes TO mca_app USING (true) WITH CHECK (true);
    CREATE POLICY mca_server_access ON auth_session_totp TO mca_app USING (true) WITH CHECK (true);
  END IF;
END
$grants$;
