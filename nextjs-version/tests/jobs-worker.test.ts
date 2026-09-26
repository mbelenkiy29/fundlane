import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import { getDocument, retryDocumentScan, storeDocument } from "../src/lib/mca/documents/service"
import { createFunder } from "../src/lib/mca/funders/directory"
import { claimBackgroundJob, completeBackgroundJob, enqueueBackgroundJob, failBackgroundJob, runAsBackgroundWorker } from "../src/lib/mca/jobs/queue"
import { recoverSubmissionOutbox, runNextBackgroundJob, touchDocumentWorkerHeartbeat } from "../src/lib/mca/jobs/worker"
import { GET as runCron } from "../src/app/api/cron/jobs/route"
import { GET as runDocumentsCron } from "../src/app/api/cron/documents/route"
import { withExecutionDeadline } from "../src/lib/mca/jobs/execution"
import { createExportJob } from "../src/lib/mca/exports/service"
import { setAutoSubmitSettings } from "../src/lib/mca/underwriting/auto-submit"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { persistNewDestination } from "../src/lib/mca/submissions/repository"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_EMAIL_WEBHOOK_URL
const previousJobs = process.env.MCA_BACKGROUND_JOBS
const previousVercel = process.env.VERCEL
const previousPoolMax = process.env.MCA_DB_POOL_MAX
const previousNativeExecutor = process.env.MCA_NATIVE_DOCUMENT_EXECUTOR
let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (): DealActor => ({
  workspaceId: "workspace-jobs",
  userId: null,
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: "corr-jobs",
})
const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) { if (memory.has(key)) throw new Error("duplicate storage key"); memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing storage key"); return new Uint8Array(value) },
}
const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
}

function countingScanner() {
  let scans = 0
  setDocumentScannerForTests({
    name: "fixture-clean",
    async scan() {
      scans++
      return { status: "clean", provider: "fixture-clean", evidence: { engineVerified: true } }
    },
  })
  return { count: () => scans }
}

let dealId = ""
before(async () => {
  process.env.MCA_BACKGROUND_JOBS = "enabled"
  process.env.MCA_NATIVE_DOCUMENT_EXECUTOR = "true"
  delete process.env.VERCEL
  testDatabase = await createPostgresTestDatabase("jobs_worker")
  process.env.DATABASE_URL = testDatabase.databaseUrl
  process.env.MCA_DB_POOL_MAX = "2"
  setDocumentStorageForTests(storage)
  setSubmissionCompletenessForTests(true)
  await addWorkspace("workspace-jobs")
  dealId = (await createDeal(actor(), { idempotencyKey: "jobs-staging", legalName: "Jobs staging" })).deal.id
})
after(async () => {
  setDocumentStorageForTests(); setDocumentScannerForTests(); setSubmissionCompletenessForTests(); await closeDatabaseForTests(); await testDatabase.close()
  if (previousJobs === undefined) delete process.env.MCA_BACKGROUND_JOBS
  else process.env.MCA_BACKGROUND_JOBS = previousJobs
  if (previousVercel === undefined) delete process.env.VERCEL
  else process.env.VERCEL = previousVercel
  if (previousPoolMax === undefined) delete process.env.MCA_DB_POOL_MAX
  else process.env.MCA_DB_POOL_MAX = previousPoolMax
  if (previousNativeExecutor === undefined) delete process.env.MCA_NATIVE_DOCUMENT_EXECUTOR
  else process.env.MCA_NATIVE_DOCUMENT_EXECUTOR = previousNativeExecutor
})

