ALTER TABLE stripe_billing_events ADD COLUMN enrollment_id text REFERENCES mca_enrollments(id);
CREATE INDEX stripe_billing_events_enrollment_idx ON stripe_billing_events(enrollment_id) WHERE enrollment_id IS NOT NULL;
--> statement-breakpoint
-- Current verified billing is separate from the immutable original activation.
CREATE TABLE mca_enrollment_billing_evidence (
  enrollment_id text PRIMARY KEY REFERENCES mca_enrollments(id),
  provider_account_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  snapshot_cipher text NOT NULL,
  verified_at text NOT NULL,
  FOREIGN KEY(enrollment_id,provider_account_id) REFERENCES mca_enrollments(id,provider_account_id)
);
CREATE FUNCTION mca_guard_enrollment_evidence_update() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF NEW.enrollment_id IS DISTINCT FROM OLD.enrollment_id OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
    OR NEW.revision<>OLD.revision+1 OR NEW.verified_at::timestamptz<OLD.verified_at::timestamptz
    THEN RAISE EXCEPTION 'invalid enrollment billing evidence revision' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $guard$;
CREATE TRIGGER mca_enrollment_evidence_update_guard BEFORE UPDATE ON mca_enrollment_billing_evidence FOR EACH ROW EXECUTE FUNCTION mca_guard_enrollment_evidence_update();
--> statement-breakpoint
-- Only pre-provider identity reservations: actual trial history remains on mca_enrollments.
CREATE TABLE mca_enrollment_trial_reservations (
  enrollment_id text PRIMARY KEY REFERENCES mca_enrollments(id),
  owner_user_id text REFERENCES users(id),
  provider_user_id uuid,
  email_hash text NOT NULL,
  domain_hash text NOT NULL,
  released_at text,
  created_at text NOT NULL
);
CREATE INDEX mca_enrollment_trial_reservations_owner_idx ON mca_enrollment_trial_reservations(owner_user_id);
CREATE INDEX mca_enrollment_trial_reservations_provider_idx ON mca_enrollment_trial_reservations(provider_user_id);
CREATE INDEX mca_enrollment_trial_reservations_email_idx ON mca_enrollment_trial_reservations(email_hash);
CREATE INDEX mca_enrollment_trial_reservations_domain_idx ON mca_enrollment_trial_reservations(domain_hash);
--> statement-breakpoint
DO $security$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['mca_enrollment_billing_evidence','mca_enrollment_trial_reservations'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',target);
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',target); END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',target); END IF;
    IF EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE public.%I TO mca_app',target);
      EXECUTE format('CREATE POLICY mca_server_access ON public.%I TO mca_app USING(true) WITH CHECK(true)',target);
    END IF;
  END LOOP;
END $security$;
