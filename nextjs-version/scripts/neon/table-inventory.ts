export const APP_TABLES = [
  "mca_sms_accounts", "mca_sms_account_members", "mca_sms_consent_events", "mca_sms_messages", "mca_sms_status_events",
  "workspaces", "users", "memberships", "sessions", "invitations", "recovery_tokens", "api_keys",
  "api_rate_windows", "request_rate_windows", "audit_events",
  "deals", "deal_owners", "deal_assignments", "deal_notes", "deal_activity", "deal_submissions", "deal_offers",
  "mca_documents", "mca_application_confirmation_claims", "mca_application_extractions",
  "mca_application_scan_drafts", "mca_pdf_authorizations", "mca_pdf_generations",
  "mca_datamerch_config", "mca_datamerch_checks",
  "mca_funders", "mca_funder_groups", "mca_funder_criteria", "mca_funder_criteria_meta",
  "mca_industry_aliases", "mca_funder_criteria_scans",
  "import_sources", "lead_batches", "import_mapping_profiles", "import_runs", "import_rows",
  "import_archive_associations", "drive_connections", "drive_transfer_results", "drive_oauth_states",
  "intake_integrations", "intake_events", "intake_attachment_jobs", "intake_attribution_tokens", "intake_receipts",
  "mca_completeness_settings", "mca_completeness_results", "mca_readiness_events", "mca_statement_months",
  "mca_existing_positions", "mca_underwriting_aggregates", "mca_score_snapshots",
  "mca_analysis_settings", "mca_analysis_runs",
  "mca_review_settings", "mca_review_approvals",
  "mca_email_senders", "mca_email_sender_members", "mca_email_oauth_states",
  "mca_submission_jobs", "mca_submission_attempts", "mca_submission_outbox",
  "mca_adapter_credentials", "mca_outgoing_derivatives", "mca_funder_replies",
  "mca_submission_templates", "mca_stamp_settings", "mca_watermark_settings", "mca_compress_settings",
  "mca_offers", "mca_offer_revisions", "mca_offer_selections", "mca_manual_submissions",
  "mca_advances", "mca_funding_events", "mca_historical_import_runs", "mca_historical_import_rows",
  "mca_advance_status_history", "mca_accounting_payments", "mca_accounting_adjustments",
  "mca_split_templates", "mca_split_template_versions", "mca_payment_distributions",
  "mca_renewal_policies", "mca_renewal_actions",
  "mca_closing_stipulations", "mca_merchant_upload_links", "mca_closing_previews", "mca_closing_deliveries",
  "mca_contract_workflows", "mca_psf_config", "mca_psf_requests", "mca_offer_message_previews", "mca_pitch_events",
] as const;

export type AppTable = (typeof APP_TABLES)[number];

export function quoteIdentifier(identifier: string): string {
  if (!APP_TABLES.includes(identifier as AppTable) && identifier !== "mca_data_migrations") {
    throw new Error(`Unexpected database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function quoteColumn(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe column identifier: ${identifier}`);
  return `"${identifier}"`;
}
