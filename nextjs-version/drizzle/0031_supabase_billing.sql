-- Clerk billing rows and webhook history remain untouched for migration traceability.
-- Stripe Sync Engine owns the stripe schema; these tables own application permissions.
CREATE TABLE workspace_stripe_customers (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  stripe_customer_id text NOT NULL UNIQUE,
  checkout_session_id text,
  checkout_plan_slug text,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE workspace_billing_entitlements (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  stripe_subscription_id text UNIQUE,
  stripe_price_id text,
  plan_slug text NOT NULL,
  plan_name text NOT NULL,
  status text NOT NULL,
  period_start text,
  period_end text,
  seat_limit integer NOT NULL CHECK (seat_limit IN (1, 5, 20)),
  payment_past_due integer NOT NULL DEFAULT 0 CHECK (payment_past_due IN (0, 1)),
  source text NOT NULL CHECK (source IN ('free', 'stripe_api', 'sync_engine')),
  synced_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE stripe_billing_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  stripe_customer_id text,
  workspace_id text REFERENCES workspaces(id),
  received_at text NOT NULL
);
--> statement-breakpoint
ALTER TABLE workspace_stripe_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_billing_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_billing_events ENABLE ROW LEVEL SECURITY;
-- No browser policies: all billing management uses server-authorized routes.
