import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  parseWindow,
  safeRoute,
  safeIdentifier,
  isInteractiveApi,
  incidentTransition,
  documentWorkerReady,
  type Incident,
} from "../src/lib/mca/operations/contracts"
import { GET as healthGet } from "../src/app/api/internal/health/route"
import {
  runMonitor as monitorTick,
  queueMetrics,
  type MonitorDb,
} from "../src/lib/mca/operations/monitor"
import {
  platformStatus,
  platformErrors,
} from "../src/lib/mca/operations/status"
import {
  operationalEvent,
  persistEvent,
  boundedTelemetry,
} from "../src/lib/mca/operations/telemetry"
import {
  requireMonitor,
  assertPlatformOwnerId,
} from "../src/lib/mca/operations/access"
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let db: MonitorDb
before(async () => {
  database = await createPostgresTestDatabase("platform_status")
  process.env.DATABASE_URL = database.databaseUrl
  db = {
    query: async (sql, values) =>
      (await database.query(sql, values)).rows as unknown as Record<
        string,
        unknown
      >[],
  }
})
after(async () => {
  await closeDatabaseForTests()
  await database?.close()
})
// Advance only the scheduler guard in the disposable test DB; production accepts one tick per minute.
async function runMonitor(...args: Parameters<typeof monitorTick>) {
  await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute'")
  return monitorTick(...args)
}
test("validates windows, redacts paths and rejects public invocation keys", () => {
  assert.equal(parseWindow(null), "24h")
  assert.throws(() => parseWindow("365d"))
  assert.equal(
    safeRoute(
      "https://fundlane.io/api/mca/deals/customer-secret?token=private"
    ),
    "/api/deals/*"
  )
  assert.equal(safeIdentifier("Bearer password"), null)
  assert.equal(
    isInteractiveApi(
      new Request("https://fundlane.io/api/mca/assistant/notifications")
    ),
    false
  )
  assert.equal(
    isInteractiveApi(new Request("https://fundlane.io/api/mca/deals")),
    true
  )
  assert.equal(
    isInteractiveApi(new Request("https://fundlane.io/api/mca/jobs/secret")),
    false
  )
  process.env.MCA_MONITOR_TOKEN = "x".repeat(40)
  assert.throws(() =>
    requireMonitor(
      new Request("https://fundlane.io", {
        headers: { authorization: "Bearer public-key" },
      })
    )
  )
  assert.doesNotThrow(() =>
    requireMonitor(
      new Request("https://fundlane.io", {
        headers: { authorization: `Bearer ${"x".repeat(40)}` },
      })
    )
  )
})
test("incident thresholds, recovery and reminders suppress duplicates", () => {
  let prior: Incident = {
    opened_at: null,
    bad_checks: 0,
    good_checks: 0,
    last_sent_at: null,
    pending_kind: null,
  }
  const now = "2026-09-14T12:00:00Z"
  for (let i = 1; i <= 3; i++) {
    const n = incidentTransition(prior, true, 3, now)
    assert.equal(n.kind, i === 3 ? "opening" : null)
    prior = { ...prior, bad_checks: n.badChecks, opened_at: n.opened }
  }
  prior = { ...prior, last_sent_at: now }
  assert.equal(
    incidentTransition(prior, true, 3, "2026-09-14T13:00:00Z").kind,
    null
  )
  assert.equal(
    incidentTransition(prior, true, 3, "2026-09-14T18:00:00Z").kind,
    "reminder"
  )
  assert.equal(
    incidentTransition(
      { ...prior, pending_kind: "opening" },
      true,
      3,
      "2026-09-15T18:00:00Z"
    ).kind,
    null
  )
  assert.equal(
    incidentTransition({ ...prior, good_checks: 2 }, false, 3, now).kind,
    "recovery"
  )
})
const config = {
  origin: "https://fundlane.io",
  token: "x".repeat(40),
  alerts: false,
}
const healthy = async () =>
  Response.json({ databaseOk: true, databaseMs: 12, deployment: "dpl_test" })
