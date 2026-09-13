CREATE TABLE mca_merchants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  legal_name text,
  dba_name text,
  ein_cipher text,
  ein_lookup_hash text,
  contact_name text,
  contact_email_cipher text,
  contact_phone_cipher text,
  address_json text DEFAULT '{}' NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
--> statement-breakpoint
CREATE INDEX mca_merchants_workspace_ein_lookup_hash_idx
  ON mca_merchants (workspace_id, ein_lookup_hash)
  WHERE ein_lookup_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX mca_merchants_workspace_id_idx ON mca_merchants (workspace_id);
--> statement-breakpoint
CREATE TABLE mca_merchant_owners (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  merchant_id text NOT NULL REFERENCES mca_merchants(id) ON DELETE CASCADE,
  first_name text,
  last_name text,
  ownership_percent double precision,
  is_primary integer DEFAULT 0 NOT NULL,
  date_of_birth_cipher text,
  identity_last4_cipher text,
  identity_last4_lookup_hash text,
  email_cipher text,
  phone_cipher text
);
--> statement-breakpoint
CREATE INDEX mca_merchant_owners_workspace_id_idx ON mca_merchant_owners (workspace_id);
--> statement-breakpoint
CREATE INDEX mca_merchant_owners_merchant_id_idx ON mca_merchant_owners (merchant_id);
--> statement-breakpoint
CREATE INDEX mca_merchant_owners_workspace_identity_last4_lookup_hash_idx
  ON mca_merchant_owners (workspace_id, identity_last4_lookup_hash)
  WHERE identity_last4_lookup_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN merchant_id text REFERENCES mca_merchants(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN ein_lookup_hash text;
--> statement-breakpoint
CREATE INDEX deals_merchant_id_idx ON deals (merchant_id);
--> statement-breakpoint
CREATE INDEX deals_workspace_ein_lookup_hash_idx
  ON deals (workspace_id, ein_lookup_hash)
  WHERE ein_lookup_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE deal_owners ADD COLUMN identity_last4_lookup_hash text;
--> statement-breakpoint
CREATE INDEX deal_owners_workspace_identity_last4_lookup_hash_idx
  ON deal_owners (workspace_id, identity_last4_lookup_hash)
  WHERE identity_last4_lookup_hash IS NOT NULL;
--> statement-breakpoint
ALTER TABLE mca_merchants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mca_merchant_owners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON mca_merchants, mca_merchant_owners FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON mca_merchants, mca_merchant_owners FROM authenticated;
  END IF;
END $$;
