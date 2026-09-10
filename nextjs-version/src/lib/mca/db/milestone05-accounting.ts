import { check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/**
 * Milestone 05 accounting schema fragment. The base mca_advances table belongs to
 * the offer/funding schema. All monetary columns here are integer cents and all
 * percentages are integer basis points so persisted calculations are exact.
 */

export const mca_advance_status_history = pgTable("mca_advance_status_history", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  advance_id: text().notNull(),
  status: text().notNull(),
  reason: text(),
  effective_at: text().notNull(),
  actor_user_id: text(),
  correlation_id: text().notNull(),
  created_at: text().notNull(),
}, (table) => [
  index("mca_advance_status_history_advance_idx").on(table.workspace_id, table.advance_id, table.effective_at),
  unique("mca_advance_status_history_correlation_key").on(table.workspace_id, table.advance_id, table.correlation_id),
  check("mca_advance_status_history_status_check", sql`${table.status} in ('on_track','missed_payment','default','renewed','closed')`),
])

export const mca_accounting_payments = pgTable("mca_accounting_payments", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  advance_id: text().notNull(),
  funding_event_id: text(),
  type: text().notNull(),
  origin: text().notNull(),
  originator_membership_id: text(),
  expected_amount_cents: integer().notNull(),
  received_amount_cents: integer().default(0).notNull(),
  expected_at: text(),
  received_at: text(),
  status: text().notNull(),
  idempotency_key: text().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  index("mca_accounting_payments_filter_idx").on(table.workspace_id, table.status, table.expected_at),
  index("mca_accounting_payments_advance_idx").on(table.workspace_id, table.advance_id, table.created_at),
  unique("mca_accounting_payments_idempotency_key").on(table.workspace_id, table.advance_id, table.type, table.idempotency_key),
  check("mca_accounting_payments_type_check", sql`${table.type} in ('commission','fee')`),
  check("mca_accounting_payments_origin_check", sql`${table.origin} in ('automatic','manual','historical')`),
  check("mca_accounting_payments_status_check", sql`${table.status} in ('expected','partial','received','void')`),
  check("mca_accounting_payments_amounts_check", sql`${table.expected_amount_cents} >= 0 and ${table.received_amount_cents} >= 0`),
])

export const mca_accounting_adjustments = pgTable("mca_accounting_adjustments", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  payment_id: text().notNull(),
  amount_cents: integer().notNull(),
  reason: text().notNull(),
  actor_user_id: text(),
  correlation_id: text().notNull(),
  created_at: text().notNull(),
}, (table) => [
  index("mca_accounting_adjustments_payment_idx").on(table.workspace_id, table.payment_id, table.created_at),
  unique("mca_accounting_adjustments_correlation_key").on(table.workspace_id, table.payment_id, table.correlation_id),
  check("mca_accounting_adjustments_nonzero_check", sql`${table.amount_cents} <> 0`),
])

export const mca_split_templates = pgTable("mca_split_templates", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  name: text().notNull(),
  active_version: integer().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_split_templates_name_key").on(table.workspace_id, table.name),
  check("mca_split_templates_version_check", sql`${table.active_version} > 0`),
])

export const mca_split_template_versions = pgTable("mca_split_template_versions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  template_id: text().notNull(),
  version: integer().notNull(),
  allocation_json: text().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_split_template_versions_key").on(table.workspace_id, table.template_id, table.version),
  index("mca_split_template_versions_template_idx").on(table.workspace_id, table.template_id, table.version),
  check("mca_split_template_versions_version_check", sql`${table.version} > 0`),
])

export const mca_payment_distributions = pgTable("mca_payment_distributions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  payment_id: text().notNull(),
  recipient_membership_id: text().notNull(),
  template_id: text(),
  template_version: integer(),
  percentage_basis_points: integer().notNull(),
  amount_cents: integer().notNull(),
  status: text().notNull(),
  expected_at: text(),
  paid_at: text(),
  snapshot_json: text().notNull(),
  idempotency_key: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_payment_distributions_idempotency_key").on(table.workspace_id, table.payment_id, table.recipient_membership_id, table.idempotency_key),
  index("mca_payment_distributions_recipient_idx").on(table.workspace_id, table.recipient_membership_id, table.status, table.expected_at),
  check("mca_payment_distributions_percent_check", sql`${table.percentage_basis_points} > 0 and ${table.percentage_basis_points} <= 10000`),
  check("mca_payment_distributions_amount_check", sql`${table.amount_cents} >= 0`),
  check("mca_payment_distributions_status_check", sql`${table.status} in ('expected','paid','void')`),
])

export const mca_renewal_policies = pgTable("mca_renewal_policies", {
  workspace_id: text().primaryKey().notNull(),
  paid_in_threshold_basis_points: integer().notNull(),
  minimum_days_since_funding: integer().default(0).notNull(),
  version: integer().notNull(),
  updated_by_user_id: text(),
  updated_at: text().notNull(),
}, (table) => [
  check("mca_renewal_policies_threshold_check", sql`${table.paid_in_threshold_basis_points} between 0 and 10000`),
  check("mca_renewal_policies_days_check", sql`${table.minimum_days_since_funding} >= 0`),
])

export const mca_renewal_actions = pgTable("mca_renewal_actions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  source_advance_id: text().notNull(),
  renewed_deal_id: text(),
  policy_version: integer().notNull(),
  eligible_at: text().notNull(),
  state: text().notNull(),
  message_subject: text().notNull(),
  message_body: text().notNull(),
  documentation_requested_at: text(),
  idempotency_key: text().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_renewal_actions_idempotency_key").on(table.workspace_id, table.source_advance_id, table.idempotency_key),
  index("mca_renewal_actions_followup_idx").on(table.workspace_id, table.state, table.eligible_at),
  check("mca_renewal_actions_state_check", sql`${table.state} in ('eligible','contacted','documents_requested','converted','dismissed')`),
])
