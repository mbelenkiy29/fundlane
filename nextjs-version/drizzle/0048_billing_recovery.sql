-- Preserve the one-grant-per-delinquency-episode boundary after revocation.
ALTER TABLE company_subscription_state ADD COLUMN processing_extension_granted_at text;
--> statement-breakpoint
UPDATE company_subscription_state
SET processing_extension_granted_at = updated_at
WHERE processing_extension_until IS NOT NULL;
