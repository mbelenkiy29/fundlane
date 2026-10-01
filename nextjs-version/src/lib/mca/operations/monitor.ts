import { renderEmailContent, requestSystemEmail, sendTransactionalWebhook, type SystemProvider, type TransactionalMessage } from "./email-transport"
import { runtimeSignals } from "./runtime-signals"
import {
  documentWorkerReady,
  incidentTransition,
  type Incident,
  type Metrics,
  safeIdentifier,
} from "./contracts"
export type MonitorDb = {
  query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>
}
export type MonitorConfig = {
  origin: string
  token: string
  alerts: boolean
  documentRuntimeEnabled?: boolean
  billingReconciliationAlertsEnabled?: boolean
  recipient?: string
  webhook?: string
  webhookToken?: string
  systemProviderEnabled?: boolean
  systemProvider?: SystemProvider
  systemApiKey?: string
  systemFrom?: string
  systemReplyTo?: string
  systemBaseUrl?: string
  recoveryAlerts?: boolean
  assistantEnabled?: boolean
  emailRuntimeEnabled?: boolean
  smsRuntimeEnabled?: boolean
  calendarRuntimeEnabled?: boolean
  privateEmailRuntimeEnabled?: boolean
  notificationRuntimeEnabled?: boolean
  thresholds?: {
    workerSeconds: number
    queueSeconds: number
    queueByKind?: Record<string, number>
    providerFailures: number
    billingFailures: number
    assistantRuns: number
  }
}
export async function queueMetrics(db: MonitorDb, documentRuntimeEnabled = false): Promise<Metrics> {
  const [row] = await db.query(`SELECT
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued') queued,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='running') running,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='failed') failed,
    (SELECT count(*)::int FROM mca_background_jobs WHERE state='queued' AND attempts>0) retrying,
    (SELECT count(*)::int FROM mca_background_jobs WHERE kind='billing_reconcile' AND state='queued' AND attempts>0) "billingRetrying",
    ((SELECT count(*) FROM mca_background_jobs WHERE state='running' AND lease_expires_at::timestamptz < now()) +
     (SELECT count(*) FROM mca_email_worker_leases WHERE expires_at::timestamptz < now()))::int expired,
    COALESCE((SELECT greatest(0,extract(epoch FROM now()-min(available_at::timestamptz)))::int FROM mca_background_jobs WHERE state='queued' AND available_at::timestamptz<=now()),0) AS "oldestSeconds",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state IN ('queued','sending')) "emailQueued",
    ((SELECT count(*) FROM mca_email_messages WHERE direction='outbound' AND state IN ('accepted','sent'))+
      (SELECT count(*) FROM mca_application_invitation_deliveries WHERE delivery='sent'))::int "emailAccepted",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='failed') "emailFailed",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='blocked') "emailBlocked",
    (SELECT count(*)::int FROM mca_email_messages WHERE direction='outbound' AND state='unknown') "emailUnknown",
    (SELECT count(*)::int FROM mca_email_senders WHERE state IN ('expired','revoked','failed')) reconnect,
    ((SELECT count(*) FROM mca_email_messages WHERE direction='outbound' AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes')+
      (SELECT count(*) FROM mca_background_jobs WHERE kind='application_invitation_email' AND state='failed' AND updated_at::timestamptz>=now()-interval '10 minutes'))::int "recentEmailFailures",
    (SELECT count(*)::int FROM mca_private.ops_errors WHERE occurred_at>=now()-interval '5 minutes') "recentErrors",
    (SELECT EXTRACT(EPOCH FROM now() - document_worker_heartbeat_at)::int FROM mca_private.ops_control WHERE id) AS "documentWorkerHeartbeatAgeSeconds",
    (SELECT count(*)::int FROM mca_background_jobs WHERE $1::boolean AND kind IN ('document_upload','document_scan','draft_scan','assistant_scan','draft_extract','intake_process') AND state='failed') AS "documentFailed",
    (SELECT count(*)::int FROM mca_background_jobs WHERE $1::boolean AND kind IN ('document_upload','document_scan','draft_scan','assistant_scan','intake_process') AND error_code='scanner_unavailable' AND state IN ('queued','failed')) AS "scannerUnavailable",
    COALESCE((SELECT jsonb_object_agg(kind,age) FROM (SELECT kind,COALESCE(greatest(0,extract(epoch FROM now()-min(available_at::timestamptz) FILTER (WHERE state='queued' AND available_at::timestamptz<=now())))::int,0) age FROM mca_background_jobs GROUP BY kind) q),'{}'::jsonb) AS "queueAgeByKind",
    (SELECT count(*)::int FROM company_billing_notifications WHERE delivered_at IS NULL AND attempts>0 AND available_at::timestamptz<=now()) AS "billingMaintenanceFailures",
    (SELECT count(*)::int FROM mca_assistant_runs WHERE created_at::timestamptz>=now()-interval '1 hour') AS "assistantRuns"`, [documentRuntimeEnabled])
  return row as Metrics
}
export function recoveryRules(metrics: Metrics, config: MonitorConfig): [string, boolean, number][] {
  if (!config.recoveryAlerts) return []
  const thresholds = config.thresholds ?? { workerSeconds: 90, queueSeconds: 600, providerFailures: 5, billingFailures: 1, assistantRuns: 100 }
  const rules: [string, boolean, number][] = [
    ["sender_provider_failures", metrics.recentEmailFailures >= thresholds.providerFailures || metrics.reconnect >= thresholds.providerFailures, 1],
    ["billing_maintenance_failures", (metrics.billingMaintenanceFailures ?? 0) >= thresholds.billingFailures, 1],
  ]
  if (config.assistantEnabled) rules.push(["assistant_usage", (metrics.assistantRuns ?? 0) >= thresholds.assistantRuns, 1])
  for (const [runtime, signal] of Object.entries(metrics.runtimeSignals ?? {})) {
    if (signal.queueSeconds !== undefined) rules.push([`${runtime}_queue_age`, signal.queueSeconds > thresholds.queueSeconds, 3])
    if (signal.failures !== undefined) rules.push([`${runtime}_provider_failures`, signal.failures >= thresholds.providerFailures, 1])
    if (signal.staleSyncs !== undefined) rules.push([`${runtime}_stale_sync`, signal.staleSyncs > 0, 3])
    if (signal.reconnect !== undefined) rules.push([`${runtime}_senders`, signal.reconnect >= thresholds.providerFailures, 1])
    if (signal.expiredLeases !== undefined) rules.push([`${runtime}_expired_leases`, signal.expiredLeases > 0, 3])
    // A bounded email tick can take 230 seconds; match sender readiness's ten-minute grace.
    if ("heartbeatSeconds" in signal) rules.push([`${runtime}_worker`, signal.heartbeatSeconds == null || signal.heartbeatSeconds < 0 || signal.heartbeatSeconds > 600, 3])
  }
  for (const [kind, age] of Object.entries(metrics.queueAgeByKind ?? {})) {
    if (/^[a-z_]{1,50}$/.test(kind) && Number.isFinite(age))
      rules.push([`queue_age_${kind}`, age > (thresholds.queueByKind?.[kind] ?? thresholds.queueSeconds), 3])
  }
  return rules
}
export function workerHeartbeatStale(metrics: Metrics, config: MonitorConfig): boolean {
  if (!config.recoveryAlerts) return !documentWorkerReady(metrics)
  return metrics.documentWorkerHeartbeatAgeSeconds === null || metrics.documentWorkerHeartbeatAgeSeconds > (config.thresholds?.workerSeconds ?? 90)
}
export async function runMonitor(
  db: MonitorDb,
  config: MonitorConfig,
  fetcher: typeof fetch = fetch
) {
  if (new URL(config.origin).protocol !== "https:")
    throw new Error("HTTPS origin required")
  const lease = crypto.randomUUID()
  const claimed = await db.query(
    `UPDATE mca_private.ops_control SET lease_token=$1,lease_until=now()+interval '55 seconds',last_started_at=now() WHERE id AND (lease_until IS NULL OR lease_until<now()) AND (last_started_at IS NULL OR last_started_at<date_trunc('minute',now())) RETURNING id`,
    [lease]
  )
  if (!claimed.length) return { skipped: true }
  try {
    const now = new Date().toISOString(),
      started = performance.now()
    const [previous] = await db.query(
      "SELECT checked_at::text FROM mca_private.ops_health ORDER BY checked_at DESC LIMIT 1"
    )
    if (
      previous &&
      Date.now() - Date.parse(String(previous.checked_at)) > 90000
    )
      await db.query(
        "UPDATE mca_private.ops_incidents SET bad_checks=0,good_checks=0"
      )
    if (!config.alerts) await db.query("UPDATE mca_private.ops_incidents SET pending_kind=NULL,pending_id=NULL,delivery_state=NULL WHERE delivery_state='pending'")
    let websiteOk = false,
      databaseOk = false,
      databaseMs: number | null = null,
      deployment: string | null = null
    try {
      const response = await fetcher(
        new URL("/api/internal/health", config.origin),
        {
          headers: { authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        }
      )
      const body = await response.json()
      websiteOk =
        (response.ok && body.databaseOk === true) ||
        (response.status === 503 && body.databaseOk === false)
      databaseOk = response.ok && body.databaseOk === true
      databaseMs =
        databaseOk && Number.isFinite(body.databaseMs)
          ? Math.max(0, Math.round(body.databaseMs))
          : null
      deployment = safeIdentifier(body.deployment)
    } catch {
      /* Missing response is a failed observation, never a healthy zero. */
    }
    const websiteMs = Math.round(performance.now() - started)
    let metrics: Metrics | null = null
    try {
      metrics = await queueMetrics(db, config.documentRuntimeEnabled)
      if (config.recoveryAlerts) metrics.runtimeSignals = await runtimeSignals(db, config)
    } catch {
      /* A failed aggregate remains unavailable. */
      metrics = null
    }
    await db.query(
      `INSERT INTO mca_private.ops_health(checked_at,website_ok,database_ok,website_ms,database_ms,deployment,metrics) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb WHERE EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$8 AND lease_until>now())`,
      [
        now,
        websiteOk,
        databaseOk,
        websiteMs,
        databaseMs,
        deployment,
        JSON.stringify(metrics),
        lease,
      ]
    )
    const rules: [string, boolean | null, number][] = [
      ["website", !websiteOk, 3],
      ["database", !databaseOk, 3],
      ["server_errors", metrics ? metrics.recentErrors >= 5 : null, 1],
      ["billing_reconciliation", config.billingReconciliationAlertsEnabled && metrics ? metrics.billingRetrying > 0 : null, 1],
      ["queue_age", metrics ? !config.recoveryAlerts && metrics.oldestSeconds > 600 : null, 3],
      ["expired_leases", metrics ? metrics.expired > 0 : null, 3],
      ["ambiguous_email", metrics ? metrics.emailUnknown > 0 : null, 1],
      ["email_failures", metrics ? metrics.recentEmailFailures >= 5 : null, 1],
      [
        "document_worker",
        metrics ? workerHeartbeatStale(metrics, config) : null,
        3,
      ],
      ["metrics_unavailable", metrics === null, 3],
    ]
    if (metrics) rules.push(...recoveryRules(metrics, config))
    for (const [component, bad, threshold] of rules) {
      if (bad === null) continue
      const active = await db.query(
        "SELECT id FROM mca_private.ops_control WHERE lease_token=$1 AND lease_until>now()",
        [lease]
      )
      if (!active.length) break
      await db.query(
        "INSERT INTO mca_private.ops_incidents(component) VALUES($1) ON CONFLICT DO NOTHING",
        [component]
      )
      const [prior] = await db.query(
        `SELECT opened_at::text,bad_checks,good_checks,last_sent_at::text,pending_kind FROM mca_private.ops_incidents WHERE component=$1`,
        [component]
      )
      const next = incidentTransition(prior as Incident, bad, threshold, now)
      await db.query(
        `UPDATE mca_private.ops_incidents SET opened_at=$2,bad_checks=$3,good_checks=$4,
        pending_kind=COALESCE(pending_kind,$5),pending_id=CASE WHEN pending_kind IS NULL AND $5::text IS NOT NULL THEN $6::uuid ELSE pending_id END,
        delivery_state=CASE WHEN pending_kind IS NULL AND $5::text IS NOT NULL THEN 'pending' ELSE delivery_state END WHERE component=$1 AND EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$7 AND lease_until>now())`,
        [
          component,
          next.opened,
          next.badChecks,
          next.goodChecks,
          config.alerts ? next.kind : null,
          crypto.randomUUID(),
          lease,
        ]
      )
    }
    // Send at most one alert per tick: bounded time and no overlapping provider calls.
    const providerReady = config.systemProviderEnabled && config.systemProvider && config.systemApiKey && config.systemFrom
    if (config.alerts && config.recipient && (config.webhook || providerReady)) {
      const [pending] = await db.query(
        `WITH claimed AS (UPDATE mca_private.ops_incidents SET delivery_state='sending',last_attempt_at=now(),last_sent_at=now()
        WHERE component=(SELECT component FROM mca_private.ops_incidents WHERE pending_kind IS NOT NULL AND delivery_state='pending' ORDER BY last_attempt_at NULLS FIRST,component LIMIT 1)
        AND EXISTS(SELECT 1 FROM mca_private.ops_control WHERE lease_token=$1 AND lease_until>now())
        RETURNING component,pending_kind,pending_id) INSERT INTO mca_private.ops_alert_attempts(id,component,kind,state) SELECT pending_id,component,pending_kind,'sending' FROM claimed RETURNING component,kind AS pending_kind,id::text AS pending_id`,
        [lease]
      )
      if (pending) {
        try {
          const message:TransactionalMessage = {
              recipient: config.recipient,
              template: "operations_alert",
              actionUrl: new URL("/admin/status", config.origin).href,
              expiresAt: new Date(Date.now() + 86400000).toISOString(),
              data: {
                component: pending.component,
                time: now,
                summary: `${pending.pending_kind}: ${pending.component}`,
              },
            }
          let state:"accepted"|"rejected"|"unknown"
          if (config.webhook) {
            const response = await sendTransactionalWebhook(config.webhook,config.webhookToken,message,String(pending.pending_id),fetcher,8000)
            state = response.ok ? "accepted" : response.status >= 500 ? "unknown" : "rejected"
          } else {
            const replyTo = config.systemReplyTo?.includes("@") ? config.systemReplyTo : undefined
            const response = await requestSystemEmail({provider:config.systemProvider!,apiKey:config.systemApiKey!,from:config.systemFrom!,to:config.recipient,...renderEmailContent(message),idempotencyKey:String(pending.pending_id),fetchImpl:fetcher,baseUrl:config.systemBaseUrl,...(replyTo !== undefined ? { replyTo } : {})})
            state = response.status >= 200 && response.status < 300 && response.emailId ? "accepted" : [400,401,403,422,429].includes(response.status) ? "rejected" : "unknown"
          }
          await finishAlert(
            db,
            String(pending.component),
            String(pending.pending_id),
            state
          )
        } catch {
          await finishAlert(
            db,
            String(pending.component),
            String(pending.pending_id),
            "unknown"
          )
        }
      }
    }
    // A terminated send stays unknown; do not automatically send another copy.
    await db.query(
      "UPDATE mca_private.ops_alert_attempts SET state='unknown' WHERE state='sending' AND attempted_at<now()-interval '2 minutes'"
    )
    await db.query(
      "UPDATE mca_private.ops_incidents SET delivery_state='unknown',pending_kind=NULL,pending_id=NULL WHERE delivery_state='sending' AND last_attempt_at<now()-interval '2 minutes'"
    )
    await db.query(
      "DELETE FROM mca_private.ops_alert_attempts WHERE id IN (SELECT id FROM mca_private.ops_alert_attempts WHERE attempted_at<now()-interval '30 days' LIMIT 5000)"
    )
    await db.query(
      "DELETE FROM mca_private.ops_health WHERE checked_at IN (SELECT checked_at FROM mca_private.ops_health WHERE checked_at<now()-interval '30 days' LIMIT 5000)"
    )
    await db.query(
      "DELETE FROM mca_private.ops_errors WHERE id IN (SELECT id FROM mca_private.ops_errors WHERE occurred_at<now()-interval '30 days' LIMIT 5000)"
    )
    await db.query(
      "DELETE FROM mca_private.ops_activity WHERE (day,user_id) IN (SELECT day,user_id FROM mca_private.ops_activity WHERE day<(now() AT TIME ZONE 'UTC')::date-30 LIMIT 5000)"
    )
    return { websiteOk, databaseOk, metricsAvailable: metrics !== null }
  } finally {
    await db.query(
      "UPDATE mca_private.ops_control SET lease_token=NULL,lease_until=NULL WHERE lease_token=$1",
      [lease]
    )
  }
}

async function finishAlert(
  db: MonitorDb,
  component: string,
  id: string,
  state: string
) {
  await db.query(
    `WITH finished AS (UPDATE mca_private.ops_alert_attempts SET state=$3 WHERE id=$2::uuid RETURNING id)
    UPDATE mca_private.ops_incidents SET delivery_state=$3,pending_kind=NULL,pending_id=NULL
    WHERE component=$1 AND pending_id IN (SELECT id FROM finished)`,
    [component, id, state]
  )
}
