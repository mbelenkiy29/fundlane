ALTER TABLE mca_sms_consent_events DROP CONSTRAINT mca_sms_consent_events_source_check;
--> statement-breakpoint
ALTER TABLE mca_sms_consent_events ADD CONSTRAINT mca_sms_consent_events_source_check CHECK (source IN ('manual', 'provider_webhook', 'keyword'));