test("Vercel/jobs-enabled deal uploads enqueue document_scan and do not promote until the worker runs", async () => {
  const scanner = countingScanner()
  const stored = await storeDocument(actor(), { dealId, idempotencyKey: "jobs-http-upload", filename: "statement.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
  assert.equal(stored.processingState, "pending_scan")
  assert.equal(scanner.count(), 0)
  const job = await getDatabase().prepare<{ kind: string; state: string }>("SELECT kind, state FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'").get(actor().workspaceId, stored.id)
  assert.equal(job?.kind, "document_scan")
  assert.equal(job?.state, "queued")
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal(scanner.count(), 1)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "clean")
})

test("storeDocument inside the background worker still scans inline without extra document_scan jobs", async () => {
  const scanner = countingScanner()
  const stored = await runAsBackgroundWorker(() => storeDocument(actor(), { dealId, idempotencyKey: "jobs-worker-inline", filename: "inline.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "other_stip", source: "test" }))
  assert.equal(stored.processingState, "clean")
  assert.equal(scanner.count(), 1)
  const job = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'").get(actor().workspaceId, stored.id)
  assert.equal(job?.count, 0)
})

test("queueSubmissions with jobs enabled enqueues submission_delivery and leaves the job queued", async () => {
  countingScanner()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: "smtp-jobs-password" },
  })
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  const funderId = (await createFunder(actor(), {
    idempotencyKey: "jobs-email-funder",
    legalName: "Jobs Email Capital LLC",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@jobscap.example.test", documentExceptions: [], active: true }],
  })).funder.id
  const submissionDeal = (await createDeal(actor(), { idempotencyKey: "jobs-submission-deal", legalName: "Jobs submission" })).deal
  const stored = await runAsBackgroundWorker(() => storeDocument(actor(), {
    dealId: submissionDeal.id,
    idempotencyKey: "jobs-submission-doc",
    filename: "package.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  }))
  assert.equal(stored.processingState, "clean")

  const result = await queueSubmissions({
    actor: actor(),
    dealId: submissionDeal.id,
    funderIds: [funderId],
    confirmationKey: "jobs-confirm-1",
  })
  assert.equal(result.ok, true)
  assert.equal(result.jobs.length, 1)
  const queued = result.jobs[0]
  assert.ok(queued)
  assert.equal(queued.state, "queued")
  const job = await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_submission_jobs WHERE id = ?").get(queued.jobId)
  assert.equal(job?.state, "queued")
  const delivery = await getDatabase().prepare<{ kind: string; state: string; resource_id: string }>(
    "SELECT kind, state, resource_id FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'submission_delivery'",
  ).get(actor().workspaceId, queued.jobId)
  assert.equal(delivery?.kind, "submission_delivery")
  assert.equal(delivery?.resource_id, queued.jobId)
  assert.equal(delivery?.state, "queued")
})

test("recover enqueues missing delivery jobs and skips actorless legacy rows; second recover is 0", async () => {
  const recoverableFunder = (await createFunder(actor(), {
    idempotencyKey: "jobs-recover-funder",
    legalName: "Recover Capital LLC",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@recover.example.test", documentExceptions: [], active: true }],
  })).funder
  const legacyFunder = (await createFunder(actor(), {
    idempotencyKey: "jobs-recover-legacy-funder",
    legalName: "Legacy Capital LLC",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@legacy.example.test", documentExceptions: [], active: true }],
  })).funder
  const route = { id: "recover-route", kind: "email" as const, label: "Submissions", destination: "subs@recover.example.test", documentExceptions: [], active: true }
  const recoverable = (await persistNewDestination({
    workspaceId: actor().workspaceId,
    dealId,
    funderId: recoverableFunder.id,
    displayFunderName: recoverableFunder.legalName,
    routeKind: "email",
    route,
    state: "queued",
    confirmationKey: "jobs-recover-actor",
    attemptKey: "jobs-recover-actor",
    dealVersion: 1,
    documentVersions: [],
    packageDocumentIds: [],
    preflightErrors: [],
    merchantIdentityKey: `deal:${dealId}`,
    packageFingerprint: "",
    createdByUserId: null,
    actor: actor(),
  })).job
  const legacy = (await persistNewDestination({
    workspaceId: actor().workspaceId,
    dealId,
    funderId: legacyFunder.id,
    displayFunderName: legacyFunder.legalName,
    routeKind: "email",
    route,
    state: "queued",
    confirmationKey: "jobs-recover-legacy",
    attemptKey: "jobs-recover-legacy",
    dealVersion: 1,
    documentVersions: [],
    packageDocumentIds: [],
    preflightErrors: [],
    merchantIdentityKey: `deal:${dealId}`,
    packageFingerprint: "",
    createdByUserId: null,
  })).job

  assert.equal(await recoverSubmissionOutbox(), 1)
  const delivery = await getDatabase().prepare<{ kind: string; state: string; actor_json: string }>(
    "SELECT kind, state, actor_json FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'submission_delivery'",
  ).get(actor().workspaceId, recoverable.id)
  assert.equal(delivery?.kind, "submission_delivery")
  assert.equal(delivery?.state, "queued")
  assert.equal(JSON.parse(delivery?.actor_json ?? "{}").source, "system")
  assert.equal(JSON.parse(delivery?.actor_json ?? "{}").userId, null)
  const skipped = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'submission_delivery'",
  ).get(actor().workspaceId, legacy.id)
  assert.equal(skipped?.count, 0)
  assert.equal(await recoverSubmissionOutbox(), 0)
})

test("heartbeat is written even when the queue is empty", async () => {
  const now = new Date().toISOString()
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='failed', error_code='test_drain', updated_at=? WHERE state IN ('queued','running')").run(now)
  await getDatabase().prepare("UPDATE mca_submission_outbox SET processed_at=? WHERE processed_at IS NULL").run(now)
  assert.equal(await runNextBackgroundJob(), false)
  await touchDocumentWorkerHeartbeat()
  assert.equal(await runNextBackgroundJob(), false)
  const heartbeat = await getDatabase().prepare<{ document_worker_heartbeat_at: Date | string | null }>(
    "SELECT document_worker_heartbeat_at FROM mca_private.ops_control WHERE id",
  ).get()
  assert.ok(heartbeat?.document_worker_heartbeat_at)
})

test("legacy scan completion stays unchanged when both new runtime flags are unset", async () => {
  const native = process.env.MCA_NATIVE_DOCUMENT_EXECUTOR
  const cron = process.env.MCA_DOCUMENT_JOB_RUNTIME
  try {
    delete process.env.MCA_NATIVE_DOCUMENT_EXECUTOR
    delete process.env.MCA_DOCUMENT_JOB_RUNTIME
    setDocumentScannerForTests(undefined)
    const stored = await storeDocument(actor(), { dealId, idempotencyKey: "legacy-unavailable-scan", filename: "legacy.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
    assert.equal(await runNextBackgroundJob(["document_scan"]), true)
    assert.equal((await getDocument(actor(), stored.id)).processingState, "pending_scan")
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE kind='document_scan' AND resource_id=?").get(stored.id))?.state, "complete")
  } finally {
    if (native === undefined) delete process.env.MCA_NATIVE_DOCUMENT_EXECUTOR; else process.env.MCA_NATIVE_DOCUMENT_EXECUTOR = native
    if (cron === undefined) delete process.env.MCA_DOCUMENT_JOB_RUNTIME; else process.env.MCA_DOCUMENT_JOB_RUNTIME = cron
  }
})

test("unconfigured scan completion requeues on retry so a later worker actually scans", async () => {
  setDocumentScannerForTests(undefined)
  const stored = await storeDocument(actor(), {
    dealId,
    idempotencyKey: "jobs-retry-unconfigured",
    filename: "retry-scan.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "other_stip",
    source: "test",
  })
  assert.equal(stored.processingState, "pending_scan")
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "pending_scan")
  const completed = await getDatabase().prepare<{ state: string; error_code: string; id: string }>(
    "SELECT id, state, error_code FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'",
  ).get(actor().workspaceId, stored.id)
  assert.equal(completed?.state, "queued")
  assert.equal(completed?.error_code, "scanner_unavailable")

  const scanner = countingScanner()
  const retried = await retryDocumentScan(actor(), stored.id)
  assert.equal(retried.processingState, "pending_scan")
  assert.equal(scanner.count(), 0)
  const requeued = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan' AND state IN ('queued','running')",
  ).get(actor().workspaceId, stored.id)
  assert.equal(requeued?.state, "queued")
  await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", completed!.id)
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal(scanner.count(), 1)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "clean")
})

test("document_scan enqueue uses a durable system actor so expired user sessions still scan", async () => {
  const userActor: DealActor = {
    workspaceId: actor().workspaceId,
    userId: "user-jobs-session",
    membershipId: "member-jobs-session",
    role: "admin",
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "user",
    correlationId: "corr-jobs-user",
    sessionId: "session-jobs-expired",
  }
  setDocumentScannerForTests(undefined)
  const stored = await storeDocument(userActor, {
    dealId,
    idempotencyKey: "jobs-expired-session",
    filename: "session-scan.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "other_stip",
    source: "test",
  })
  assert.equal(stored.processingState, "pending_scan")
  const enqueued = await getDatabase().prepare<{ id: string; state: string; actor_json: string }>(
    "SELECT id, state, actor_json FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'",
  ).get(actor().workspaceId, stored.id)
  const storedActor = JSON.parse(enqueued?.actor_json ?? "{}") as DealActor
  assert.equal(enqueued?.state, "queued")
  assert.equal(storedActor.source, "system")
  assert.equal(storedActor.userId, null)
  assert.equal(storedActor.intakeDealId, dealId)
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "pending_scan")

  const scanner = countingScanner()
  const retried = await retryDocumentScan(userActor, stored.id)
  assert.equal(retried.processingState, "pending_scan")
  assert.equal(scanner.count(), 0)
  const requeued = await getDatabase().prepare<{ state: string; actor_json: string }>(
    "SELECT state, actor_json FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan' AND state IN ('queued','running')",
  ).get(actor().workspaceId, stored.id)
  assert.equal(requeued?.state, "queued")
  assert.equal(JSON.parse(requeued?.actor_json ?? "{}").source, "system")
  await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", enqueued!.id)
  assert.equal(await runNextBackgroundJob(), true)
  assert.equal(scanner.count(), 1)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "clean")
})

