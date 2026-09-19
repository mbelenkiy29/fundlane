ALTER TABLE mca_merchant_installments DROP CONSTRAINT IF EXISTS mca_merchant_installments_amount_check;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mca_merchant_installments_amount_check'
      AND conrelid = 'public.mca_merchant_installments'::regclass
  ) THEN
    ALTER TABLE mca_merchant_installments
      ADD CONSTRAINT mca_merchant_installments_amount_check CHECK (amount_cents >= 0);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE mca_merchant_receipts
  ADD COLUMN IF NOT EXISTS received_on text;
--> statement-breakpoint
UPDATE mca_merchant_receipts
  SET received_on = left(received_at, 10)
  WHERE received_on IS NULL;
--> statement-breakpoint
ALTER TABLE mca_merchant_receipts
  ALTER COLUMN received_on SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mca_merchant_receipts_received_on_idx
  ON mca_merchant_receipts (workspace_id, advance_id, received_on)
  WHERE status = 'received';
