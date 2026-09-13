-- Explicit identity mapping; immutable MCA IDs and historical Clerk IDs remain intact.
ALTER TABLE users ADD COLUMN supabase_user_id uuid UNIQUE;
--> statement-breakpoint
CREATE TABLE auth_session_revocations (
  id text PRIMARY KEY,
  revoked_at text NOT NULL
);
--> statement-breakpoint
-- Old Clerk and legacy invitation links cannot activate accounts after cutover.
-- Preserve pending membership reservations, IDs and invitations for controlled resend.
UPDATE invitations SET token_hash = 'retired:' || id, delivery_status = 'failed'
WHERE status = 'pending';
