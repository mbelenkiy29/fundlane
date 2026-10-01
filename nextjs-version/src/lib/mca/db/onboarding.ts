import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships, mca_email_senders, users, workspaces } from "./schema";
import type { EnrollmentBillingState, EnrollmentCheckoutState, EnrollmentClaimState, EnrollmentFinalizationState, EnrollmentRecoveryState, OnboardingEmailPurpose, OnboardingEmailState } from "../onboarding/contracts";

export const mcaEnrollments = pgTable("mca_enrollments", {
  id: text().primaryKey(), resume_secret_hash: text().notNull().unique(), offer_json: text().notNull(), provider_account_id: text().notNull(),
  initiating_provider_user_id: uuid(), claimed_provider_user_id: uuid(), user_id: text().references(() => users.id), workspace_id: text().unique().references(() => workspaces.id),
  checkout_state: text().$type<EnrollmentCheckoutState>().notNull().default("created"),
  billing_state: text().$type<EnrollmentBillingState>().notNull().default("pending"),
  claim_state: text().$type<EnrollmentClaimState>().notNull().default("unclaimed"),
  finalization_state: text().$type<EnrollmentFinalizationState>().notNull().default("pending"),
  recovery_state: text().$type<EnrollmentRecoveryState>().notNull().default("none"),
  checkout_session_id: text().unique(), customer_id: text().unique(), subscription_id: text().unique(),
  contact_cipher: text(), provider_snapshot_cipher: text(), email_hash: text(), email_domain_hash: text(), activation_email_hash: text(), activation_email_domain_hash: text(),
  trial_started_at: text(), trial_ends_at: text(), activated_at: text(), verified_at: text(),
  revision: integer().notNull().default(1), activation_version: integer().notNull().default(1), checkout_generation: integer().notNull().default(1),
  resume_generation: integer().notNull().default(1), email_generation: integer().notNull().default(1),
  checkout_request_key: text().notNull().unique(), checkout_requested_at: text(), checkout_expires_at: text(),
  claim_token: text(), lease_until: text(), next_reconcile_at: text().notNull(), error_code: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, t => [
  unique("mca_enrollments_id_workspace_id_key").on(t.id, t.workspace_id),
  unique("mca_enrollments_id_provider_account_id_key").on(t.id, t.provider_account_id),
  foreignKey({ columns: [t.user_id, t.claimed_provider_user_id], foreignColumns: [users.id, users.supabase_user_id] }),
  foreignKey({ columns: [t.workspace_id, t.user_id], foreignColumns: [memberships.workspace_id, memberships.user_id] }),
  index("mca_enrollments_repair_idx").on(t.next_reconcile_at, t.lease_until),
  index("mca_enrollments_claim_idx").on(t.claim_state, t.email_hash),
  index("mca_enrollments_trial_email_idx").on(t.activation_email_hash, t.trial_started_at),
  index("mca_enrollments_trial_domain_idx").on(t.activation_email_domain_hash, t.trial_started_at),
  index("mca_enrollments_initiator_idx").on(t.initiating_provider_user_id),
  check("mca_enrollments_resume_secret_hash_check", sql`resume_secret_hash ~ '^[0-9a-f]{64}$'`),
  check("mca_enrollments_checkout_state_check", sql`checkout_state IN ('created','creating','open','complete','expired','uncertain')`),
  check("mca_enrollments_billing_state_check", sql`billing_state IN ('pending','trialing','active','paused','incomplete','incomplete_expired','past_due','unpaid','canceled','blocked')`),
  check("mca_enrollments_claim_state_check", sql`claim_state IN ('unclaimed','claiming','claimed','blocked')`),
  check("mca_enrollments_finalization_state_check", sql`finalization_state IN ('pending','complete','blocked')`),
  check("mca_enrollments_recovery_state_check", sql`recovery_state IN ('none','pending','canceling','canceled','uncertain','operator_required')`),
  check("mca_enrollments_revision_check", sql`revision > 0`),
  check("mca_enrollments_activation_version_check", sql`activation_version=1`),
  check("mca_enrollments_checkout_generation_check", sql`checkout_generation > 0`),
  check("mca_enrollments_resume_generation_check", sql`resume_generation > 0`),
  check("mca_enrollments_email_generation_check", sql`email_generation > 0`),
  check("mca_enrollments_error_code_check", sql`error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'`),
  check("mca_enrollments_trial_dates_check", sql`(trial_started_at IS NULL AND trial_ends_at IS NULL) OR (trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND trial_ends_at::timestamptz-trial_started_at::timestamptz=interval '14 days')`),
  check("mca_enrollments_lease_check", sql`(claim_token IS NULL)=(lease_until IS NULL)`),
  check("mca_enrollments_claim_complete_check", sql`claim_state <> 'claimed' OR (workspace_id IS NOT NULL AND user_id IS NOT NULL AND claimed_provider_user_id IS NOT NULL AND finalization_state='complete' AND activated_at IS NOT NULL)`),
  check("mca_enrollments_finalization_complete_check", sql`finalization_state <> 'complete' OR claim_state='claimed'`),
  check("mca_enrollments_activation_check", sql`activated_at IS NULL OR (checkout_session_id IS NOT NULL AND customer_id IS NOT NULL AND subscription_id IS NOT NULL AND contact_cipher IS NOT NULL AND provider_snapshot_cipher IS NOT NULL AND email_hash IS NOT NULL AND email_domain_hash IS NOT NULL AND activation_email_hash IS NOT NULL AND activation_email_domain_hash IS NOT NULL AND trial_started_at IS NOT NULL AND trial_ends_at IS NOT NULL AND verified_at IS NOT NULL)`),
  check("mca_enrollments_offer_check", sql`COALESCE(jsonb_typeof(offer_json::jsonb)='object' AND (offer_json::jsonb @> '{"version":1,"currency":"usd","baseAmount":39900,"quantity":1,"trialDays":14}') AND offer_json::jsonb->>'accountId'=provider_account_id AND provider_account_id ~ '^acct_[A-Za-z0-9]+$' AND offer_json::jsonb->>'basePriceId' ~ '^price_[A-Za-z0-9]+$' AND offer_json::jsonb->>'seatPriceId' ~ '^price_[A-Za-z0-9]+$' AND offer_json::jsonb->>'basePriceId'<>offer_json::jsonb->>'seatPriceId' AND jsonb_typeof(offer_json::jsonb->'livemode')='boolean' AND jsonb_typeof(offer_json::jsonb->'promotionCodes')='boolean' AND jsonb_typeof(offer_json::jsonb->'automaticTax')='boolean',false)`),
]);

export type EnrollmentDatabaseRow = typeof mcaEnrollments.$inferSelect;

export const mcaEnrollmentCheckoutRequests = pgTable("mca_enrollment_checkout_requests", {
  id: text().primaryKey(), enrollment_id: text().notNull().references(() => mcaEnrollments.id), generation: integer().notNull(), request_key: text().notNull().unique(),
  request_cipher: text().notNull(), payload_hash: text().notNull(), provider_account_id: text().notNull(), state: text().notNull().default("creating"),
  checkout_session_id: text().unique(), requested_at: text().notNull(), idempotency_expires_at: text().notNull(), checkout_expires_at: text(), error_code: text(), updated_at: text().notNull(),
}, t => [
  unique("mca_enrollment_checkout_requests_enrollment_generation_key").on(t.enrollment_id, t.generation),
  foreignKey({ columns: [t.enrollment_id, t.provider_account_id], foreignColumns: [mcaEnrollments.id, mcaEnrollments.provider_account_id] }),
  index("mca_enrollment_checkout_requests_repair_idx").on(t.state, t.requested_at),
  check("mca_enrollment_checkout_requests_generation_check", sql`generation > 0`),
  check("mca_enrollment_checkout_requests_state_check", sql`state IN ('creating','open','complete','expired','uncertain','operator_required')`),
  check("mca_enrollment_checkout_requests_error_code_check", sql`error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'`),
  check("mca_enrollment_checkout_requests_expiry_check", sql`idempotency_expires_at::timestamptz>requested_at::timestamptz`),
]);

export const mcaEnrollmentChallenges = pgTable("mca_enrollment_challenges", {
  id: text().primaryKey(), enrollment_id: text().notNull().references(() => mcaEnrollments.id), purpose: text().notNull(), token_hash: text().notNull().unique(),
  email_cipher: text().notNull(), email_hash: text().notNull(), provider_user_id: uuid(), authorized_by_user_id: text().references(() => users.id), purchase_evidence_hash: text(),
  resume_generation: integer().notNull(), attempts: integer().notNull().default(0), state: text().notNull().default("pending"), expires_at: text().notNull(),
  verified_at: text(), consumed_at: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, t => [
  index("mca_enrollment_challenges_expiry_idx").on(t.enrollment_id, t.state, t.expires_at),
  index("mca_enrollment_challenges_email_idx").on(t.email_hash, t.purpose, t.expires_at),
  check("mca_enrollment_challenges_purpose_check", sql`purpose IN ('authentication','contact_recovery')`),
  check("mca_enrollment_challenges_resume_generation_check", sql`resume_generation > 0`),
  check("mca_enrollment_challenges_attempts_check", sql`attempts BETWEEN 0 AND 5`),
  check("mca_enrollment_challenges_state_check", sql`state IN ('pending','verified','consumed','expired','revoked')`),
  check("mca_enrollment_challenges_expiry_check", sql`expires_at::timestamptz>created_at::timestamptz AND expires_at::timestamptz<=created_at::timestamptz+interval '1 day'`),
]);

export const mcaOnboardingServiceEmails = pgTable("mca_onboarding_service_emails", {
  id: text().primaryKey(), enrollment_id: text().notNull().references(() => mcaEnrollments.id), activation_version: integer().notNull(),
  purpose: text().$type<OnboardingEmailPurpose>().notNull(), generation: integer().notNull(), delivery_key: text().notNull().unique(), workspace_id: text(),
  payload_cipher: text().notNull(), recipient_cipher: text(), content_cipher: text(), provider_config_cipher: text(), recipient_hash: text().notNull(), payload_hash: text().notNull(),
  template_version: integer().notNull(), provider: text(), provider_account_id: text(), frozen_at: text(),
  state: text().$type<OnboardingEmailState>().notNull().default("queued"), attempts: integer().notNull().default(0), next_attempt_at: text().notNull(),
  claim_token: text(), lease_until: text(), provider_message_id: text(), error_code: text(), superseded_by_generation: integer(), created_at: text().notNull(), updated_at: text().notNull(),
}, t => [
  unique("mca_onboarding_service_emails_enrollment_id_id_key").on(t.enrollment_id, t.id),
  unique("mca_onboarding_service_emails_delivery_key").on(t.enrollment_id, t.activation_version, t.purpose, t.generation),
  foreignKey({ columns: [t.enrollment_id, t.workspace_id], foreignColumns: [mcaEnrollments.id, mcaEnrollments.workspace_id] }),
  index("mca_onboarding_emails_due_idx").on(t.state, t.next_attempt_at),
  index("mca_onboarding_emails_lease_idx").on(t.state, t.lease_until),
  uniqueIndex("mca_onboarding_emails_provider_idx").on(t.provider, t.provider_account_id, t.provider_message_id).where(sql`provider_message_id IS NOT NULL`),
  check("mca_onboarding_service_emails_activation_version_check", sql`activation_version=1`),
  check("mca_onboarding_service_emails_purpose_check", sql`purpose IN ('business_information_requested','getting_started')`),
  check("mca_onboarding_service_emails_generation_check", sql`generation > 0`),
  check("mca_onboarding_service_emails_template_version_check", sql`template_version > 0`),
  check("mca_onboarding_service_emails_state_check", sql`state IN ('queued','sending','retry','accepted','delivered','failed','uncertain','suppressed')`),
  check("mca_onboarding_service_emails_attempts_check", sql`attempts BETWEEN 0 AND 3`),
  check("mca_onboarding_service_emails_error_code_check", sql`error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'`),
  check("mca_onboarding_service_emails_superseded_check", sql`superseded_by_generation > generation`),
  check("mca_onboarding_service_emails_lease_check", sql`(claim_token IS NULL)=(lease_until IS NULL)`),
]);

export const mcaOnboardingServiceEmailReceipts = pgTable("mca_onboarding_service_email_receipts", {
  id: text().primaryKey(), enrollment_id: text().notNull().references(() => mcaEnrollments.id), email_id: text().notNull(),
  provider: text().notNull(), provider_account_id: text().notNull(), event_key: text().notNull(), state: text().notNull(), provider_message_id: text(),
  evidence_type: text().notNull(), error_code: text(), occurred_at: text().notNull(), observed_at: text().notNull(),
}, t => [
  unique("mca_onboarding_receipts_provider_event_key").on(t.provider, t.provider_account_id, t.event_key),
  foreignKey({ columns: [t.enrollment_id, t.email_id], foreignColumns: [mcaOnboardingServiceEmails.enrollment_id, mcaOnboardingServiceEmails.id] }),
  index("mca_onboarding_receipts_email_idx").on(t.enrollment_id, t.email_id, t.observed_at),
  check("mca_onboarding_service_email_receipts_state_check", sql`state IN ('accepted','delivered','retry','failed','uncertain','suppressed','bounced','complained')`),
  check("mca_onboarding_service_email_receipts_evidence_type_check", sql`evidence_type IN ('provider_response','verified_webhook','verified_lookup','operator_review')`),
  check("mca_onboarding_service_email_receipts_error_code_check", sql`error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'`),
]);

export const mcaServiceEmailSuppressions = pgTable("mca_service_email_suppressions", {
  recipient_hash: text().notNull(), provider: text().notNull(), provider_account_id: text().notNull(), reason: text().notNull(), active: boolean().notNull().default(true),
  evidence_receipt_id: text().references(() => mcaOnboardingServiceEmailReceipts.id), created_at: text().notNull(), updated_at: text().notNull(),
}, t => [
  primaryKey({ columns: [t.recipient_hash, t.provider, t.provider_account_id] }),
  check("mca_service_email_suppressions_reason_check", sql`reason IN ('bounce','complaint','invalid_address','safety')`),
]);

export const companyBasicProfiles = pgTable("company_basic_profiles", {
  workspace_id: text().primaryKey().references(() => workspaces.id), profile_cipher: text().notNull(), schema_version: integer().notNull().default(1), revision: integer().notNull(),
  supplied_at: text().notNull(), updated_by_user_id: text().notNull().references(() => users.id), last_mutation_key: text(), last_mutation_hash: text(), updated_at: text().notNull(),
}, t => [
  foreignKey({ columns: [t.workspace_id, t.updated_by_user_id], foreignColumns: [memberships.workspace_id, memberships.user_id] }),
  check("company_basic_profiles_schema_version_check", sql`schema_version=1`), check("company_basic_profiles_revision_check", sql`revision > 0`),
  check("company_basic_profiles_mutation_check", sql`(last_mutation_key IS NULL)=(last_mutation_hash IS NULL)`),
]);

export const mcaSenderTestRuns = pgTable("mca_sender_test_runs", {
  id: text().primaryKey(), workspace_id: text().notNull().references(() => workspaces.id), sender_id: text().notNull(), request_key: text().notNull(), sender_fingerprint: text().notNull(),
  recipient_cipher: text().notNull(), recipient_hash: text().notNull(), recipient_control_confirmed: boolean().notNull(), provider: text(), state: text().notNull(), provider_message_id: text(),
  claim_token: text(), lease_until: text(), error_code: text(), accepted_at: text(), received_at: text(), evidence_source: text(), created_by_user_id: text().references(() => users.id),
  created_at: text().notNull(), updated_at: text().notNull(),
}, t => [
  unique("mca_sender_test_runs_workspace_id_id_key").on(t.workspace_id, t.id),
  unique("mca_sender_test_runs_request_key").on(t.workspace_id, t.sender_id, t.request_key),
  foreignKey({ columns: [t.workspace_id, t.sender_id], foreignColumns: [mca_email_senders.workspace_id, mca_email_senders.id] }),
  index("mca_sender_tests_latest_idx").on(t.workspace_id, t.sender_id, t.created_at),
  check("mca_sender_test_runs_recipient_control_confirmed_check", sql`recipient_control_confirmed`),
  check("mca_sender_test_runs_state_check", sql`state IN ('sending','preview','accepted','received','uncertain','failed')`),
  check("mca_sender_test_runs_error_code_check", sql`error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'`),
  check("mca_sender_test_runs_evidence_source_check", sql`evidence_source IN ('user_confirmed','provider_delivered')`),
  check("mca_sender_test_runs_lease_check", sql`(claim_token IS NULL)=(lease_until IS NULL)`),
]);
