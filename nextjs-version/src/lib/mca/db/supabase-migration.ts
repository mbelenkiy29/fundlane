import { pgTable, text, integer, unique, index, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mcaEnrollments } from './onboarding';
import { workspaces } from './schema';

export const authSessionRevocations = pgTable('auth_session_revocations', {
  id: text().primaryKey(), revoked_at: text().notNull(),
});
export const workspaceStripeCustomers = pgTable('workspace_stripe_customers', {
  workspace_id: text().primaryKey(), stripe_customer_id:text().notNull().unique('workspace_stripe_customers_stripe_customer_id_key'),
  checkout_session_id:text(), checkout_plan_slug:text(), created_at:text().notNull(),
}, t=>[foreignKey({name:'workspace_stripe_customers_workspace_id_fkey',columns:[t.workspace_id],foreignColumns:[workspaces.id]})]);
export const workspaceBillingEntitlements = pgTable('workspace_billing_entitlements', {
  workspace_id:text().primaryKey(), stripe_subscription_id:text().unique('workspace_billing_entitlements_stripe_subscription_id_key'),stripe_price_id:text(),
  plan_slug:text().notNull(),plan_name:text().notNull(),status:text().notNull(),period_start:text(),period_end:text(),
  seat_limit:integer().notNull(),payment_past_due:integer().notNull().default(0),source:text().notNull(),synced_at:text().notNull(),
}, table=>[
  foreignKey({name:'workspace_billing_entitlements_workspace_id_fkey',columns:[table.workspace_id],foreignColumns:[workspaces.id]}),
  check('workspace_billing_entitlements_seat_limit_check',sql`${table.seat_limit} IN (1,5,20)`),
  check('workspace_billing_entitlements_payment_past_due_check',sql`${table.payment_past_due} IN (0,1)`),
  check('workspace_billing_entitlements_source_check',sql`${table.source} IN ('free','stripe_api','sync_engine')`),
]);
export const stripeBillingEvents = pgTable('stripe_billing_events', {
  enrollment_id:text().references(() => mcaEnrollments.id),event_id:text().primaryKey(),event_type:text().notNull(),stripe_customer_id:text(),workspace_id:text(),received_at:text().notNull(),
}, t=>[index('stripe_billing_events_enrollment_idx').on(t.enrollment_id).where(sql`${t.enrollment_id} IS NOT NULL`),foreignKey({name:'stripe_billing_events_workspace_id_fkey',columns:[t.workspace_id],foreignColumns:[workspaces.id]})]);
export const mcaBackgroundJobs=pgTable('mca_background_jobs',{
  id:text().primaryKey(),workspace_id:text().notNull(),kind:text().notNull(),resource_id:text().notNull(),idempotency_key:text().notNull(),
  actor_json:text().notNull(),payload_json:text().notNull(),payload_hash:text().notNull(),state:text().notNull(),attempts:integer().notNull().default(0),
  lease_token:text(),lease_expires_at:text(),available_at:text().notNull(),result_json:text(),error_code:text(),created_at:text().notNull(),updated_at:text().notNull(),
},t=>[
  foreignKey({name:'mca_background_jobs_workspace_id_fkey',columns:[t.workspace_id],foreignColumns:[workspaces.id]}),
  unique('mca_background_jobs_workspace_id_kind_idempotency_key_key').on(t.workspace_id,t.kind,t.idempotency_key),
  index('mca_background_jobs_claim_idx').on(t.state,t.available_at,t.created_at),
  check('mca_background_jobs_state_check',sql`${t.state} IN ('queued','running','complete','failed')`),
]);
export const mcaDocumentUploads=pgTable('mca_document_uploads',{
  id:text().primaryKey(),workspace_id:text().notNull(),owner_key:text().notNull(),purpose:text().notNull(),idempotency_key:text().notNull(),
  storage_key:text().notNull().unique('mca_document_uploads_storage_key_key'),byte_length:integer().notNull(),checksum:text().notNull(),mime_type:text().notNull(),filename:text().notNull(),payload_json:text().notNull(),actor_json:text().notNull(),
  job_id:text(),expires_at:text().notNull(),created_at:text().notNull(),
},t=>[
  foreignKey({name:'mca_document_uploads_workspace_id_fkey',columns:[t.workspace_id],foreignColumns:[workspaces.id]}),
  foreignKey({name:'mca_document_uploads_job_id_fkey',columns:[t.job_id],foreignColumns:[mcaBackgroundJobs.id]}),
  unique('mca_document_uploads_workspace_id_owner_key_purpose_idempot_key').on(t.workspace_id,t.owner_key,t.purpose,t.idempotency_key),
  check('mca_document_uploads_purpose_check',sql`${t.purpose} IN ('document','draft','merchant','task_file')`),
  check('mca_document_uploads_byte_length_check',sql`${t.byte_length}>0 AND ${t.byte_length}<=26214400`),
]);
