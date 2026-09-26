ALTER TABLE sms_companies ADD COLUMN refresh_attempted_at text;
--> statement-breakpoint
CREATE INDEX sms_companies_refresh_cursor_idx
  ON sms_companies (refresh_attempted_at ASC NULLS FIRST, workspace_id)
  WHERE provider_cipher IS NOT NULL;
