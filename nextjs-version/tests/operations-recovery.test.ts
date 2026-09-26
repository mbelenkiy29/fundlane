import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { failedJobs, recoverFailedJob } from "../src/lib/mca/operations/job-recovery"
import { recoveryRules, workerHeartbeatStale } from "../src/lib/mca/operations/monitor"
import { operationalEvent } from "../src/lib/mca/operations/telemetry"
import type { Metrics } from "../src/lib/mca/operations/contracts"
import { GET as recoveryGet } from "../src/app/api/platform/companies/[id]/failed-jobs/route"

const metrics: Metrics = { queued: 0, running: 0, failed: 0, retrying: 0, billingRetrying: 0, expired: 0, oldestSeconds: 0, emailQueued: 0, emailAccepted: 0, emailFailed: 0, emailBlocked: 0, emailUnknown: 0, reconnect: 2, recentEmailFailures: 2, recentErrors: 0, documentWorkerHeartbeatAgeSeconds: 91, documentFailed: 0, scannerUnavailable: 0, queueAgeByKind: { document_scan: 700, export: 200 }, billingMaintenanceFailures: 2, assistantRuns: 101 }
const config = { origin: "https://fundlane.io", token: "x".repeat(40), alerts: true, recoveryAlerts: true, assistantEnabled: true, thresholds: { workerSeconds: 90, queueSeconds: 600, queueByKind: { export: 100 }, providerFailures: 2, billingFailures: 2, assistantRuns: 100 } }
test("recovery alert rules respect every threshold, kind override, flag and assistant activation", () => {
  assert.equal(workerHeartbeatStale(metrics, config), true)
  assert.equal(workerHeartbeatStale({ ...metrics, documentWorkerHeartbeatAgeSeconds: 91 }, { ...config, thresholds: { ...config.thresholds, workerSeconds: 120 } }), false)
  assert.equal(workerHeartbeatStale({ ...metrics, documentWorkerHeartbeatAgeSeconds: null }, config), true)
  assert.deepEqual(recoveryRules(metrics, { ...config, recoveryAlerts: false }), [])
  const rules = Object.fromEntries(recoveryRules(metrics, config).map(([name, bad]) => [name, bad]))
  assert.deepEqual(rules, { sender_provider_failures: true, billing_maintenance_failures: true, assistant_usage: true, queue_age_document_scan: true, queue_age_export: true })
  const quiet = Object.fromEntries(recoveryRules({ ...metrics, documentWorkerHeartbeatAgeSeconds: 90, recentEmailFailures: 1, reconnect: 1, billingMaintenanceFailures: 1, assistantRuns: 99, queueAgeByKind: { document_scan: 600, export: 100, "invalid-secret=bank": 1000 } }, { ...config, assistantEnabled: false }).map(([name, bad]) => [name, bad]))
  assert.deepEqual(quiet, { sender_provider_failures: false, billing_maintenance_failures: false, queue_age_document_scan: false, queue_age_export: false })
})
test("diagnostic events discard credentials, bank content and document paths", () => {
  const event = operationalEvent("Bearer secret-key", "routing 123456789", "bank=123456789", "https://fundlane.io/api/mca/documents/private-statement.pdf?token=secret-key")
  const encoded = JSON.stringify(event)
  for (const secret of ["secret-key", "123456789", "private-statement.pdf"]) assert.equal(encoded.includes(secret), false)
  assert.equal(event.route, "/api/documents/*")
})
test("recovery endpoint is unavailable while its flag is unset", async () => {
  delete process.env.MCA_JOB_RECOVERY_ENABLED
  const response = await recoveryGet(new Request("https://fundlane.io/api/platform/companies/test/failed-jobs"), { params: Promise.resolve({ id: "test" }) })
  assert.equal(response.status, 404)
})

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let workspaceId: string
let userId: string
before(async () => {
  database = await createPostgresTestDatabase("operations_recovery")
  process.env.DATABASE_URL = database.databaseUrl
  const workspace = await createWorkspaceWithAdmin({ workspaceName: "Recovery fixture", adminName: "Operator", adminEmail: `${randomUUID()}@example.test`, password: "Fixture password 99!", role: "admin" })
  workspaceId = workspace.workspaceId
  userId = workspace.userId
})
after(async () => { await closeDatabaseForTests(); await database?.close() })

async function addFailedJob(kind: string, error = "retry_limit") {
  const id = randomUUID(), now = nowIso()
  await getDatabase().prepare(`INSERT INTO mca_background_jobs(id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,error_code,created_at,updated_at)
    VALUES (?,?,?,?,?,'{}','{}','hash','failed',3,?,?,?,?)`).run(id, workspaceId, kind, `resource-${id}`, `key-${id}`, now, error, now, now)
  return id
}
test("failed-job inventory is scoped and internal replay keeps the same identity", async () => {
  const id = await addFailedJob("document_scan")
  assert.equal((await failedJobs("other-workspace")).length, 0)
  assert.equal((await failedJobs(workspaceId))[0].id, id)
  await assert.rejects(recoverFailedJob("other-workspace", id, userId, "replay"), { code: "job_not_found" })
  const result = await recoverFailedJob(workspaceId, id, userId, "replay")
  assert.equal(result.state, "queued")
  const row = await getDatabase().prepare<{ state: string; attempts: number; error_code: string | null }>("SELECT state,attempts,error_code FROM mca_background_jobs WHERE id=?").get(id)
  assert.deepEqual(row, { state: "queued", attempts: 0, error_code: null })
  await assert.rejects(recoverFailedJob(workspaceId, id, userId, "replay"), { code: "job_not_failed" })
})
test("outbound unknown effect is reconciled without any new send or replay", async () => {
  const id = await addFailedJob("submission_delivery", "processing_failed")
  await assert.rejects(recoverFailedJob(workspaceId, id, userId, "replay"), { code: "replay_requires_review" })
  const resolution = await recoverFailedJob(workspaceId, id, userId, "external_effect_confirmed")
  assert.equal(resolution.state, "failed")
  const row = await getDatabase().prepare<{ state: string; attempts: number; error_code: string }>("SELECT state,attempts,error_code FROM mca_background_jobs WHERE id=?").get(id)
  assert.deepEqual(row, { state: "failed", attempts: 3, error_code: "external_effect_confirmed" })
  const audit = await getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE resource_id=? AND action='jobs.platform_external_effect_confirmed'").get(id)
  assert.deepEqual(JSON.parse(audit!.metadata), { kind: "submission_delivery", previousErrorCode: "processing_failed" })
})