test("real aggregates distinguish no history, health, errors and current queues", async () => {
  const empty = await platformStatus("24h")
  assert.equal(empty.latest, null)
  assert.equal(empty.observedAvailability, null)
  assert.equal(empty.stale, true)
  const metrics = await queueMetrics(db)
  assert.equal(metrics.queued, 0)
  assert.equal(metrics.emailUnknown, 0)
  await runMonitor(db, config, healthy)
  const good = await platformStatus("24h")
  assert.equal(good.samples, 1)
  assert.equal(good.observedAvailability, 1)
  assert.equal(good.latest?.database_ms, 12)
  await database.query(
    "INSERT INTO mca_private.ops_errors(id,component,code) VALUES($1,'api','internal_error')",
    [randomUUID()]
  )
  assert.equal((await platformStatus("24h")).errors, 1)
  assert.equal(
    (await platformErrors(new Date(0).toISOString(), "api", null)).length,
    1
  )
  assert.equal(
    (await platformErrors(new Date(0).toISOString(), "worker", null)).length,
    0
  )
})
test("owner status exposes email runtime checks only when the consumer is enabled", async () => {
  const previous = process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME
  try {
    delete process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME
    assert.equal((await platformStatus("24h")).emailRuntime, null)
    process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME = "vercel_cron"
    await database.query("INSERT INTO mca_email_runtime_lease(id,token,expires_at,last_started_at,last_completed_at) VALUES(1,'test',now(),now()-interval '12 minutes',now()-interval '12 minutes') ON CONFLICT(id) DO UPDATE SET last_completed_at=EXCLUDED.last_completed_at")
    const status = (await platformStatus("24h")).emailRuntime
    assert.equal(status?.queued, 0)
    assert.equal(status?.syncFailures, 0)
    assert.equal(status?.staleSyncs, 0)
    assert.ok(status?.lastCompletedAt)
  } finally {
    if (previous === undefined) delete process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME
    else process.env.MCA_EMAIL_CONVERSATIONS_RUNTIME = previous
  }
})
test("overlapping invocations cannot collect or send twice", async () => {
  let release: () => void = () => {}
  const barrier = new Promise<void>((r) => (release = r))
  let entered: () => void = () => {}
  const arrived = new Promise<void>((r) => (entered = r))
  const first = runMonitor(db, config, async () => {
    entered()
    await barrier
    return healthy()
  })
  await arrived
  assert.deepEqual(await runMonitor(db, config, healthy), { skipped: true })
  release()
  await first
})
test("failed health triggers once, accepted alert recovers once, content contains no secrets", async () => {
  await database.query("TRUNCATE mca_private.ops_incidents")
  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
  )
  let sends = 0
  const sender: typeof fetch = async (url, options) => {
    if (String(url).includes("/api/internal/health"))
      throw new Error("secret database password")
    sends++
    const body = JSON.parse(String(options?.body))
    assert.equal(body.template, "operations_alert")
    assert.equal(JSON.stringify(body).includes("password"), false)
    return new Response(null, { status: 200 })
  }
  const alertConfig = {
    ...config,
    alerts: true,
    recipient: "owner@example.test",
    webhook: "https://mail.example.test",
  }
  for (let i = 0; i < 4; i++) await runMonitor(db, alertConfig, sender)
  assert.equal(sends, 2) // website and database are separate incidents
  const recovering: typeof fetch = async (url) =>
    String(url).includes("/api/internal/health")
      ? healthy()
      : (sends++, new Response(null, { status: 200 }))
  for (let i = 0; i < 4; i++) await runMonitor(db, alertConfig, recovering)
  assert.equal(sends, 4)
  assert.equal(
    (
      await database.query(
        "SELECT * FROM mca_private.ops_incidents WHERE opened_at IS NOT NULL"
      )
    ).rowCount,
    0
  )
})
test("ambiguous alert delivery is not automatically retried", async () => {
  await database.query("TRUNCATE mca_private.ops_incidents")
  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
  )
  let sends = 0
  const fetcher: typeof fetch = async (url) => {
    if (String(url).includes("/api/internal/health")) throw new Error("offline")
    sends++
    throw new Error("timeout after send")
  }
  const options = {
    ...config,
    alerts: true,
    recipient: "owner@example.test",
    webhook: "https://mail.example.test",
  }
  for (let i = 0; i < 5; i++) await runMonitor(db, options, fetcher)
  assert.equal(sends, 2)
  assert.equal(
    (
      await database.query(
        "SELECT * FROM mca_private.ops_incidents WHERE delivery_state='unknown'"
      )
    ).rowCount,
    2
  )
})
test("failed aggregate does not become a healthy zero and telemetry failure is contained", async () => {
  const broken: MonitorDb = {
    query: (sql, values) => {
      if (sql.startsWith("SELECT\n")) throw new Error("db timeout")
      return db.query(sql, values)
    },
  }
  await runMonitor(broken, config, healthy)
  assert.equal((await platformStatus("24h")).latest?.metrics, null)
  const event = operationalEvent(
    "api",
    "invalid code with secret",
    "secret=token",
    "https://fundlane.io/api/mca/deals/secret"
  )
  assert.equal(event.code, "internal_error")
  assert.equal(event.correlationId, null)
  assert.equal(event.route, "/api/deals/*")
  process.env.MCA_OPERATIONS_ENABLED = "true"
  await persistEvent(event)
  await boundedTelemetry("SELECT * FROM intentionally_missing_table", [])
  delete process.env.MCA_OPERATIONS_ENABLED
})

