import type { MonitorConfig, MonitorDb } from "./monitor"

export type RuntimeSignal = {
  queueSeconds?: number
  failures?: number
  heartbeatSeconds?: number | null
  staleSyncs?: number
  reconnect?: number
  expiredLeases?: number
}
export type RuntimeSignals = Partial<Record<"email" | "sms" | "calendar" | "receipts" | "notifications" | "voice" | "submissions" | "documents" | "billing", RuntimeSignal>>

/** Aggregate existing durable state only. No provider calls, payloads or invented heartbeats. */
export async function runtimeSignals(db: MonitorDb, config: MonitorConfig): Promise<RuntimeSignals> {
  if (!config.recoveryAlerts) return {}
  const queries: Partial<Record<keyof RuntimeSignals, string>> = {
    billing: `SELECT COALESCE(greatest(0,extract(epoch FROM now()-min(available_at::timestamptz)))::int,0) "queueSeconds" FROM company_billing_notifications WHERE delivered_at IS NULL AND available_at::timestamptz<=now()`,
    // Submission failures can finish their background dispatch successfully: inspect the business outcome.
    submissions: `SELECT count(*)::int failures FROM mca_submission_attempts WHERE state='failed' AND created_at::timestamptz>=now()-interval '10 minutes'`,
    // Voice is request/callback driven, with no worker queue or heartbeat.
    voice: `SELECT count(*)::int failures FROM voice_calls WHERE state='failed' AND terminal_at::timestamptz>=now()-interval '10 minutes'`,
  }
  // Sender progress uses the latest successful conversation sync, not the oldest queued conversation.
  if (config.emailRuntimeEnabled) queries.email = `SELECT
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(next_attempt_at::timestamptz)))::int FROM mca_email_messages WHERE direction='outbound' AND state='queued' AND next_attempt_at::timestamptz<=now()),0) "queueSeconds",
    (SELECT extract(epoch FROM now()-last_completed_at)::int FROM mca_email_runtime_lease WHERE id=1) "heartbeatSeconds",
    (SELECT count(*)::int FROM mca_email_senders WHERE state IN ('expired','revoked')) reconnect,
    (SELECT count(*)::int FROM mca_email_conversations WHERE sync_error IS NOT NULL AND sync_error_at>=now()-interval '10 minutes') failures,
    (SELECT count(*)::int FROM (
      SELECT s.id FROM mca_email_senders s JOIN mca_email_conversations c ON c.sender_id=s.id
      WHERE s.state='verified' AND s.purpose='merchant' AND s.provider IN ('google','microsoft') AND s.credential_cipher IS NOT NULL
      GROUP BY s.id HAVING COALESCE(max(c.last_synced_at::timestamptz),min(c.created_at::timestamptz))<now()-interval '30 minutes'
    ) stale_senders) "staleSyncs"`
  if (config.smsRuntimeEnabled) queries.sms = `SELECT
    (SELECT count(*)::int FROM sms_operations WHERE state='running' AND lease_until::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(created_at::timestamptz)))::int FROM sms_operations WHERE state='queued'),0) "queueSeconds",
    ((SELECT count(*) FROM sms_operations WHERE state IN ('failed','needs_review') AND error_code IS DISTINCT FROM 'company_paused' AND updated_at::timestamptz>=now()-interval '10 minutes')+
     (SELECT count(*) FROM mca_sms_messages WHERE state IN ('failed','unknown') AND updated_at::timestamptz>=now()-interval '10 minutes'))::int failures`
  // Count currently unhealthy connections, not accumulated retry attempts; success clears status.
  if (config.calendarRuntimeEnabled) queries.calendar = `SELECT
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(next_sync_at::timestamptz)))::int FROM mca_calendar_connections WHERE status<>'reconnect' AND next_sync_at::timestamptz<=now()),0) "queueSeconds",
    (SELECT count(*)::int FROM mca_calendar_connections WHERE status IN ('error','reconnect')) failures,
    (SELECT count(*)::int FROM mca_calendar_connections WHERE status<>'reconnect' AND COALESCE(last_sync_at,created_at)::timestamptz<now()-interval '10 minutes') "staleSyncs"`
  if (config.privateEmailRuntimeEnabled) queries.receipts = `SELECT
    (SELECT count(*)::int FROM intake_receipts WHERE state IN ('pending','failed') AND lease_token IS NOT NULL AND lease_expires_at::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(updated_at::timestamptz)))::int FROM intake_receipts WHERE state IN ('pending','failed') AND last_error IS DISTINCT FROM 'company_paused_review_required' AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at::timestamptz<=now())),0) "queueSeconds",
    (SELECT count(*)::int FROM intake_receipts WHERE state='failed' AND last_error IS DISTINCT FROM 'company_paused_review_required' AND updated_at::timestamptz>=now()-interval '10 minutes') failures`
  if (config.notificationRuntimeEnabled) queries.notifications = `SELECT
    (SELECT count(*)::int FROM mca_notifications WHERE state='sending' AND lease_until::timestamptz<now()) "expiredLeases",
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(greatest(next_attempt_at::timestamptz,scheduled_for::timestamptz))))::int FROM mca_notifications WHERE state IN ('queued','retry') AND attempts<3 AND next_attempt_at::timestamptz<=now() AND scheduled_for::timestamptz<=now()),0) "queueSeconds",
    (SELECT count(*)::int FROM mca_notifications WHERE state IN ('failed','uncertain') AND updated_at::timestamptz>=now()-interval '10 minutes') failures`
  if (config.documentRuntimeEnabled) queries.documents = `SELECT count(*)::int failures FROM mca_background_jobs WHERE kind IN ('document_upload','document_scan','draft_scan','assistant_scan','draft_extract','intake_process') AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes'`
  const signals: RuntimeSignals = {}
  for (const [name, query] of Object.entries(queries)) {
    const [row] = await db.query(query)
    if (!row) throw new Error("Runtime aggregate unavailable")
    signals[name as keyof RuntimeSignals] = row as RuntimeSignal
  }
  return signals
}
