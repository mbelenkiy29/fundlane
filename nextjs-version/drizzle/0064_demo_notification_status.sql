ALTER TABLE marketing_demo_submissions
  ADD COLUMN notified_at timestamptz,
  ADD COLUMN notification_error text,
  ADD COLUMN notification_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN notification_lease_until timestamptz,
  ADD COLUMN notification_tracking_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Rows accepted before this migration have unknown delivery history. Only new
-- rows opt in to retryable notification tracking.
ALTER TABLE marketing_demo_submissions ALTER COLUMN notification_tracking_enabled SET DEFAULT true;
--> statement-breakpoint
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'mca_app') THEN
    GRANT UPDATE ON marketing_demo_submissions TO mca_app;
  END IF;
END
$grants$;
