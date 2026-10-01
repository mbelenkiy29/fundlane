import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { queueMetrics, recoveryRules, runMonitor, type MonitorConfig, type MonitorDb } from "../src/lib/mca/operations/monitor"
import { runtimeSignals } from "../src/lib/mca/operations/runtime-signals"
import { apiError } from "../src/lib/mca/errors"
import { operationalEvent, persistEvent, recordOperationalError } from "../src/lib/mca/operations/telemetry"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let db: MonitorDb
const old = new Date(Date.now() - 20 * 60_000).toISOString()
const now = new Date().toISOString()
const future = new Date(Date.now() + 60 * 60_000).toISOString()
const secrets = ["synthetic_access_token_7", "synthetic_api_key_7", "Basic c3ludGhldGljOnNlY3JldA==", "synthetic_refresh_token_7", "synthetic_encryption_key_7", "9876543210987654", "FULL_SYNTHETIC_BANK_STATEMENT_CONTENT"]
const sensitive = secrets.join(" ")
const config: MonitorConfig = {
  origin: "https://monitor.example.test", token: "synthetic-monitor-token", alerts: false,
  recoveryAlerts: true, emailRuntimeEnabled: true, smsRuntimeEnabled: true,
  calendarRuntimeEnabled: true, privateEmailRuntimeEnabled: true, notificationRuntimeEnabled: true,
  documentRuntimeEnabled: true, assistantEnabled: true,
}
// Identifiers are test-owned literals; values always use query parameters.
async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row)
  await database.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row))
}
async function tick(options = config, fetcher: typeof fetch = async () => Response.json({ databaseOk: true })) {
  await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute',document_worker_heartbeat_at=now()")
  return runMonitor(db, options, fetcher)
}
async function metrics() { return { ...await queueMetrics(db, true), runtimeSignals: await runtimeSignals(db, config) } }

