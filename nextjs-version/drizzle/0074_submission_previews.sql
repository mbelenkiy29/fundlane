-- Generic deals use the existing encrypted broker preview store without a fabricated intake event.
ALTER TABLE intake_submission_previews ALTER COLUMN intake_id DROP NOT NULL;
