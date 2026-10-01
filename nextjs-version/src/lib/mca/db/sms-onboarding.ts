import {
  pgTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { workspaces, users } from "./schema"

export const smsCompanies = pgTable(
  "sms_companies",
  {
    workspace_id: text()
      .primaryKey()
      .references(() => workspaces.id),
    owner_user_id: text()
      .notNull()
      .references(() => users.id),
    email_verified_at: text(),
    profile_cipher: text(),
    review_state: text().notNull().default("draft"),
    review_note: text(),
    reviewed_by: text(),
    registration_state: text().notNull().default("not_started"),
    provider_cipher: text(),
    opt_out_ready: integer().notNull().default(0),
    suspended: integer().notNull().default(0),
    number_limit: integer().notNull().default(0),
    monthly_limit_cents: integer().notNull().default(0),
    registration_limit_cents: integer().notNull().default(0),
    created_at: text().notNull(),
    updated_at: text().notNull(),
    refresh_attempted_at: text(),
    sender_type: text(), requested_area_code: text(), selected_phone: text(),
    provisioning_state: text().notNull().default("not_started"), provisioning_reason: text(),
    content_cipher: text(), content_version: text(), attestation_json: text(),
    submitted_at: text(), submitted_by_user_id: text(), operator_approved_at: text(), approved_at: text(),
    resubmission_count: integer().notNull().default(0), next_poll_at: text(), poll_attempts: integer().notNull().default(0),
    release_scheduled_for: text(), released_at: text(), release_reason: text(),
    overage_cap_cents: integer(), onboarding_exempt: integer().notNull().default(0), public_slug: text(),
  },
  (t) => [
    index("sms_companies_refresh_cursor_idx")
      .on(t.refresh_attempted_at.asc().nullsFirst(), t.workspace_id)
      .where(sql`${t.provider_cipher} IS NOT NULL`),
    uniqueIndex("sms_companies_public_slug_key").on(t.public_slug),
    index("sms_companies_poll_idx").on(t.next_poll_at).where(sql`${t.provisioning_state} IN ('provisioning','number_acquired','profile_pending','brand_pending','campaign_pending','number_registering','tfv_pending','resubmitting','release_scheduled','releasing')`),
    check("sms_companies_provisioning_state_check", sql`${t.provisioning_state} IN ('not_started','draft','submitted','operator_review','provisioning','number_acquired','profile_pending','brand_pending','campaign_pending','number_registering','tfv_pending','action_required','resubmitting','active','paused','release_scheduled','releasing','released','rejected_final','needs_review')`),
    check("sms_companies_sender_type_check", sql`${t.sender_type} IN ('local','toll_free')`),
    check("sms_companies_requested_area_code_check", sql`${t.requested_area_code} ~ '^[2-9][0-9]{2}$'`),
    check("sms_companies_selected_phone_check", sql`${t.selected_phone} ~ '^\+1[0-9]{10}$'`),
    check("sms_companies_overage_cap_cents_check", sql`${t.overage_cap_cents} IS NULL OR ${t.overage_cap_cents} >= 0`),
    check("sms_companies_onboarding_exempt_check", sql`${t.onboarding_exempt} IN (0,1)`),
    check(
      "sms_company_limits",
      sql`${t.number_limit} >= 0 AND ${t.monthly_limit_cents} >= 0 AND ${t.registration_limit_cents} >= 0`
    ),
  ]
)
export const smsEmailTokens = pgTable("sms_email_tokens", {
  token_hash: text().primaryKey(),
  workspace_id: text()
    .notNull()
    .references(() => workspaces.id),
  user_id: text()
    .notNull()
    .references(() => users.id),
  expires_at: text().notNull(),
  used_at: text(),
  created_at: text().notNull(),
})
export const smsOperations = pgTable(
  "sms_operations",
  {
    id: text().primaryKey(),
    workspace_id: text()
      .notNull()
      .references(() => workspaces.id),
    kind: text().notNull(),
    request_key: text().notNull(),
    payload_cipher: text().notNull(),
    state: text().notNull().default("queued"),
    step: text(),
    result_cipher: text(),
    error_code: text(),
    lease_until: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [uniqueIndex("sms_operation_retry").on(t.workspace_id, t.request_key)]
)
export const smsNumbers = pgTable(
  "sms_numbers",
  {
    id: text().primaryKey(),
    workspace_id: text()
      .notNull()
      .references(() => workspaces.id),
    account_id: text().notNull(),
    provider_sid: text().notNull(),
    phone: text().notNull(),
    membership_id: text(),
    state: text().notNull(),
    monthly_cents: integer().notNull(),
    number_type: text().notNull().default("local"), tfv_sid: text(), released_at: text(), release_reason: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("sms_number_provider").on(t.provider_sid),
    uniqueIndex("sms_number_account").on(t.account_id),
    uniqueIndex("sms_company_number").on(t.workspace_id).where(sql`${t.state} <> 'released'`),
    check("sms_numbers_number_type_check", sql`${t.number_type} IN ('local','toll_free')`),
    uniqueIndex("sms_employee_number")
      .on(t.workspace_id, t.membership_id)
      .where(sql`${t.state} <> 'released'`),
  ]
)
export const smsAssignments = pgTable("sms_number_assignments", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  number_id: text().notNull(),
  membership_id: text(),
  actor_user_id: text().notNull(),
  created_at: text().notNull(),
})
export const smsConversations = pgTable(
  "sms_conversations",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    account_id: text().notNull(),
    recipient_hash: text().notNull(),
    recipient_cipher: text().notNull(),
    deal_id: text(),
    created_at: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [
    uniqueIndex("sms_conversation_identity").on(
      t.workspace_id,
      t.account_id,
      t.recipient_hash
    ),
  ]
)
export const smsInboxMessages = pgTable(
  "sms_inbox_messages",
  {
    id: text().primaryKey(),
    workspace_id: text().notNull(),
    conversation_id: text().notNull(),
    provider_id: text().notNull(),
    direction: text().notNull(),
    body_cipher: text().notNull(),
    created_at: text().notNull(),
  },
  (t) => [uniqueIndex("sms_inbox_provider").on(t.workspace_id, t.provider_id)]
)
export const smsReads = pgTable(
  "sms_conversation_reads",
  {
    conversation_id: text().notNull(),
    membership_id: text().notNull(),
    read_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversation_id, t.membership_id] })]
)
export const smsSuppressions = pgTable(
  "sms_suppressions",
  {
    workspace_id: text().notNull(),
    recipient_hash: text().notNull(),
    state: text().notNull(),
    updated_at: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.recipient_hash] })]
)
export const smsUsage = pgTable("sms_usage", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  period: text().notNull(),
  category: text().notNull(),
  estimated_cents: integer().notNull().default(0),
  actual_cents: integer(),
  quantity: text(),
  updated_at: text().notNull(),
})
export const smsRegistrationEvents = pgTable("sms_registration_events", {
  id: text().primaryKey(),
  workspace_id: text().notNull(),
  number_sid: text().notNull(),
  state: text().notNull(),
  provider_time: text().notNull(),
  created_at: text().notNull(),
})

