ALTER TABLE mca_statement_months
  ADD COLUMN IF NOT EXISTS nsf_dates text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE mca_statement_months
  ADD COLUMN IF NOT EXISTS negative_dates text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE mca_underwriting_aggregates
  ADD COLUMN IF NOT EXISTS deposit_count text NOT NULL DEFAULT '{"value":null,"unknown":true,"confidence":0}';
--> statement-breakpoint
ALTER TABLE mca_underwriting_aggregates
  ADD COLUMN IF NOT EXISTS worst_month_nsf text NOT NULL DEFAULT '{"value":null,"unknown":true,"confidence":0}';
--> statement-breakpoint
ALTER TABLE mca_underwriting_aggregates
  ADD COLUMN IF NOT EXISTS warnings_json text NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS requested_term_months integer;
