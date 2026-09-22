CREATE TABLE company_subscription_state (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  legacy_exempt integer NOT NULL DEFAULT 0 CHECK (legacy_exempt IN (0,1)),
  trial_started_at text,
  trial_ends_at text,
  selected_seats integer NOT NULL DEFAULT 1 CHECK (selected_seats >= 1),
  pending_seats integer CHECK (pending_seats >= 1),
  pending_seats_at text,
  stripe_schedule_id text,
  manual_paused integer NOT NULL DEFAULT 0 CHECK (manual_paused IN (0,1)),
  manual_reason text,
  last_paused_at text,
  access_extended_until text,
  delinquent_since text,
  delinquent_invoice_id text,
  grace_ends_at text,
  processing_extension_until text,
  collection_paused integer NOT NULL DEFAULT 0 CHECK (collection_paused IN (0,1)),
  updated_at text NOT NULL
);
ALTER TABLE workspace_billing_entitlements DROP CONSTRAINT workspace_billing_entitlements_seat_limit_check;
ALTER TABLE workspace_billing_entitlements ADD CONSTRAINT workspace_billing_entitlements_seat_limit_check CHECK (seat_limit >= 1);
--> statement-breakpoint
-- Explicit migration exemption: no trial is started and no customer is charged.
INSERT INTO company_subscription_state (workspace_id, legacy_exempt, selected_seats, updated_at)
SELECT id, 1, greatest(seat_limit,1), updated_at FROM workspaces;
--> statement-breakpoint
CREATE FUNCTION protect_company_trial_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.last_paused_at IS NOT NULL AND (NEW.last_paused_at IS NULL OR NEW.last_paused_at < OLD.last_paused_at) THEN
    RAISE EXCEPTION 'Company pause history is monotonic';
  END IF;
  IF OLD.trial_started_at IS DISTINCT FROM NEW.trial_started_at OR OLD.trial_ends_at IS DISTINCT FROM NEW.trial_ends_at THEN
    RAISE EXCEPTION 'Company trial dates are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_company_trial BEFORE UPDATE ON company_subscription_state
FOR EACH ROW EXECUTE FUNCTION protect_company_trial_start();
--> statement-breakpoint
CREATE TABLE company_billing_invoices (
  stripe_invoice_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_subscription_id text,
  status text NOT NULL,
  billing_reason text,
  currency text NOT NULL,
  amount_due bigint NOT NULL,
  amount_paid bigint NOT NULL,
  amount_remaining bigint NOT NULL,
  invoice_url text,
  paid_at text,
  period_start text,
  period_end text,
  created_at text NOT NULL,
  synced_at text NOT NULL
);
CREATE INDEX company_billing_invoices_workspace ON company_billing_invoices(workspace_id, created_at);
CREATE TABLE company_billing_payments (
  stripe_payment_id text PRIMARY KEY,
  stripe_payment_intent_id text,
  stripe_invoice_id text NOT NULL REFERENCES company_billing_invoices(stripe_invoice_id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  synced_at text NOT NULL
);
CREATE TABLE company_billing_notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  data text NOT NULL,
  delivery_payload text,
  attempts integer NOT NULL DEFAULT 0,
  available_at text NOT NULL,
  lease_until text,
  delivered_at text,
  last_error text,
  created_at text NOT NULL
);
CREATE INDEX company_billing_notifications_due ON company_billing_notifications(available_at) WHERE delivered_at IS NULL;
ALTER TABLE workspace_stripe_customers ADD COLUMN livemode integer NOT NULL DEFAULT 0 CHECK (livemode IN (0,1));
CREATE TABLE company_billing_adjustments (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('refund','dispute')),
  stripe_charge_id text NOT NULL,
  stripe_payment_intent_id text,
  status text NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  reason text,
  livemode integer NOT NULL CHECK (livemode IN (0,1)),
  created_at text NOT NULL,
  synced_at text NOT NULL
);
CREATE INDEX company_billing_adjustments_workspace ON company_billing_adjustments(workspace_id,created_at);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_subscription_state','company_billing_invoices','company_billing_payments','company_billing_notifications','company_billing_adjustments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mca_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO mca_app', t);
      EXECUTE format('CREATE POLICY mca_server_access ON %I TO mca_app USING (true) WITH CHECK (true)', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
  END LOOP;
END $$;
