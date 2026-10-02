-- Additive, default-off pre-company onboarding. No existing tenant/profile writes.
CREATE UNIQUE INDEX users_id_supabase_user_id_unique ON users(id,supabase_user_id);
CREATE UNIQUE INDEX mca_email_senders_workspace_id_id_unique ON mca_email_senders(workspace_id,id);
--> statement-breakpoint
CREATE TABLE mca_enrollments (
  id text PRIMARY KEY,
  resume_secret_hash text NOT NULL UNIQUE CHECK(resume_secret_hash ~ '^[0-9a-f]{64}$'),
  offer_json text NOT NULL,
  provider_account_id text NOT NULL,
  initiating_provider_user_id uuid,
  claimed_provider_user_id uuid,
  user_id text REFERENCES users(id),
  workspace_id text UNIQUE REFERENCES workspaces(id),
  checkout_state text NOT NULL DEFAULT 'created' CHECK(checkout_state IN ('created','creating','open','complete','expired','uncertain')),
  billing_state text NOT NULL DEFAULT 'pending' CHECK(billing_state IN ('pending','trialing','active','paused','incomplete','incomplete_expired','past_due','unpaid','canceled','blocked')),
  claim_state text NOT NULL DEFAULT 'unclaimed' CHECK(claim_state IN ('unclaimed','claiming','claimed','blocked')),
  finalization_state text NOT NULL DEFAULT 'pending' CHECK(finalization_state IN ('pending','complete','blocked')),
  recovery_state text NOT NULL DEFAULT 'none' CHECK(recovery_state IN ('none','pending','canceling','canceled','uncertain','operator_required')),
  checkout_session_id text UNIQUE,
  customer_id text UNIQUE,
  subscription_id text UNIQUE,
  contact_cipher text,
  provider_snapshot_cipher text,
  email_hash text,
  email_domain_hash text,
  activation_email_hash text,
  activation_email_domain_hash text,
  trial_started_at text,
  trial_ends_at text,
  activated_at text,
  verified_at text,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  activation_version integer NOT NULL DEFAULT 1 CHECK(activation_version=1),
  checkout_generation integer NOT NULL DEFAULT 1 CHECK(checkout_generation > 0),
  resume_generation integer NOT NULL DEFAULT 1 CHECK(resume_generation > 0),
  email_generation integer NOT NULL DEFAULT 1 CHECK(email_generation > 0),
  checkout_request_key text NOT NULL UNIQUE,
  checkout_requested_at text,
  checkout_expires_at text,
  claim_token text,
  lease_until text,
  next_reconcile_at text NOT NULL,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(id,workspace_id),
  UNIQUE(id,provider_account_id),
  FOREIGN KEY(user_id,claimed_provider_user_id) REFERENCES users(id,supabase_user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id),
  CHECK((trial_started_at IS NULL AND trial_ends_at IS NULL) OR
    (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND trial_ends_at::timestamptz-trial_started_at::timestamptz=interval '14 days')),
  CHECK((claim_token IS NULL) = (lease_until IS NULL)),
  CHECK(claim_state <> 'claimed' OR (workspace_id IS NOT NULL AND user_id IS NOT NULL AND claimed_provider_user_id IS NOT NULL AND finalization_state='complete' AND activated_at IS NOT NULL)),
  CHECK(finalization_state <> 'complete' OR claim_state='claimed'),
  CHECK(activated_at IS NULL OR (checkout_session_id IS NOT NULL AND customer_id IS NOT NULL AND subscription_id IS NOT NULL AND contact_cipher IS NOT NULL AND provider_snapshot_cipher IS NOT NULL AND email_hash IS NOT NULL AND email_domain_hash IS NOT NULL AND activation_email_hash IS NOT NULL AND activation_email_domain_hash IS NOT NULL AND trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND verified_at IS NOT NULL)),
  CONSTRAINT mca_enrollments_offer_check CHECK(
    COALESCE(jsonb_typeof(offer_json::jsonb)='object' AND
    (offer_json::jsonb @> '{"version":1,"currency":"usd","baseAmount":39900,"quantity":1,"trialDays":14}') AND
    offer_json::jsonb->>'accountId'=provider_account_id AND provider_account_id ~ '^acct_[A-Za-z0-9]+$' AND
    offer_json::jsonb->>'basePriceId' ~ '^price_[A-Za-z0-9]+$' AND offer_json::jsonb->>'seatPriceId' ~ '^price_[A-Za-z0-9]+$' AND
    offer_json::jsonb->>'basePriceId'<>offer_json::jsonb->>'seatPriceId' AND
    jsonb_typeof(offer_json::jsonb->'livemode')='boolean' AND jsonb_typeof(offer_json::jsonb->'promotionCodes')='boolean' AND jsonb_typeof(offer_json::jsonb->'automaticTax')='boolean',false))
);
--> statement-breakpoint
CREATE INDEX mca_enrollments_repair_idx ON mca_enrollments(next_reconcile_at,lease_until);
CREATE INDEX mca_enrollments_claim_idx ON mca_enrollments(claim_state,email_hash);
CREATE INDEX mca_enrollments_trial_email_idx ON mca_enrollments(activation_email_hash,trial_started_at);
CREATE INDEX mca_enrollments_trial_domain_idx ON mca_enrollments(activation_email_domain_hash,trial_started_at);
CREATE INDEX mca_enrollments_initiator_idx ON mca_enrollments(initiating_provider_user_id);
--> statement-breakpoint
-- Row revisions fence all service writes; immutable dates and original trial
-- identity survive late verification, recovery, reconciliation and compensation.
CREATE FUNCTION mca_guard_enrollment_update() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.revision <> OLD.revision+1 THEN RAISE EXCEPTION 'enrollment revision must advance exactly once' USING ERRCODE='23514'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.offer_json IS DISTINCT FROM OLD.offer_json OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.initiating_provider_user_id IS DISTINCT FROM OLD.initiating_provider_user_id
    OR NEW.activation_version IS DISTINCT FROM OLD.activation_version THEN RAISE EXCEPTION 'immutable enrollment identity or offer' USING ERRCODE='23514'; END IF;
  IF (OLD.trial_started_at IS NOT NULL AND NEW.trial_started_at IS DISTINCT FROM OLD.trial_started_at)
    OR (OLD.trial_ends_at IS NOT NULL AND NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at)
    OR (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.activation_email_hash IS NOT NULL AND NEW.activation_email_hash IS DISTINCT FROM OLD.activation_email_hash)
    OR (OLD.activation_email_domain_hash IS NOT NULL AND NEW.activation_email_domain_hash IS DISTINCT FROM OLD.activation_email_domain_hash)
    OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id)
    OR (OLD.subscription_id IS NOT NULL AND NEW.subscription_id IS DISTINCT FROM OLD.subscription_id)
    OR (OLD.activated_at IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
    OR (OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS DISTINCT FROM OLD.workspace_id)
    OR (OLD.claimed_provider_user_id IS NOT NULL AND NEW.claimed_provider_user_id IS DISTINCT FROM OLD.claimed_provider_user_id)
    OR (OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id) THEN RAISE EXCEPTION 'immutable enrollment trial or ownership' USING ERRCODE='23514'; END IF;
  IF NEW.checkout_generation < OLD.checkout_generation OR NEW.resume_generation < OLD.resume_generation OR NEW.email_generation < OLD.email_generation
    THEN RAISE EXCEPTION 'enrollment generation cannot regress' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER mca_enrollments_update_guard BEFORE UPDATE ON mca_enrollments FOR EACH ROW EXECUTE FUNCTION mca_guard_enrollment_update();
--> statement-breakpoint
-- Retain every generation's create identity even after the current session expires.
CREATE TABLE mca_enrollment_checkout_requests (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES mca_enrollments(id),
  generation integer NOT NULL CHECK(generation > 0),
  request_key text NOT NULL UNIQUE,
  request_cipher text NOT NULL,
  payload_hash text NOT NULL,
  provider_account_id text NOT NULL,
  state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','open','complete','expired','uncertain','operator_required')),
  checkout_session_id text UNIQUE,
  requested_at text NOT NULL,
  idempotency_expires_at text NOT NULL,
  checkout_expires_at text,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  updated_at text NOT NULL,
  UNIQUE(enrollment_id,generation),
  FOREIGN KEY(enrollment_id,provider_account_id) REFERENCES mca_enrollments(id,provider_account_id),
  CHECK(idempotency_expires_at::timestamptz>requested_at::timestamptz)
);
--> statement-breakpoint
CREATE INDEX mca_enrollment_checkout_requests_repair_idx ON mca_enrollment_checkout_requests(state,requested_at);
CREATE FUNCTION mca_guard_checkout_request_update() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.request_key IS DISTINCT FROM OLD.request_key OR NEW.request_cipher IS DISTINCT FROM OLD.request_cipher OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.idempotency_expires_at IS DISTINCT FROM OLD.idempotency_expires_at
    OR (OLD.checkout_session_id IS NOT NULL AND NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id)
    THEN RAISE EXCEPTION 'immutable checkout request identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER mca_checkout_requests_update_guard BEFORE UPDATE ON mca_enrollment_checkout_requests FOR EACH ROW EXECUTE FUNCTION mca_guard_checkout_request_update();
--> statement-breakpoint
CREATE TABLE mca_enrollment_challenges (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES mca_enrollments(id),
  purpose text NOT NULL CHECK(purpose IN ('authentication','contact_recovery')),
  token_hash text NOT NULL UNIQUE,
  email_cipher text NOT NULL,
  email_hash text NOT NULL,
  provider_user_id uuid,
  authorized_by_user_id text REFERENCES users(id),
  purchase_evidence_hash text,
  resume_generation integer NOT NULL CHECK(resume_generation > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','consumed','expired','revoked')),
  expires_at text NOT NULL,
  verified_at text,
  consumed_at text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK(expires_at::timestamptz>created_at::timestamptz AND expires_at::timestamptz<=created_at::timestamptz+interval '1 day')
);
--> statement-breakpoint
CREATE INDEX mca_enrollment_challenges_expiry_idx ON mca_enrollment_challenges(enrollment_id,state,expires_at);
CREATE INDEX mca_enrollment_challenges_email_idx ON mca_enrollment_challenges(email_hash,purpose,expires_at);
--> statement-breakpoint
CREATE TABLE mca_onboarding_service_emails (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES mca_enrollments(id),
  activation_version integer NOT NULL CHECK(activation_version=1),
  purpose text NOT NULL CHECK(purpose IN ('business_information_requested','getting_started')),
  generation integer NOT NULL CHECK(generation > 0),
  delivery_key text NOT NULL UNIQUE,
  workspace_id text,
  payload_cipher text NOT NULL,
  recipient_cipher text,
  content_cipher text,
  provider_config_cipher text,
  recipient_hash text NOT NULL,
  payload_hash text NOT NULL,
  template_version integer NOT NULL CHECK(template_version > 0),
  provider text,
  provider_account_id text,
  frozen_at text,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','retry','accepted','delivered','failed','uncertain','suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  next_attempt_at text NOT NULL,
  claim_token text,
  lease_until text,
  provider_message_id text,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  superseded_by_generation integer CHECK(superseded_by_generation > generation),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(enrollment_id,id),
  UNIQUE(enrollment_id,activation_version,purpose,generation),
  FOREIGN KEY(enrollment_id,workspace_id) REFERENCES mca_enrollments(id,workspace_id),
  CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX mca_onboarding_emails_due_idx ON mca_onboarding_service_emails(state,next_attempt_at);
CREATE INDEX mca_onboarding_emails_lease_idx ON mca_onboarding_service_emails(state,lease_until);
CREATE UNIQUE INDEX mca_onboarding_emails_provider_idx ON mca_onboarding_service_emails(provider,provider_account_id,provider_message_id) WHERE provider_message_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION mca_guard_onboarding_email_update() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id OR NEW.activation_version IS DISTINCT FROM OLD.activation_version
    OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.delivery_key IS DISTINCT FROM OLD.delivery_key
    OR NEW.payload_cipher IS DISTINCT FROM OLD.payload_cipher OR NEW.recipient_hash IS DISTINCT FROM OLD.recipient_hash OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.template_version IS DISTINCT FROM OLD.template_version OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN RAISE EXCEPTION 'immutable onboarding email intent' USING ERRCODE='23514'; END IF;
  IF OLD.frozen_at IS NOT NULL AND (NEW.frozen_at IS DISTINCT FROM OLD.frozen_at OR NEW.recipient_cipher IS DISTINCT FROM OLD.recipient_cipher
    OR NEW.content_cipher IS DISTINCT FROM OLD.content_cipher OR NEW.provider_config_cipher IS DISTINCT FROM OLD.provider_config_cipher
    OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id)
    THEN RAISE EXCEPTION 'immutable frozen onboarding email content' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER mca_onboarding_emails_update_guard BEFORE UPDATE ON mca_onboarding_service_emails FOR EACH ROW EXECUTE FUNCTION mca_guard_onboarding_email_update();
--> statement-breakpoint
CREATE TABLE mca_onboarding_service_email_receipts (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL REFERENCES mca_enrollments(id),
  email_id text NOT NULL,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  event_key text NOT NULL,
  state text NOT NULL CHECK(state IN ('accepted','delivered','retry','failed','uncertain','suppressed','bounced','complained')),
  provider_message_id text,
  evidence_type text NOT NULL CHECK(evidence_type IN ('provider_response','verified_webhook','verified_lookup','operator_review')),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  occurred_at text NOT NULL,
  observed_at text NOT NULL,
  UNIQUE(provider,provider_account_id,event_key),
  FOREIGN KEY(enrollment_id,email_id) REFERENCES mca_onboarding_service_emails(enrollment_id,id)
);
--> statement-breakpoint
CREATE INDEX mca_onboarding_receipts_email_idx ON mca_onboarding_service_email_receipts(enrollment_id,email_id,observed_at);
CREATE TABLE mca_service_email_suppressions (
  recipient_hash text NOT NULL,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('bounce','complaint','invalid_address','safety')),
  active boolean NOT NULL DEFAULT true,
  evidence_receipt_id text REFERENCES mca_onboarding_service_email_receipts(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY(recipient_hash,provider,provider_account_id)
);
--> statement-breakpoint
CREATE TABLE company_basic_profiles (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  profile_cipher text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  revision integer NOT NULL CHECK(revision > 0),
  supplied_at text NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  last_mutation_key text,
  last_mutation_hash text,
  updated_at text NOT NULL,
  FOREIGN KEY(workspace_id,updated_by_user_id) REFERENCES memberships(workspace_id,user_id),
  CHECK((last_mutation_key IS NULL)=(last_mutation_hash IS NULL))
);
--> statement-breakpoint
CREATE TABLE mca_sender_test_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  sender_id text NOT NULL,
  request_key text NOT NULL,
  sender_fingerprint text NOT NULL,
  recipient_cipher text NOT NULL,
  recipient_hash text NOT NULL,
  recipient_control_confirmed boolean NOT NULL CHECK(recipient_control_confirmed),
  provider text,
  state text NOT NULL CHECK(state IN ('sending','preview','accepted','received','uncertain','failed')),
  provider_message_id text,
  claim_token text,
  lease_until text,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  accepted_at text,
  received_at text,
  evidence_source text CHECK(evidence_source IN ('user_confirmed','provider_delivered')),
  created_by_user_id text REFERENCES users(id),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE(workspace_id,id),
  UNIQUE(workspace_id,sender_id,request_key),
  FOREIGN KEY(workspace_id,sender_id) REFERENCES mca_email_senders(workspace_id,id),
  CHECK((claim_token IS NULL)=(lease_until IS NULL))
);
--> statement-breakpoint
CREATE INDEX mca_sender_tests_latest_idx ON mca_sender_test_runs(workspace_id,sender_id,created_at);
--> statement-breakpoint
DO $security$
DECLARE target text; privileges text;
BEGIN
  FOREACH target IN ARRAY ARRAY['mca_enrollments','mca_enrollment_checkout_requests','mca_enrollment_challenges','mca_onboarding_service_emails','mca_onboarding_service_email_receipts','mca_service_email_suppressions','company_basic_profiles','mca_sender_test_runs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',target);
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',target); END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',target); END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
      privileges := CASE WHEN target='mca_onboarding_service_email_receipts' THEN 'SELECT,INSERT' ELSE 'SELECT,INSERT,UPDATE' END;
      EXECUTE format('GRANT %s ON TABLE public.%I TO mca_app',privileges,target);
      EXECUTE format('CREATE POLICY mca_server_access ON public.%I TO mca_app USING(true) WITH CHECK(true)',target);
    END IF;
  END LOOP;
END $security$;
