-- Nullable source facts; never infer source dates from publication timestamps.
ALTER TABLE mca_funder_criteria ADD COLUMN source_as_of text;
--> statement-breakpoint
ALTER TABLE mca_funder_criteria ADD COLUMN valid_until text;
