import { check, index, integer, pgTable, text, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

/**
 * MIC-111 reverse consolidation and weekly expected-distribution schedules.
 * Integer cents and basis points. Records are accounting schedules, not transfers.
 */

export const mca_reverse_consolidations = pgTable("mca_reverse_consolidations", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  deal_id: text().notNull(),
  referenced_advance_ids_json: text().notNull(),
  schedule_id: text().notNull(),
  idempotency_key: text().notNull(),
  created_by_user_id: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_reverse_consolidations_idempotency_key").on(table.workspace_id, table.idempotency_key),
  unique("mca_reverse_consolidations_schedule_key").on(table.workspace_id, table.schedule_id),
  index("mca_reverse_consolidations_deal_idx").on(table.workspace_id, table.deal_id, table.created_at),
])

export const mca_distribution_schedules = pgTable("mca_distribution_schedules", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  reverse_consolidation_id: text().notNull(),
  status: text().notNull(),
  active_version: integer().notNull(),
  start_date: text().notNull(),
  installment_count: integer().notNull(),
  installment_cents: integer().notNull(),
  split_template_id: text().notNull(),
  split_template_version: integer().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_distribution_schedules_consolidation_key").on(table.workspace_id, table.reverse_consolidation_id),
  index("mca_distribution_schedules_status_idx").on(table.workspace_id, table.status, table.start_date),
  check("mca_distribution_schedules_status_check", sql`${table.status} in ('active','paused','cancelled')`),
  check("mca_distribution_schedules_version_check", sql`${table.active_version} > 0`),
  check("mca_distribution_schedules_count_check", sql`${table.installment_count} > 0`),
  check("mca_distribution_schedules_amount_check", sql`${table.installment_cents} > 0`),
])

export const mca_distribution_schedule_versions = pgTable("mca_distribution_schedule_versions", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  schedule_id: text().notNull(),
  version: integer().notNull(),
  start_date: text().notNull(),
  installment_count: integer().notNull(),
  installment_cents: integer().notNull(),
  split_template_id: text().notNull(),
  split_template_version: integer().notNull(),
  allocation_json: text().notNull(),
  reason: text(),
  created_by_user_id: text(),
  created_at: text().notNull(),
}, (table) => [
  unique("mca_distribution_schedule_versions_key").on(table.workspace_id, table.schedule_id, table.version),
  index("mca_distribution_schedule_versions_schedule_idx").on(table.workspace_id, table.schedule_id, table.version),
  check("mca_distribution_schedule_versions_version_check", sql`${table.version} > 0`),
  check("mca_distribution_schedule_versions_count_check", sql`${table.installment_count} > 0`),
  check("mca_distribution_schedule_versions_amount_check", sql`${table.installment_cents} > 0`),
])

export const mca_scheduled_installments = pgTable("mca_scheduled_installments", {
  id: text().primaryKey().notNull(),
  workspace_id: text().notNull(),
  schedule_id: text().notNull(),
  schedule_version: integer().notNull(),
  occurrence_date: text().notNull(),
  recipient_membership_id: text().notNull(),
  amount_cents: integer().notNull(),
  percentage_basis_points: integer().notNull(),
  status: text().notNull(),
  paid_at: text(),
  snapshot_json: text().notNull(),
  idempotency_key: text().notNull(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique("mca_scheduled_installments_occurrence_key").on(
    table.workspace_id,
    table.schedule_id,
    table.schedule_version,
    table.occurrence_date,
    table.recipient_membership_id,
  ),
  unique("mca_scheduled_installments_idempotency_key").on(table.workspace_id, table.schedule_id, table.idempotency_key),
  index("mca_scheduled_installments_schedule_idx").on(table.workspace_id, table.schedule_id, table.occurrence_date),
  index("mca_scheduled_installments_recipient_idx").on(table.workspace_id, table.recipient_membership_id, table.status, table.occurrence_date),
  check("mca_scheduled_installments_status_check", sql`${table.status} in ('expected','paid','void')`),
  check("mca_scheduled_installments_amount_check", sql`${table.amount_cents} >= 0`),
  check("mca_scheduled_installments_percent_check", sql`${table.percentage_basis_points} > 0 and ${table.percentage_basis_points} <= 10000`),
])