test("cron is off by default and requires the exact bearer credential when enabled", async () => {
  const oldRuntime = process.env.MCA_JOB_RUNTIME
  const oldSecret = process.env.CRON_SECRET
  try {
    delete process.env.MCA_JOB_RUNTIME
    delete process.env.CRON_SECRET
    assert.deepEqual(await (await runCron(new Request("http://localhost/api/cron/jobs"))).json(), { enabled: false })
    process.env.MCA_JOB_RUNTIME = "vercel_cron"
    assert.equal((await runCron(new Request("http://localhost/api/cron/jobs"))).status, 503)
    process.env.CRON_SECRET = "synthetic-cron-secret"
    assert.equal((await runCron(new Request("http://localhost/api/cron/jobs", { headers: { authorization: "Bearer wrong" } }))).status, 401)
    const response = await runCron(new Request("http://localhost/api/cron/jobs", { headers: { authorization: "Bearer synthetic-cron-secret" } }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).processed, 0)
  } finally {
    if (oldRuntime === undefined) delete process.env.MCA_JOB_RUNTIME
    else process.env.MCA_JOB_RUNTIME = oldRuntime
    if (oldSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldSecret
  }
})

test("enabled cron completes only its eligible private export", async () => {
  const oldRuntime = process.env.MCA_JOB_RUNTIME
  const oldSecret = process.env.CRON_SECRET
  try {
    const scanner = countingScanner()
    const document = await storeDocument(actor(), { dealId, idempotencyKey: "cron-excludes-native", filename: "native.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
    const exported = await createExportJob(actor(), { kind: "deals", correlationId: "cron-private-export", async: true })
    const queued = await enqueueBackgroundJob({ actor: actor(), kind: "export", resourceId: exported.job.id, idempotencyKey: "cron-private-export" })
    process.env.MCA_JOB_RUNTIME = "vercel_cron"
    process.env.CRON_SECRET = "synthetic-cron-secret"
    const response = await runCron(new Request("http://localhost/api/cron/jobs", { headers: { authorization: "Bearer synthetic-cron-secret" } }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).processed, 1)
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(queued.id))?.state, "complete")
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE kind='document_scan' AND resource_id=?").get(document.id))?.state, "queued")
    assert.equal(scanner.count(), 0)
    assert.equal(await runNextBackgroundJob(["document_scan"]), true)
  } finally {
    if (oldRuntime === undefined) delete process.env.MCA_JOB_RUNTIME
    else process.env.MCA_JOB_RUNTIME = oldRuntime
    if (oldSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldSecret
  }
})

test("cron claims auto-submit only when both runtime and feature flags are on; legacy worker also handles it", async () => {
  const oldRuntime = process.env.MCA_JOB_RUNTIME
  const oldFeature = process.env.MCA_AUTO_SUBMIT_ENABLED
  const oldSecret = process.env.CRON_SECRET
  try {
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    const funder = await createFunder(actor(), {
      idempotencyKey: "cron-auto-score-funder",
      legalName: "Cron Score Capital LLC",
      routes: [{ kind: "email", label: "Submissions", destination: "scores@cron.example.test", documentExceptions: [], active: true }],
    })
    const deal = (await createDeal(actor(), {
      idempotencyKey: "cron-auto-score-deal", legalName: "Cron Score Merchant LLC", entityType: "llc",
      address: { line1: "1 Main St", city: "New York", state: "NY", postalCode: "10001" },
      startDate: "2020-01-01", industry: "restaurants", naicsCode: "722511", monthlyRevenue: 20_000,
      ficoScore: 680, requestedAmount: 50_000, requestedTermMonths: 12, fundingPurpose: "working capital",
    })).deal
    await setAutoSubmitSettings(actor(), { mode: "score_only", minMatchScore: 80, maxFundersPerDeal: 3, eligibleFunderIds: [funder.funder.id] })
    const now = new Date().toISOString()
    await getDatabase().prepare(`INSERT INTO mca_completeness_results
      (id,workspace_id,deal_id,ready,version,rule_snapshot,findings_json,findings_fingerprint,checked_at)
      VALUES (?,?,?,1,1,'{}','[]','ready',?)`).run("cron-auto-complete", actor().workspaceId, deal.id, now)
    const job = await enqueueBackgroundJob({ actor: actor(), kind: "auto_submit", resourceId: deal.id,
      idempotencyKey: "cron-auto-score-job", payload: { completenessVersion: 1, dealVersion: deal.version, mode: "score_only" } })
    const request = () => new Request("http://localhost/api/cron/jobs", { headers: { authorization: "Bearer synthetic-cron-secret" } })
    const state = async () => (await getDatabase().prepare<{ state: string; attempts: number }>("SELECT state,attempts FROM mca_background_jobs WHERE id=?").get(job.id))
    process.env.CRON_SECRET = "synthetic-cron-secret"
    delete process.env.MCA_JOB_RUNTIME
    assert.deepEqual(await (await runCron(request())).json(), { enabled: false })
    assert.deepEqual(await state(), { state: "queued", attempts: 0 })
    process.env.MCA_JOB_RUNTIME = "vercel_cron"
    delete process.env.MCA_AUTO_SUBMIT_ENABLED
    assert.equal((await (await runCron(request())).json()).processed, 0)
    assert.deepEqual(await state(), { state: "queued", attempts: 0 })
    process.env.MCA_AUTO_SUBMIT_ENABLED = "true"
    assert.equal((await (await runCron(request())).json()).processed, 1)
    assert.deepEqual(await state(), { state: "complete", attempts: 1 })
    const decisions = await getDatabase().prepare<{ outcome: string }>("SELECT outcome FROM mca_auto_submit_decisions WHERE workspace_id=? AND deal_id=?").all(actor().workspaceId, deal.id)
    assert.ok(decisions.length > 0)
    assert.ok(decisions.every(decision => decision.outcome === "scored"))
    assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::integer AS n FROM mca_submission_jobs WHERE workspace_id=? AND deal_id=?").get(actor().workspaceId, deal.id))?.n, 0)

    const legacy = await enqueueBackgroundJob({ actor: actor(), kind: "auto_submit", resourceId: deal.id,
      idempotencyKey: "legacy-auto-score-job", payload: { completenessVersion: 1, dealVersion: deal.version, mode: "score_only" } })
    assert.equal(await runNextBackgroundJob(["auto_submit"]), true)
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(legacy.id))?.state, "complete")
  } finally {
    if (oldRuntime === undefined) delete process.env.MCA_JOB_RUNTIME
    else process.env.MCA_JOB_RUNTIME = oldRuntime
    if (oldFeature === undefined) delete process.env.MCA_AUTO_SUBMIT_ENABLED
    else process.env.MCA_AUTO_SUBMIT_ENABLED = oldFeature
    if (oldSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldSecret
  }
})

test("a claimed export blocked in PostgreSQL stops at the request deadline and retries", async () => {
  const exported = await createExportJob(actor(), { kind: "deals", correlationId: "cron-expired-export", async: true })
  const queued = await enqueueBackgroundJob({ actor: actor(), kind: "export", resourceId: exported.job.id, idempotencyKey: "cron-expired-export" })
  const blocker = new Client({ connectionString: testDatabase.databaseUrl })
  await blocker.connect()
  try {
    await blocker.query("BEGIN")
    await blocker.query("SELECT id FROM mca_export_jobs WHERE id=$1 FOR UPDATE", [exported.job.id])
    const started = performance.now()
    await assert.rejects(
      withExecutionDeadline(() => runNextBackgroundJob(["export"]), undefined, 2_000),
      /expired/,
    )
    assert.ok(performance.now() - started < 5_000, "the blocked export must return before the platform limit")
  } finally {
    await blocker.query("ROLLBACK")
    await blocker.end()
  }
  const job = await getDatabase().prepare<{ state: string; error_code: string; attempts: number }>("SELECT state,error_code,attempts FROM mca_background_jobs WHERE id=?").get(queued.id)
  assert.equal(job?.state, "queued")
  assert.equal(job?.error_code, "execution_expired")
  assert.equal(job?.attempts, 1)
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_export_jobs WHERE id=?").get(exported.job.id))?.state, "queued")
})

test("expired claim retains identity, fences stale completion, and retries with backoff", async () => {
  const id = "synthetic-killed-export"
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_background_jobs
    (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,created_at,updated_at)
    VALUES (?,?, 'export', ?, ?, ?, '{}', ?, 'queued',0,?,?,?)`)
    .run(id, actor().workspaceId, id, id, JSON.stringify(actor()), id, now, now, now)
  const claims = await Promise.all([claimBackgroundJob(["export"]), claimBackgroundJob(["export"])])
  assert.equal(claims.filter(Boolean).length, 1)
  const first = claims.find(Boolean)
  assert.equal(first?.id, id)
  assert.equal(first?.attempts, 1)
  const duplicate = await getDatabase().prepare(`INSERT INTO mca_background_jobs
    (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,created_at,updated_at)
    VALUES ('synthetic-duplicate-export',?,'export',?,?,?,?,?,'queued',0,?,?,?) ON CONFLICT (workspace_id,kind,idempotency_key) DO NOTHING`)
    .run(actor().workspaceId, id, id, JSON.stringify(actor()), "{}", id, now, now, now)
  assert.equal(duplicate.changes, 0)
  assert.equal(await claimBackgroundJob(["export"]), undefined)
  await getDatabase().prepare("UPDATE mca_background_jobs SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", id)
  const second = await claimBackgroundJob(["export"])
  assert.equal(second?.id, id)
  assert.equal(second?.attempts, 2)
  assert.notEqual(second?.lease_token, first?.lease_token)
  await assert.rejects(completeBackgroundJob(first!, { stale: true }), /background_job_lease_lost/)
  await failBackgroundJob(first!, new Error("stale execution"))
  assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_background_jobs WHERE id=?").get(id))?.state, "running")
  await failBackgroundJob(second!, new Error("synthetic retry"))
  const waiting = await getDatabase().prepare<{ state: string; attempts: number; available_at: string }>("SELECT state,attempts,available_at FROM mca_background_jobs WHERE id=?").get(id)
  assert.equal(waiting?.state, "queued")
  assert.equal(waiting?.attempts, 2)
  assert.ok(Date.parse(waiting!.available_at) > Date.now())
  await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", id)
  const third = await claimBackgroundJob(["export"])
  assert.equal(third?.id, id)
  assert.equal(third?.attempts, 3)
  await failBackgroundJob(third!, new Error("synthetic terminal failure"))
})

test("maximum-size synthetic private document retries after a killed claim", async (t) => {
  const started = performance.now()
  const scanner = countingScanner()
  const bytes = new Uint8Array(25 * 1024 * 1024)
  bytes.set(minimalPdf)
  const stored = await storeDocument(actor(), { dealId, idempotencyKey: "max-private-retry", filename: "max.pdf", mimeType: "application/pdf", bytes, category: "statement", source: "test" })
  const first = await claimBackgroundJob(["document_scan"])
  assert.equal(first?.resource_id, stored.id)
  assert.equal(scanner.count(), 0)
  assert.ok([...memory.values()].some(value => value.byteLength === bytes.byteLength))
  await getDatabase().prepare("UPDATE mca_background_jobs SET lease_expires_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first!.id)
  assert.equal(await runNextBackgroundJob(["document_scan"]), true)
  assert.equal(scanner.count(), 1)
  assert.equal((await getDocument(actor(), stored.id)).processingState, "clean")
  const final = await getDatabase().prepare<{ id: string; attempts: number; state: string }>("SELECT id,attempts,state FROM mca_background_jobs WHERE id=?").get(first!.id)
  assert.deepEqual(final, { id: first!.id, attempts: 2, state: "complete" })
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT count(*)::int AS count FROM mca_documents WHERE workspace_id=? AND idempotency_key='max-private-retry'").get(actor().workspaceId))?.count, 1)
  t.diagnostic(JSON.stringify({ bytes: bytes.byteLength, durationMs: Math.round(performance.now() - started), firstJobId: first!.id, retryJobId: final.id, privateStorage: true, externalSends: 0 }))
})

test("document cron defaults off and rejects missing or incorrect bearer without claiming", async () => {
  const previous = process.env.MCA_DOCUMENT_JOB_RUNTIME
  const secret = process.env.CRON_SECRET
  try {
    delete process.env.MCA_DOCUMENT_JOB_RUNTIME
    assert.deepEqual(await (await runDocumentsCron(new Request("https://fundlane.test/api/cron/documents"))).json(), { enabled: false })
    process.env.MCA_DOCUMENT_JOB_RUNTIME = "vercel_cron"
    delete process.env.CRON_SECRET
    assert.equal((await runDocumentsCron(new Request("https://fundlane.test/api/cron/documents"))).status, 503)
    process.env.CRON_SECRET = "synthetic-document-cron-secret"
    assert.equal((await runDocumentsCron(new Request("https://fundlane.test/api/cron/documents", { headers: { authorization: "Bearer wrong" } }))).status, 401)
  } finally {
    if (previous === undefined) delete process.env.MCA_DOCUMENT_JOB_RUNTIME; else process.env.MCA_DOCUMENT_JOB_RUNTIME = previous
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret
  }
})

test("document cron leaves native scanner jobs for the external executor", async () => {
  const previousRuntime = process.env.MCA_DOCUMENT_JOB_RUNTIME
  const previousScanner = process.env.MCA_DOCUMENT_SCANNER
  const previousSecret = process.env.CRON_SECRET
  try {
    process.env.MCA_DOCUMENT_JOB_RUNTIME = "vercel_cron"
    process.env.MCA_DOCUMENT_SCANNER = "clamscan"
    process.env.CRON_SECRET = "synthetic-document-cron-secret"
    const scanner = countingScanner()
    const document = await storeDocument(actor(), { dealId, idempotencyKey: "native-only-cron", filename: "native.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
    const response = await runDocumentsCron(new Request("https://fundlane.test/api/cron/documents", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).processed, 0)
    assert.equal(scanner.count(), 0)
    assert.equal((await getDocument(actor(), document.id)).processingState, "pending_scan")
    assert.equal(await runNextBackgroundJob(["document_scan"]), true)
    assert.equal((await getDocument(actor(), document.id)).processingState, "clean")
  } finally {
    setDocumentScannerForTests()
    if (previousRuntime === undefined) delete process.env.MCA_DOCUMENT_JOB_RUNTIME; else process.env.MCA_DOCUMENT_JOB_RUNTIME = previousRuntime
    if (previousScanner === undefined) delete process.env.MCA_DOCUMENT_SCANNER; else process.env.MCA_DOCUMENT_SCANNER = previousScanner
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret
  }
})

test("document cron retries scanner outage and refuses infected file without promotion", async () => {
  const previousRuntime = process.env.MCA_DOCUMENT_JOB_RUNTIME
  const previousScanner = process.env.MCA_DOCUMENT_SCANNER
  const previousSecret = process.env.CRON_SECRET
  process.env.MCA_DOCUMENT_JOB_RUNTIME = "vercel_cron"
  process.env.MCA_DOCUMENT_SCANNER = "cloudmersive"
  process.env.CRON_SECRET = "synthetic-document-cron-secret"
  const tick = () => runDocumentsCron(new Request("https://fundlane.test/api/cron/documents", { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }))
  try {
    setDocumentScannerForTests({ name: "outage", async scan() { return { status: "unavailable", provider: "outage", evidence: {} } } })
    const document = await storeDocument(actor(), { dealId, idempotencyKey: "cron-outage", filename: "outage.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
    assert.equal(document.processingState, "pending_scan")
    const response = await tick()
    assert.equal(response.status, 200)
    assert.equal((await response.json()).processed, 1)
    const first = await getDatabase().prepare<{ id: string; state: string; attempts: number; error_code: string }>("SELECT id,state,attempts,error_code FROM mca_background_jobs WHERE kind='document_scan' AND resource_id=?").get(document.id)
    assert.equal(first?.state, "queued")
    assert.equal(first?.error_code, "scanner_unavailable")
    await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", first!.id)
    setDocumentScannerForTests({ name: "infected-fixture", async scan() { return { status: "infected", provider: "infected-fixture", evidence: { engineVerified: true } } } })
    assert.equal((await tick()).status, 200)
    assert.equal((await getDocument(actor(), document.id)).processingState, "quarantined")
    const final = await getDatabase().prepare<{ id: string; state: string; attempts: number }>("SELECT id,state,attempts FROM mca_background_jobs WHERE kind='document_scan' AND resource_id=?").get(document.id)
    assert.deepEqual(final, { id: first!.id, state: "complete", attempts: 2 })
  } finally {
    setDocumentScannerForTests()
    if (previousRuntime === undefined) delete process.env.MCA_DOCUMENT_JOB_RUNTIME; else process.env.MCA_DOCUMENT_JOB_RUNTIME = previousRuntime
    if (previousScanner === undefined) delete process.env.MCA_DOCUMENT_SCANNER; else process.env.MCA_DOCUMENT_SCANNER = previousScanner
    if (previousSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousSecret
  }
})

test("document worker refuses a cross-workspace scan claim", async () => {
  await addWorkspace("workspace-jobs-other")
  const scanner = countingScanner()
  const document = await storeDocument(actor(), { dealId, idempotencyKey: "cross-workspace-scan", filename: "scoped.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
  const original = await getDatabase().prepare<{ id: string }>("SELECT id FROM mca_background_jobs WHERE kind='document_scan' AND resource_id=?").get(document.id)
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='failed',error_code='test_deferred' WHERE id=?").run(original!.id)
  const other = { ...actor(), workspaceId: "workspace-jobs-other" }
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_background_jobs
    (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'synthetic','queued',0,?,?,?)`).run("cross-workspace-scan-job", other.workspaceId, "document_scan", document.id, "cross-workspace-scan", JSON.stringify(other), "{}", now, now, now)
  assert.equal(await runNextBackgroundJob(["document_scan"]), true)
  const result = await getDatabase().prepare<{ state: string; error_code: string }>("SELECT state,error_code FROM mca_background_jobs WHERE id='cross-workspace-scan-job'").get()
  assert.deepEqual(result, { state: "failed", error_code: "document_not_found" })
  assert.equal(scanner.count(), 0)
  assert.equal((await getDocument(actor(), document.id)).processingState, "pending_scan")
})
