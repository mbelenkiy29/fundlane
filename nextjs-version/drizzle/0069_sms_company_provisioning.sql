ALTER TABLE sms_companies
  ADD COLUMN IF NOT EXISTS sender_type text CHECK (sender_type IN ('local','toll_free')),
  ADD COLUMN IF NOT EXISTS requested_area_code text CHECK (requested_area_code ~ '^[2-9][0-9]{2}$'),
  ADD COLUMN IF NOT EXISTS selected_phone text CHECK (selected_phone ~ '^\+1[0-9]{10}$'),
  ADD COLUMN IF NOT EXISTS provisioning_state text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS provisioning_reason text,
  ADD COLUMN IF NOT EXISTS content_cipher text,
  ADD COLUMN IF NOT EXISTS content_version text,
  ADD COLUMN IF NOT EXISTS attestation_json text,
  ADD COLUMN IF NOT EXISTS submitted_at text,
  ADD COLUMN IF NOT EXISTS submitted_by_user_id text,
  ADD COLUMN IF NOT EXISTS operator_approved_at text,
  ADD COLUMN IF NOT EXISTS approved_at text,
  ADD COLUMN IF NOT EXISTS resubmission_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_poll_at text,
  ADD COLUMN IF NOT EXISTS poll_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS release_scheduled_for text,
  ADD COLUMN IF NOT EXISTS released_at text,
  ADD COLUMN IF NOT EXISTS release_reason text,
  ADD COLUMN IF NOT EXISTS overage_cap_cents integer CHECK (overage_cap_cents IS NULL OR overage_cap_cents >= 0),
  ADD COLUMN IF NOT EXISTS onboarding_exempt integer NOT NULL DEFAULT 0 CHECK (onboarding_exempt IN (0,1)),
  ADD COLUMN IF NOT EXISTS public_slug text UNIQUE;
--> statement-breakpoint
ALTER TABLE sms_companies ADD CONSTRAINT sms_companies_provisioning_state_check CHECK (provisioning_state IN (
  'not_started','draft','submitted','operator_review','provisioning','number_acquired',
  'profile_pending','brand_pending','campaign_pending','number_registering','tfv_pending',
  'action_required','resubmitting','active','paused','release_scheduled','releasing','released',
  'rejected_final','needs_review'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sms_companies_poll_idx ON sms_companies (next_poll_at)
  WHERE provisioning_state IN ('provisioning','number_acquired','profile_pending','brand_pending',
    'campaign_pending','number_registering','tfv_pending','resubmitting','release_scheduled','releasing');
--> statement-breakpoint
UPDATE sms_companies c SET onboarding_exempt=1 WHERE c.workspace_id <> 'a2672c56-c652-4eed-9243-bf2b760a384c'
  AND (c.workspace_id IN ('e533f62c-f92f-4367-990e-9e91c47c23bb','c880cbaf-f18d-4050-beab-840220624406',
    '5fbcdb18-9f64-48f1-99f5-4b5055262e8b','7a0377b5-42d3-4939-a31b-11a75efc7710',
    '8ecf9c6b-d269-4694-b016-ac48b5727c21') OR EXISTS (
      SELECT 1 FROM company_subscription_state s WHERE s.workspace_id=c.workspace_id AND s.state_kind IN ('internal_demo','synthetic')));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sms_registrations (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('customer_profile','trust_product','brand','campaign','tollfree_verification')),
  attempt integer NOT NULL, provider_sid text, status text NOT NULL, provider_status text,
  rejection_codes text, rejection_detail_cipher text, edit_allowed_until text,
  fee_estimate_cents integer NOT NULL DEFAULT 0,
  submitted_at text, decided_at text, created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE (workspace_id,kind,attempt));
--> statement-breakpoint
ALTER TABLE sms_numbers
  ADD COLUMN IF NOT EXISTS number_type text NOT NULL DEFAULT 'local' CHECK (number_type IN ('local','toll_free')),
  ADD COLUMN IF NOT EXISTS tfv_sid text,
  ADD COLUMN IF NOT EXISTS released_at text,
  ADD COLUMN IF NOT EXISTS release_reason text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sms_company_number ON sms_numbers (workspace_id) WHERE state <> 'released';
--> statement-breakpoint
ALTER TABLE mca_sms_accounts ADD COLUMN IF NOT EXISTS shared integer NOT NULL DEFAULT 0 CHECK (shared IN (0,1));
--> statement-breakpoint
ALTER TABLE mca_sms_messages
  ADD COLUMN IF NOT EXISTS num_segments integer CHECK (num_segments IS NULL OR num_segments > 0),
  ADD COLUMN IF NOT EXISTS segments_source text CHECK (segments_source IN ('provider','estimate')),
  ADD COLUMN IF NOT EXISTS final_status_at text,
  ADD COLUMN IF NOT EXISTS billing_period_start text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sms_meter_events (
  id text PRIMARY KEY, workspace_id text NOT NULL, message_id text NOT NULL UNIQUE,
  stripe_customer_id text, segments integer NOT NULL CHECK (segments > 0),
  occurred_at text NOT NULL, state text NOT NULL CHECK (state IN ('pending','sent','skipped','failed','needs_review')),
  skip_reason text, attempts integer NOT NULL DEFAULT 0, last_error_code text,
  sent_at text, created_at text NOT NULL, updated_at text NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sms_meter_events_pending_idx ON sms_meter_events (created_at) WHERE state='pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sms_usage_periods (
  workspace_id text NOT NULL, period_start text NOT NULL, period_end text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('trial','subscription','exempt')),
  included_segments integer NOT NULL, used_segments integer NOT NULL DEFAULT 0,
  reserved_segments integer NOT NULL DEFAULT 0, cap_segments integer,
  alert_80_at text, alert_100_at text, cap_hit_at text, updated_at text NOT NULL,
  PRIMARY KEY (workspace_id,period_start));
--> statement-breakpoint
ALTER TABLE sms_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_meter_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_usage_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_registrations, sms_meter_events, sms_usage_periods FROM PUBLIC;
DO $grants$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['sms_registrations','sms_meter_events','sms_usage_periods'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', table_name);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', table_name);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname='mca_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mca_app', table_name);
      IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public' AND tablename=table_name AND policyname='mca_server_access') THEN
        EXECUTE format('CREATE POLICY mca_server_access ON %I TO mca_app USING (true) WITH CHECK (true)', table_name);
      END IF;
    END IF;
  END LOOP;
END
$grants$;
