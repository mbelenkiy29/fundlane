ALTER TABLE mca_merchant_upload_links
  ADD COLUMN IF NOT EXISTS token_cipher text;
--> statement-breakpoint
ALTER TABLE mca_offer_revisions
  ADD COLUMN IF NOT EXISTS expires_at text;
--> statement-breakpoint
UPDATE mca_offer_revisions
  SET expires_at = to_char((created_at::timestamptz + interval '14 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  WHERE expires_at IS NULL;
-- Task 4 sets expires_at NOT NULL after inserts supply it.
