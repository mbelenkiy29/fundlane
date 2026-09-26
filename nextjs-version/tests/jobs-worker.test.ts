import test, { after, before } from "node:test"
import assert from "node:assert/strict"
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
import { createExportJob } from "../src/lib/mca/exports/service"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { persistNewDestination } from "../src/lib/mca/submissions/repository"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_EMAIL_WEBHOOK_URL
const previousJobs = process.env.MCA_BACKGROUND_JOBS
const previousVercel = process.env.VERCEL
const previousPoolMax = process.env.MCA_DB_POOL_MAX
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
  const completed = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'",
  ).get(actor().workspaceId, stored.id)
  assert.equal(completed?.state, "complete")

  const scanner = countingScanner()
  const retried = await retryDocumentScan(actor(), stored.id)
  assert.equal(retried.processingState, "pending_scan")
  assert.equal(scanner.count(), 0)
  const requeued = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan' AND state IN ('queued','running')",
  ).get(actor().workspaceId, stored.id)
  assert.equal(requeued?.state, "queued")
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
  const enqueued = await getDatabase().prepare<{ state: string; actor_json: string }>(
    "SELECT state, actor_json FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'document_scan'",
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
  t.diagnostic(JSON.stringify({ bytes: bytes.byteLength, durationMs: Math.round(performance.now() - started), firstJobId: first!.id, retryJobId: final.id, privateStorage: true, externalSends: 0 }))
})
