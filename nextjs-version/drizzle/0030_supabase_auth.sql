-- Explicit identity mapping; immutable MCA IDs and historical Clerk IDs remain intact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_user_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_supabase_user_id_key ON users (supabase_user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS auth_session_revocations (
  id text PRIMARY KEY,
  revoked_at text NOT NULL
);
--> statement-breakpoint
-- Old Clerk and legacy invitation links cannot activate accounts after cutover.
-- Preserve pending membership reservations, IDs and invitations for controlled resend.
-- Do not retire invitations already issued through the Supabase token scheme.
UPDATE invitations SET token_hash = 'retired:' || id, delivery_status = 'failed'
WHERE status = 'pending'
  AND token_hash NOT LIKE 'retired:%'
  AND token_hash NOT LIKE 'supabase:%';