test("owner grant is immutable-ID based, never a company role or matching email", () => {
  process.env.MCA_PLATFORM_OWNER_USER_ID = "owner-id"
  assert.throws(() => assertPlatformOwnerId(null), { status: 401 })
  for (const id of ["admin", "super_admin", "owner@example.test", "other-id"])
    assert.throws(() => assertPlatformOwnerId(id), { status: 403 })
  assert.doesNotThrow(() => assertPlatformOwnerId("owner-id"))
  delete process.env.MCA_PLATFORM_OWNER_USER_ID
  assert.throws(() => assertPlatformOwnerId("owner-id"), { status: 403 })
})

test('expired monitor leases recover and abandoned alert attempts are not resent', async () => {
  await database.query("UPDATE mca_private.ops_control SET lease_token=$1,lease_until=now()-interval '1 minute'",[randomUUID()])
  await database.query('TRUNCATE mca_private.ops_incidents,mca_private.ops_alert_attempts')
  const id=randomUUID()
  await database.query("INSERT INTO mca_private.ops_incidents(component,opened_at,pending_kind,pending_id,delivery_state,last_attempt_at) VALUES('website',now(),'opening',$1,'sending',now()-interval '5 minutes')",[id])
  await database.query("INSERT INTO mca_private.ops_alert_attempts(id,component,kind,state,attempted_at) VALUES($1,'website','opening','sending',now()-interval '5 minutes')",[id])
  let sends=0
  await runMonitor(db,{...config,alerts:true,recipient:'owner@example.test',webhook:'https://mail.example.test'},async(url)=>String(url).includes('/api/internal/health')?healthy():(sends++,new Response(null,{status:200})))
  assert.equal(sends,0)
  assert.equal(((await database.query('SELECT state FROM mca_private.ops_alert_attempts WHERE id=$1',[id])).rows[0] as unknown as {state:string}).state,'unknown')
})