before(async () => {
  database = await createPostgresTestDatabase("operations_signals")
  process.env.DATABASE_URL = database.databaseUrl
  db = { query: async (sql, values) => (await database.query(sql, values)).rows }
  await insert("workspaces", { id: "w", name: "Synthetic", feature_flags: "{}", page_visibility: "{}", created_at: old, updated_at: now })
  await insert("users", { id: "u", email: "synthetic@example.test", name: "Synthetic", application_identifier: "u", created_at: old, updated_at: now })
  await insert("memberships", { id: "m", workspace_id: "w", user_id: "u", role: "admin", status: "active", created_at: old, updated_at: now })
  await insert("deals", { id: "d", workspace_id: "w", display_id: "SYN-1", legal_name: "Synthetic", status: "offer", pipeline_version: 1, draft_state: "submission_ready", missing_required_json: "[]", field_sources_json: "{}", version: 1, created_at: old, updated_at: now })
  for (let i = 0; i < 5; i++) {
    await insert("mca_email_senders", { id: `s${i}`, workspace_id: "w", provider: "google", purpose: "merchant", from_name: "Synthetic", from_address: "synthetic@example.test", credential_cipher: sensitive, state: i % 2 ? "revoked" : "expired", created_at: old, updated_at: now })
    await insert("mca_email_conversations", { id: `c${i}`, workspace_id: "w", deal_id: "d", sender_id: `s${i}`, recipient_cipher: sensitive, subject_cipher: sensitive, sync_error: sensitive, created_at: old, updated_at: now, next_sync_at: old, last_synced_at: i ? old : null })
  }
  await insert("mca_email_messages", { id: "mail", workspace_id: "w", conversation_id: "c0", direction: "outbound", body_cipher: sensitive, author_cipher: sensitive, internet_message_id: "synthetic", state: "queued", next_attempt_at: old, created_at: old, updated_at: now })
  await insert("mca_email_runtime_lease", { id: 1, token: "synthetic", expires_at: old, last_started_at: old, last_completed_at: old })
  await insert("mca_calendar_connections", { id: "cal", workspace_id: "w", user_id: "u", membership_id: "m", email: "synthetic@example.test", credential_cipher: sensitive, next_sync_at: old, failures: 5, error: sensitive, created_at: old })
  await insert("intake_events", { id: "intake", workspace_id: "w", provider: "email", provider_event_id: "synthetic", payload_checksum: "synthetic", application_cipher: sensitive, state: "received", created_at: old, updated_at: now })
  await insert("sms_numbers", { id: "number", workspace_id: "w", account_id: "synthetic", provider_sid: "synthetic", phone: "+12025550100", state: "registering", monthly_cents: 0, created_at: old, updated_at: now })
  await insert("mca_funders", { id: "funder", workspace_id: "w", idempotency_key: "synthetic", legal_name: "Synthetic", created_at: old, updated_at: now })
  await insert("mca_submission_jobs", { id: "submission", workspace_id: "w", deal_id: "d", funder_id: "funder", display_funder_name: "Synthetic", route_kind: "email", route_json: "{}", state: "failed", confirmation_key: "synthetic", attempt_key: "synthetic", deal_version: 1, document_versions_json: "{}", package_json: "{}", preflight_errors_json: "[]", created_at: old, updated_at: now })
  for (let i = 0; i < 5; i++) {
    await insert("sms_operations", { id: `sms${i}`, workspace_id: "w", kind: "provision", request_key: `sms${i}`, payload_cipher: sensitive, state: "failed", error_code: sensitive, created_at: old, updated_at: now })
    await insert("intake_receipts", { id: `receipt${i}`, workspace_id: "w", intake_id: "intake", recipient_cipher: `${sensitive}${i}`, state: "failed", last_error: sensitive, created_at: old, updated_at: now })
    await insert("mca_notifications", { id: `notice${i}`, workspace_id: "w", event_key: `event${i}`, kind: "document", audience: "broker", channel: "email", recipient_key: "synthetic", actor_membership_id: "m", approved_at: old, scheduled_for: old, payload_cipher: sensitive, recipient_hash: "synthetic", payload_hash: "synthetic", state: "failed", next_attempt_at: old, created_at: old, updated_at: now })
    await insert("voice_calls", { id: `call${i}`, workspace_id: "w", number_id: "number", account_sid: "synthetic", provider_call_sid: `call${i}`, direction: "outbound", state: "failed", phone_cipher: sensitive, company_phone_cipher: sensitive, terminal_at: now, created_at: old })
    await insert("mca_submission_attempts", { id: `attempt${i}`, workspace_id: "w", job_id: "submission", attempt_key: `attempt${i}`, transport: "email", state: "failed", correlation_id: "synthetic", error_message: sensitive, created_at: now })
    await insert("mca_background_jobs", { id: `job${i}`, workspace_id: "w", kind: "document_scan", resource_id: "d", idempotency_key: `job${i}`, actor_json: "{}", payload_json: "{}", payload_hash: "synthetic", state: "failed", available_at: old, error_code: "scanner_unavailable", created_at: old, updated_at: now })
  }
  await insert("sms_operations", { id: "sms-due", workspace_id: "w", kind: "provision", request_key: "sms-due", payload_cipher: sensitive, state: "queued", created_at: old, updated_at: old })
  await insert("intake_receipts", { id: "receipt-due", workspace_id: "w", intake_id: "intake", recipient_cipher: "due", state: "pending", created_at: old, updated_at: old })
  await insert("mca_notifications", { id: "notice-due", workspace_id: "w", event_key: "due", kind: "document", audience: "broker", channel: "email", recipient_key: "synthetic", actor_membership_id: "m", approved_at: old, scheduled_for: old, payload_cipher: sensitive, recipient_hash: "synthetic", payload_hash: "synthetic", state: "queued", next_attempt_at: old, created_at: old, updated_at: now })
  await insert("company_billing_notifications", { id: "billing", workspace_id: "w", kind: "payment_failed", data: "{}", attempts: 1, available_at: old, last_error: sensitive, created_at: old })
  await insert("mca_assistant_conversations", { id: "assistant", workspace_id: "w", user_id: "u", deal_id: "d", created_at: now })
  for (let i = 0; i < 100; i++) await insert("mca_assistant_runs", { id: `run${i}`, conversation_id: "assistant", request_id: `run${i}`, status: "complete", created_at: now, expires_at: future })
})
after(async () => { delete process.env.MCA_OPERATIONS_ENABLED; await database?.close() })

