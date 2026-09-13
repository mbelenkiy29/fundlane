ALTER TABLE mca_advance_status_history DROP CONSTRAINT IF EXISTS mca_advance_status_history_status_check;
--> statement-breakpoint
ALTER TABLE mca_advance_status_history ADD CONSTRAINT mca_advance_status_history_status_check CHECK (status in ('on_track','missed_payment','default','renewed','closed','in_collections'));
--> statement-breakpoint
CREATE TABLE mca_merchant_installments (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  advance_id text NOT NULL REFERENCES mca_advances(id),
  sequence integer NOT NULL,
  occurrence_date text NOT NULL,
  amount_cents integer NOT NULL,
  created_at text NOT NULL,
  UNIQUE (workspace_id, advance_id, occurrence_date),
  UNIQUE (workspace_id, advance_id, sequence),
  CONSTRAINT mca_merchant_installments_sequence_check CHECK (sequence > 0),
  CONSTRAINT mca_merchant_installments_amount_check CHECK (amount_cents > 0)
);
--> statement-breakpoint
CREATE INDEX mca_merchant_installments_due_idx ON mca_merchant_installments (workspace_id, occurrence_date, advance_id);
--> statement-breakpoint
CREATE TABLE mca_merchant_receipts (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  advance_id text NOT NULL REFERENCES mca_advances(id),
  installment_id text REFERENCES mca_merchant_installments(id),
  amount_cents integer NOT NULL,
  received_at text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  created_by_user_id text,
  created_at text NOT NULL,
  UNIQUE (workspace_id, advance_id, idempotency_key),
  CONSTRAINT mca_merchant_receipts_amount_check CHECK (amount_cents > 0),
  CONSTRAINT mca_merchant_receipts_origin_check CHECK (origin in ('manual','csv','system')),
  CONSTRAINT mca_merchant_receipts_status_check CHECK (status in ('received','void'))
);
--> statement-breakpoint
CREATE INDEX mca_merchant_receipts_advance_idx ON mca_merchant_receipts (workspace_id, advance_id, received_at);
--> statement-breakpoint
CREATE TABLE mca_servicing_alerts (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  advance_id text NOT NULL REFERENCES mca_advances(id),
  installment_id text NOT NULL REFERENCES mca_merchant_installments(id),
  kind text NOT NULL,
  occurrence_date text NOT NULL,
  read_at text,
  created_at text NOT NULL,
  UNIQUE (workspace_id, advance_id, installment_id, kind),
  CONSTRAINT mca_servicing_alerts_kind_check CHECK (kind in ('missed_payment'))
);
--> statement-breakpoint
CREATE INDEX mca_servicing_alerts_unread_idx ON mca_servicing_alerts (workspace_id, created_at) WHERE read_at IS NULL;
--> statement-breakpoint
ALTER TABLE mca_merchant_installments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mca_merchant_receipts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mca_servicing_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON mca_merchant_installments, mca_merchant_receipts, mca_servicing_alerts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON mca_merchant_installments, mca_merchant_receipts, mca_servicing_alerts FROM authenticated;
  END IF;
END $$;
