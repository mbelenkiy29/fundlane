-- Unknown historical error times remain null; only new worker failures enter the alert window.
ALTER TABLE mca_email_conversations ADD COLUMN sync_error_at timestamptz;
