ALTER TABLE mca_submission_jobs
  ADD COLUMN IF NOT EXISTS merchant_identity_key text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE mca_submission_jobs
  ADD COLUMN IF NOT EXISTS package_fingerprint text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE mca_submission_jobs
  SET merchant_identity_key = 'deal:' || deal_id
  WHERE merchant_identity_key = '';
--> statement-breakpoint
ALTER TABLE mca_submission_jobs DROP CONSTRAINT IF EXISTS mca_submission_jobs_state_check;
--> statement-breakpoint
ALTER TABLE mca_submission_jobs
  ADD CONSTRAINT mca_submission_jobs_state_check CHECK (
    state = ANY (ARRAY[
      'preflight_failed'::text,
      'queued'::text,
      'sending'::text,
      'sent'::text,
      'failed'::text,
      'skipped'::text,
      'pending_portal'::text,
      'blocked_duplicate'::text,
      'declined'::text,
      'funded'::text
    ])
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mca_submission_jobs_identity_funder_idx
  ON mca_submission_jobs (workspace_id, merchant_identity_key, funder_id, created_at);
