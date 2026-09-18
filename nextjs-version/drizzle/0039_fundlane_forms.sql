ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS draft_cipher text;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS requested_amount_cents integer;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS last_step text;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS last_activity_at text;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS reminded_at text;
--> statement-breakpoint
ALTER TABLE mca_application_invitations ADD COLUMN IF NOT EXISTS business_name text;
--> statement-breakpoint
ALTER TABLE mca_application_invitation_deliveries ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'invite';
--> statement-breakpoint
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='mca_application_invitation_events'::regclass AND contype='c'
  LOOP EXECUTE format('ALTER TABLE mca_application_invitation_events DROP CONSTRAINT IF EXISTS %I', r.conname); END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE mca_application_invitation_events ADD CONSTRAINT mca_application_invitation_events_kind_check CHECK (kind IN ('opened','started','drafted','uploaded','reminded'));
--> statement-breakpoint
ALTER TABLE mca_application_invitation_deliveries DROP CONSTRAINT IF EXISTS mca_application_invitation_deliveries_purpose_check;
--> statement-breakpoint
ALTER TABLE mca_application_invitation_deliveries ADD CONSTRAINT mca_application_invitation_deliveries_purpose_check CHECK (purpose IN ('invite','reminder'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mca_application_invitation_files (
  id text PRIMARY KEY,
  invitation_id text NOT NULL REFERENCES mca_application_invitations(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  category text NOT NULL CHECK (category IN ('statement','application','driver_license','voided_check')),
  filename text NOT NULL,
  mime_type text NOT NULL,
  byte_length integer NOT NULL CHECK (byte_length > 0 AND byte_length <= 26214400),
  checksum text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  processing_state text NOT NULL CHECK (processing_state IN ('pending_upload','ready','upload_failed','pending_scan','clean','quarantined','scan_failed')),
  idempotency_key text NOT NULL,
  created_at text NOT NULL,
  UNIQUE (invitation_id, idempotency_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_invitation_files_idx ON mca_application_invitation_files(workspace_id, invitation_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mca_application_form_settings (
  integration_id text PRIMARY KEY REFERENCES intake_integrations(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  logo_object_key text,
  accent text,
  welcome_title text,
  welcome_body text,
  thank_you_title text,
  optional_fields_json text NOT NULL DEFAULT '{}',
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS intake_fundlane_form_once ON intake_integrations(workspace_id) WHERE provider = 'fundlane';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS application_invitation_reminder_idx ON mca_application_invitations(last_activity_at) WHERE submitted_at IS NULL AND revoked_at IS NULL;
--> statement-breakpoint
ALTER TABLE mca_application_invitation_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mca_application_form_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON mca_application_invitation_files, mca_application_form_settings FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON mca_application_invitation_files, mca_application_form_settings FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON mca_application_invitation_files, mca_application_form_settings FROM authenticated; END IF;
END $$;
