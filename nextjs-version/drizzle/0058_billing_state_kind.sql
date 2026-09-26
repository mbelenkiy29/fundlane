-- Classification is nullable for existing rows; this migration changes no data.
ALTER TABLE company_subscription_state ADD COLUMN IF NOT EXISTS state_kind text;
--> statement-breakpoint
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_subscription_state_kind_check') THEN
    ALTER TABLE company_subscription_state ADD CONSTRAINT company_subscription_state_kind_check
      CHECK (state_kind IN ('customer', 'internal_demo', 'synthetic', 'legacy_exempt'));
  END IF;
END $guard$;