test("existing durable signals use real Postgres, with recovery and runtime flags off by default", async () => {
  assert.deepEqual(await runtimeSignals({ query: async () => { throw Error("must not query") } }, { ...config, recoveryAlerts: false }), {})
  await tick({ ...config, recoveryAlerts: false })
  assert.equal("runtimeSignals" in (await database.query("SELECT metrics FROM mca_private.ops_health ORDER BY checked_at DESC LIMIT 1")).rows[0].metrics, false)
  assert.equal((await database.query("SELECT * FROM mca_private.ops_incidents WHERE component='email_queue_age'")).rowCount, 0)
  const disabled = await runtimeSignals(db, { origin: config.origin, token: config.token, alerts: false, recoveryAlerts: true })
  assert.deepEqual(Object.keys(disabled).sort(), ["billing", "submissions", "voice"])
  const sample = await metrics()
  assert.equal(sample.billingMaintenanceFailures, 1)
  assert.equal(sample.assistantRuns, 100)
  for (const name of ["email", "sms", "calendar", "receipts", "notifications", "billing"] as const) assert.ok(sample.runtimeSignals[name]!.queueSeconds! > 600, name)
  for (const [name, signal] of Object.entries(sample.runtimeSignals)) if (signal.failures !== undefined) assert.equal(signal.failures, 5, name)
  assert.equal(sample.runtimeSignals.email?.reconnect, 5)
  assert.equal(sample.runtimeSignals.email?.staleSyncs, 5)
  assert.equal(sample.runtimeSignals.calendar?.staleSyncs, 1)
  assert.ok(sample.runtimeSignals.email!.heartbeatSeconds! > 600)
  const rules = recoveryRules(sample, config)
  assert.ok(rules.some(([name, bad, checks]) => name === "billing_maintenance_failures" && bad && checks === 1))
  assert.ok(rules.some(([name, bad]) => name === "assistant_usage" && bad))
  assert.equal(recoveryRules(sample, { ...config, assistantEnabled: false }).some(([name]) => name === "assistant_usage"), false)
  assert.deepEqual(recoveryRules(sample, { ...config, recoveryAlerts: false }), [])
  for (const secret of secrets) assert.equal(JSON.stringify(sample).includes(secret), false)
})

test("threshold boundaries: queue strictly over ten minutes, five failures, three bad health checks", async () => {
  const sample = await metrics()
  sample.runtimeSignals.email = { queueSeconds: 600, failures: 4, reconnect: 4, heartbeatSeconds: 600, staleSyncs: 0 }
  assert.ok(recoveryRules(sample, config).filter(([name]) => name.startsWith("email_")).every(([, bad]) => !bad))
  sample.runtimeSignals.email = { queueSeconds: 601, failures: 5, reconnect: 5, heartbeatSeconds: null, staleSyncs: 1 }
  assert.deepEqual(recoveryRules(sample, config).filter(([name]) => name.startsWith("email_")), [
    ["email_queue_age", true, 3], ["email_provider_failures", true, 1], ["email_stale_sync", true, 3], ["email_senders", true, 1], ["email_worker", true, 3],
  ])
  await tick()
  let incident = (await database.query("SELECT * FROM mca_private.ops_incidents WHERE component='email_queue_age'")).rows[0]
  assert.equal(incident.opened_at, null)
  assert.equal(incident.bad_checks, 1)
  assert.ok((await database.query("SELECT opened_at FROM mca_private.ops_incidents WHERE component='email_provider_failures'")).rows[0].opened_at)
  await tick(); await tick()
  incident = (await database.query("SELECT * FROM mca_private.ops_incidents WHERE component='email_queue_age'")).rows[0]
  assert.ok(incident.opened_at)
  assert.equal(incident.pending_kind, null)
  assert.equal((await database.query("SELECT * FROM mca_private.ops_alert_attempts")).rowCount, 0)
})