test('retention removes old telemetry without deleting current events',async()=>{
  const id=randomUUID()
  await database.query("INSERT INTO mca_private.ops_errors(id,component,code,occurred_at) VALUES($1,'api','internal_error',now()-interval '31 days')",[id])
  await runMonitor(db,config,healthy)
  assert.equal((await database.query('SELECT id FROM mca_private.ops_errors WHERE id=$1',[id])).rowCount,0)
  assert.ok((await database.query('SELECT id FROM mca_private.ops_errors')).rowCount!>0)
})

test('polled dashboards do not inflate activity, while explicit sends count',()=>{
  for(const path of ['applications','intake','calendar','senders','sms/conversations'])assert.equal(isInteractiveApi(new Request(`https://fundlane.io/api/mca/${path}`)),false)
  assert.equal(isInteractiveApi(new Request('https://fundlane.io/api/mca/email/conversations/x/messages',{method:'POST'})),true)
  assert.equal(isInteractiveApi(new Request('https://fundlane.io/api/mca/sms/conversations',{method:'POST'})),false)
})

test('disabled alerts still allow incidents to recover; duplicate minute ticks skip',async()=>{
  await database.query('TRUNCATE mca_private.ops_incidents')
  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
  )
  for(let i=0;i<3;i++)await runMonitor(db,config,async()=>{throw new Error('offline')})
  assert.equal((await database.query('SELECT * FROM mca_private.ops_incidents WHERE opened_at IS NOT NULL')).rowCount,2)
  for(let i=0;i<3;i++)await runMonitor(db,config,healthy)
  assert.equal((await database.query('SELECT * FROM mca_private.ops_incidents WHERE opened_at IS NOT NULL')).rowCount,0)
  assert.deepEqual(await monitorTick(db,config,healthy),{skipped:true})
})

test("document worker ready vs lag surfaces metrics, health workerReady, incident, and dashboard warning", async () => {
  assert.equal(documentWorkerReady({ documentWorkerHeartbeatAgeSeconds: 30 }), true)
  assert.equal(documentWorkerReady({ documentWorkerHeartbeatAgeSeconds: 90 }), true)
  assert.equal(documentWorkerReady({ documentWorkerHeartbeatAgeSeconds: 91 }), false)
  assert.equal(documentWorkerReady({ documentWorkerHeartbeatAgeSeconds: null }), false)

  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
  )
  const fresh = await queueMetrics(db)
  assert.ok(fresh.documentWorkerHeartbeatAgeSeconds != null)
  assert.ok(fresh.documentWorkerHeartbeatAgeSeconds! <= 90)
  assert.equal(documentWorkerReady(fresh), true)

  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=NULL"
  )
  assert.equal((await queueMetrics(db)).documentWorkerHeartbeatAgeSeconds, null)

  process.env.MCA_MONITOR_TOKEN = "x".repeat(40)
  const auth = {
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  }
  const laggingHealth = await healthGet(
    new Request("https://fundlane.io/api/internal/health", auth)
  )
  assert.equal(laggingHealth.status, 200)
  const laggingBody = await laggingHealth.json()
  assert.equal(laggingBody.databaseOk, true)
  assert.equal(laggingBody.workerReady, false)

  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()"
  )
  const readyHealth = await healthGet(
    new Request("https://fundlane.io/api/internal/health", auth)
  )
  assert.equal(readyHealth.status, 200)
  assert.equal((await readyHealth.json()).workerReady, true)

  await database.query("TRUNCATE mca_private.ops_incidents")
  await database.query(
    "UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now()-interval '5 minutes'"
  )
  for (let i = 0; i < 3; i++) await runMonitor(db, config, healthy)
  assert.equal(
    (
      await database.query(
        "SELECT * FROM mca_private.ops_incidents WHERE component='document_worker' AND opened_at IS NOT NULL"
      )
    ).rowCount,
    1
  )

  const dashboard = readFileSync(
    resolve(process.cwd(), "src/components/mca/operations/status-dashboard.tsx"),
    "utf8"
  )
  assert.match(
    dashboard,
    /Document worker has not claimed work recently\./
  )
  assert.match(dashboard, /documentWorkerReady/)
})