export const smsRegistrations = pgTable("sms_registrations", {
  id: text().primaryKey(), workspace_id: text().notNull().references(() => workspaces.id),
  kind: text().notNull(), attempt: integer().notNull(), provider_sid: text(), status: text().notNull(),
  provider_status: text(), rejection_codes: text(), rejection_detail_cipher: text(), edit_allowed_until: text(),
  fee_estimate_cents: integer().notNull().default(0), submitted_at: text(), decided_at: text(),
  created_at: text().notNull(), updated_at: text().notNull(),
}, (t) => [
  uniqueIndex("sms_registrations_workspace_kind_attempt_key").on(t.workspace_id,t.kind,t.attempt),
  check("sms_registrations_kind_check", sql`${t.kind} IN ('customer_profile','trust_product','brand','campaign','tollfree_verification')`),
])
export const smsMeterEvents = pgTable("sms_meter_events", {
  id: text().primaryKey(), workspace_id: text().notNull(), message_id: text().notNull(), stripe_customer_id: text(),
  segments: integer().notNull(), occurred_at: text().notNull(), state: text().notNull(), skip_reason: text(),
  attempts: integer().notNull().default(0), last_error_code: text(), sent_at: text(), created_at: text().notNull(), updated_at: text().notNull(),
}, (t) => [
  uniqueIndex("sms_meter_events_message_id_key").on(t.message_id),
  index("sms_meter_events_pending_idx").on(t.created_at).where(sql`${t.state} = 'pending'`),
  check("sms_meter_events_segments_check", sql`${t.segments} > 0`),
  check("sms_meter_events_state_check", sql`${t.state} IN ('pending','sent','skipped','failed','needs_review')`),
])
export const smsUsagePeriods = pgTable("sms_usage_periods", {
  workspace_id: text().notNull(), period_start: text().notNull(), period_end: text().notNull(),
  kind: text().notNull(), included_segments: integer().notNull(), used_segments: integer().notNull().default(0),
  reserved_segments: integer().notNull().default(0), cap_segments: integer(), alert_80_at: text(),
  alert_100_at: text(), cap_hit_at: text(), updated_at: text().notNull(),
}, (t) => [
  primaryKey({ columns: [t.workspace_id,t.period_start] }),
  check("sms_usage_periods_kind_check", sql`${t.kind} IN ('trial','subscription','exempt')`),
])
