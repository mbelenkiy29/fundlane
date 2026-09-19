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