test("future work and newly created unsynced conversations do not count as stale", async () => {
  await database.query("UPDATE mca_email_messages SET next_attempt_at=$1", [future])
  await database.query("UPDATE mca_email_conversations SET sync_error=NULL,last_synced_at=NULL,created_at=$1", [now])
  await database.query("UPDATE mca_email_senders SET state='verified'")
  await database.query("UPDATE mca_email_runtime_lease SET last_completed_at=now()")
  await database.query("UPDATE mca_notifications SET next_attempt_at=$1 WHERE id='notice-due'", [future])
  await database.query("UPDATE mca_calendar_connections SET next_sync_at=$1,last_sync_at=$2,failures=0", [future, now])
  await database.query("UPDATE company_billing_notifications SET available_at=$1", [future])
  const signals = await runtimeSignals(db, config)
  assert.equal(signals.email?.queueSeconds, 0)
  assert.equal(signals.email?.staleSyncs, 0)
  assert.equal(signals.email?.failures, 0)
  assert.equal(signals.email?.reconnect, 0)
  assert.equal(signals.notifications?.queueSeconds, 0)
  assert.equal(signals.calendar?.queueSeconds, 0)
  assert.equal(signals.billing?.queueSeconds, 0)
  assert.equal((await queueMetrics(db)).billingMaintenanceFailures, 0)
  for (let i = 0; i < 3; i++) await tick()
  assert.equal((await database.query("SELECT * FROM mca_private.ops_incidents WHERE component LIKE 'email_%' AND opened_at IS NOT NULL")).rowCount, 0)
  await database.query("DELETE FROM mca_email_runtime_lease")
  assert.equal((await runtimeSignals(db, config)).email?.heartbeatSeconds, null)
})

test("expired in-flight leases and recent failure windows do not need provider calls", async () => {
  await database.query("UPDATE sms_operations SET state='running',lease_until=$1 WHERE id='sms-due'", [old])
  await database.query("UPDATE intake_receipts SET lease_token='synthetic',lease_expires_at=$1 WHERE id='receipt-due'", [old])
  await database.query("UPDATE mca_notifications SET state='sending',lease_until=$1 WHERE id='notice-due'", [old])
  await database.query("UPDATE voice_calls SET terminal_at=$1", [old])
  await database.query("UPDATE mca_submission_attempts SET created_at=$1", [old])
  await database.query("UPDATE mca_background_jobs SET updated_at=$1", [old])
  const signals = await runtimeSignals(db, config)
  for (const name of ["sms", "receipts", "notifications"] as const) assert.equal(signals[name]?.expiredLeases, 1)
  for (const name of ["voice", "submissions", "documents"] as const) assert.equal(signals[name]?.failures, 0)
})

test("aggregate failure stays unavailable rather than recovering with healthy zeros", async () => {
  const broken: MonitorDb = { query: (sql, values) => sql.includes("FROM voice_calls") ? Promise.reject(Error(sensitive)) : db.query(sql, values) }
  await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute'")
  const result = await runMonitor(broken, config, async () => Response.json({ databaseOk: true }))
  assert.equal(result.metricsAvailable, false)
  assert.equal((await database.query("SELECT metrics FROM mca_private.ops_health ORDER BY checked_at DESC LIMIT 1")).rows[0].metrics, null)
})

test("native logs, operational error rows and alert payloads exclude credentials, bank data and document content", async () => {
  const lines: string[] = []
  const original = console.error
  console.error = line => { lines.push(String(line)) }
  process.env.MCA_OPERATIONS_ENABLED = "true"
  try {
    for (const secret of secrets) {
      apiError(Object.assign(new Error(secret), { name: secret, code: secret, type: secret, rawType: secret, requestId: secret, param: secret, cause: Error(secret), headers: { authorization: secret }, documentContent: secret }), secret)
      await recordOperationalError(secret, secret)
      await persistEvent(operationalEvent("api", "internal_error", secret, `/api/mca/documents/${secret}?token=${secret}`))
    }
  } finally { console.error = original }
  const rows = (await database.query("SELECT * FROM mca_private.ops_errors")).rows
  assert.ok(rows.length >= secrets.length * 2)
  assert.ok(lines.length >= secrets.length * 2)
  await database.query("TRUNCATE mca_private.ops_incidents,mca_private.ops_alert_attempts")
  const payloads: unknown[] = []
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/api/internal/health")) throw Error(sensitive)
    payloads.push(JSON.parse(String(init?.body)))
    throw Error(sensitive)
  }
  for (let i = 0; i < 4; i++) await tick({ ...config, alerts: true, recipient: "synthetic@example.test", webhook: "https://mock.example.test", webhookToken: secrets[0] }, fetcher)
  assert.ok(payloads.length > 0)
  const attempts = (await database.query("SELECT * FROM mca_private.ops_alert_attempts")).rows
  const encoded = JSON.stringify({ lines, rows, payloads, attempts })
  for (const secret of secrets) assert.equal(encoded.includes(secret), false, secret)
  assert.ok(attempts.every(row => row.state === "unknown"))
  delete process.env.MCA_OPERATIONS_ENABLED
  await new Promise(resolve => setTimeout(resolve, 1100))
})
