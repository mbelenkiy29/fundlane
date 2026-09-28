import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { AppError } from "../src/lib/mca/errors"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { storeDocument } from "../src/lib/mca/documents/service"
import { createFunder } from "../src/lib/mca/funders/directory"
import { upsertAdapterCredential } from "../src/lib/mca/submissions/adapters/credentials"
import { registerAdapter } from "../src/lib/mca/submissions/adapters/registry"
import { setSenderDeliveryFetchForTests } from "../src/lib/mca/senders/delivery"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { parseEmailAttemptRef, setEmailDeliveryFetchForTests, setSubmissionEmailProductionForTests } from "../src/lib/mca/submissions/email-templates"
import { assertProductionDeliveryNotPreview, processJobDelivery, reconcileUncertainEmailDelivery } from "../src/lib/mca/submissions/outbox"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import {
  findJobById,
  insertAttempt,
  persistNewDestination,
  updateJobRecord,
} from "../src/lib/mca/submissions/repository"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const previousJobs = process.env.MCA_BACKGROUND_JOBS
const previousVercel = process.env.VERCEL
const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL

delete process.env.MCA_DOCUMENT_SCANNER
delete process.env.MCA_BACKGROUND_JOBS
delete process.env.VERCEL

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let emailFunderId = ""
let dealCounter = 0
let deliveries = 0

const actor = (): DealActor => ({
  workspaceId: "workspace-outbox",
  userId: null,
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: "corr-outbox",
})

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) {
    if (memory.has(key)) throw new Error("duplicate storage key")
    memory.set(key, new Uint8Array(bytes))
  },
  async get(key) {
    const value = memory.get(key)
    if (!value) throw new Error("missing storage key")
    return new Uint8Array(value)
  },
}
const scanner: DocumentScanner = {
  name: "fixture-clean",
  async scan() {
    return { status: "clean", provider: "fixture-clean", evidence: { engineVerified: true } }
  },
}
const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(
    id,
    id,
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now,
    now,
  )
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `outbox-deal-${dealCounter}`,
    legalName: `Outbox Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `outbox-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return { deal, document }
}

async function persistQueuedJob(dealId: string, document: { id: string; checksum: string; category: string }, confirmationKey: string) {
  return (await persistNewDestination({
    workspaceId: actor().workspaceId,
    dealId,
    funderId: emailFunderId,
    displayFunderName: "Outbox Email Capital LLC",
    routeKind: "email",
    route: {
      id: "outbox-email-route",
      kind: "email",
      label: "Submissions",
      destination: "subs@outbox.example.test",
      documentExceptions: [],
      active: true,
    },
    state: "queued",
    confirmationKey,
    attemptKey: confirmationKey,
    dealVersion: 1,
    documentVersions: [{ documentId: document.id, checksum: document.checksum, category: document.category }],
    packageDocumentIds: [document.id],
    preflightErrors: [],
    merchantIdentityKey: `deal:${dealId}`,
    packageFingerprint: "",
    createdByUserId: null,
    actor: actor(),
  })).job
}

async function attemptCount(jobId: string) {
  const row = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_submission_attempts WHERE job_id = ?").get(jobId)
  return Number(row?.count ?? 0)
}

async function outboxProcessedAt(jobId: string) {
  const row = await getDatabase().prepare<{ processed_at: Date | string | null }>(
    "SELECT processed_at FROM mca_submission_outbox WHERE job_id = ?",
  ).get(jobId)
  return row?.processed_at ?? null
}

async function withCompletedAttemptRecovery<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const previous = process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED
  if (enabled) process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED = "true"
  else delete process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED
  try { return await run() }
  finally {
    if (previous === undefined) delete process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED
    else process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED = previous
  }
}

before(async () => {
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email.example.test/send"
  testDatabase = await createPostgresTestDatabase("submissions_outbox")
  Object.assign(process.env, testDatabase.env())
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setSubmissionCompletenessForTests(true)
  setSenderDeliveryFetchForTests(async () => new Response("accepted", { status: 202 }))
  setEmailDeliveryFetchForTests(async () => {
    deliveries += 1
    return new Response("accepted", { status: 202 })
  })
  await addWorkspace(actor().workspaceId)
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: "smtp-outbox-password" },
  })
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  emailFunderId = (await createFunder(actor(), {
    idempotencyKey: "outbox-email-funder",
    legalName: "Outbox Email Capital LLC",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@outbox.example.test", documentExceptions: [], active: true }],
  })).funder.id
})

after(async () => {
  setEmailDeliveryFetchForTests()
  setSubmissionEmailProductionForTests()
  setSenderDeliveryFetchForTests()
  setSubmissionCompletenessForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
  if (previousJobs === undefined) delete process.env.MCA_BACKGROUND_JOBS
  else process.env.MCA_BACKGROUND_JOBS = previousJobs
  if (previousVercel === undefined) delete process.env.VERCEL
  else process.env.VERCEL = previousVercel
  if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
  else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
})

test("processJobDelivery reconciles a sending attempt without repeating an ambiguous provider send", async () => {
  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-resume-sending")
  await insertAttempt({
    workspaceId: queued.workspaceId,
    jobId: queued.id,
    attemptKey: queued.attemptKey,
    transport: queued.routeKind,
    state: "sending",
    correlationId: newId(),
  })
  const sending = await updateJobRecord(queued.workspaceId, queued.id, { state: "sending" })
  deliveries = 0
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  const priorKinds = process.env.MCA_JOB_RUNTIME_KINDS
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  process.env.MCA_JOB_RUNTIME_KINDS = "submission_delivery"
  let saved: typeof sending
  try { saved = await processJobDelivery(sending) }
  finally {
    if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime
    if (priorKinds === undefined) delete process.env.MCA_JOB_RUNTIME_KINDS; else process.env.MCA_JOB_RUNTIME_KINDS = priorKinds
  }

  assert.equal(saved.state, "failed")
  assert.equal(await attemptCount(saved.id), 1)
  const attempt = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_submission_attempts WHERE job_id = ?",
  ).get(saved.id)
  assert.equal(attempt?.state, "failed")
  assert.ok(await outboxProcessedAt(saved.id))
  assert.equal(deliveries, 0)
})

test("unset kind list preserves legacy submission retry behavior", async () => {
  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-legacy-retry")
  await insertAttempt({ workspaceId: queued.workspaceId, jobId: queued.id, attemptKey: queued.attemptKey,
    transport: queued.routeKind, state: "sending", correlationId: newId() })
  const sending = await updateJobRecord(queued.workspaceId, queued.id, { state: "sending" })
  const priorRuntime = process.env.MCA_JOB_RUNTIME
  const priorKinds = process.env.MCA_JOB_RUNTIME_KINDS
  deliveries = 0
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  delete process.env.MCA_JOB_RUNTIME_KINDS
  let saved: typeof sending
  try { saved = await processJobDelivery(sending) }
  finally {
    if (priorRuntime === undefined) delete process.env.MCA_JOB_RUNTIME; else process.env.MCA_JOB_RUNTIME = priorRuntime
    if (priorKinds === undefined) delete process.env.MCA_JOB_RUNTIME_KINDS; else process.env.MCA_JOB_RUNTIME_KINDS = priorKinds
  }
  assert.equal(saved.state, "sent")
  assert.equal(deliveries, 1)
})

test("gated API recovery leaves an interrupted send uncertain without submitting twice", async () => {
  const previous = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
  try {
    const { deal } = await seedDeal()
    const job = (await persistNewDestination({
      workspaceId: actor().workspaceId,
      dealId: deal.id,
      funderId: emailFunderId,
      displayFunderName: "Controlled API fixture",
      routeKind: "api",
      route: { id: "controlled-api", kind: "api", label: "API", destination: "sandbox", documentExceptions: [], active: true },
      state: "queued",
      confirmationKey: "unknown-api-outcome",
      attemptKey: "unknown-api-outcome",
      dealVersion: 1,
      documentVersions: [],
      packageDocumentIds: [],
      preflightErrors: [],
      merchantIdentityKey: `deal:${deal.id}`,
      packageFingerprint: "",
      createdByUserId: null,
      actor: actor(),
    })).job
    await insertAttempt({ workspaceId: job.workspaceId, jobId: job.id, attemptKey: job.attemptKey, transport: "api", state: "sending", correlationId: newId() })
    await getDatabase().prepare("UPDATE mca_submission_attempts SET created_at = ? WHERE job_id = ?").run(new Date(Date.now() - 11 * 60_000).toISOString(), job.id)
    const sending = await updateJobRecord(job.workspaceId, job.id, { state: "sending" })
    const saved = await processJobDelivery(sending)
    assert.equal(saved.state, "failed")
    assert.match(saved.reason ?? "", /uncertain/)
    assert.equal(await attemptCount(job.id), 1)
    assert.ok(await outboxProcessedAt(job.id))
    const again = await processJobDelivery(saved)
    assert.equal(again.state, "failed")
    assert.equal(await attemptCount(job.id), 1)
  } finally {
    if (previous === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = previous
  }
})

test("gated concurrent API requests leave a live send intact and dispatch only once", async () => {
  const previous = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
  let releaseSend!: () => void
  let signalEntered!: () => void
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  const holdSend = new Promise<void>((resolve) => { releaseSend = resolve })
  let sends = 0
  registerAdapter({
    slug: "fixture-concurrent-outbox",
    readiness: "sandbox",
    capabilities: { submit: true, statusPoll: false, webhooks: false, offers: false },
    validate: () => ({ ok: true }),
    submit: async () => {
      sends += 1
      signalEntered()
      await holdSend
      return { ok: true, correlationId: "concurrent-outbox", externalRef: "controlled-receipt" }
    },
  })
  try {
    const { deal } = await seedDeal()
    const funderId = (await createFunder(actor(), {
      idempotencyKey: `concurrent-api-${deal.id}`,
      legalName: "Concurrent API Capital LLC",
      routes: [{ kind: "api", label: "Controlled", destination: "fixture-concurrent-outbox", documentExceptions: [], active: true }],
    })).funder.id
    await upsertAdapterCredential(actor(), { funderId, adapterSlug: "fixture-concurrent-outbox", environment: "development", secrets: { apiKey: "synthetic-only" } })
    const job = (await persistNewDestination({
      workspaceId: actor().workspaceId,
      dealId: deal.id,
      funderId,
      displayFunderName: "Concurrent API Capital LLC",
      routeKind: "api",
      route: { id: "concurrent-api", kind: "api", label: "Controlled", destination: "fixture-concurrent-outbox", documentExceptions: [], active: true },
      state: "queued",
      confirmationKey: `concurrent-api-${deal.id}`,
      attemptKey: `concurrent-api-${deal.id}`,
      dealVersion: 1,
      documentVersions: [],
      packageDocumentIds: [],
      preflightErrors: [],
      merchantIdentityKey: `deal:${deal.id}`,
      packageFingerprint: "",
      createdByUserId: null,
      actor: actor(),
    })).job
    const first = processJobDelivery(job)
    await entered
    const concurrent = await processJobDelivery(job)
    assert.equal(concurrent.state, "sending")
    assert.equal((await getDatabase().prepare<{ state: string }>("SELECT state FROM mca_submission_attempts WHERE job_id = ?").get(job.id))?.state, "sending")
    assert.equal(await outboxProcessedAt(job.id), null)
    releaseSend()
    assert.equal((await first).state, "sent")
    assert.equal(await attemptCount(job.id), 1)
    assert.equal(sends, 1)
  } finally {
    releaseSend()
    if (previous === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = previous
  }
})

test("uncertain email blocks repeat delivery and requires recorded operator reconciliation", async () => {
  const priorGuard = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
  let sends = 0
  let providerCorrelation = ""
  setEmailDeliveryFetchForTests(async (_input, init) => {
    sends += 1
    providerCorrelation = new Headers(init?.headers).get("x-correlation-id") ?? ""
    throw new DOMException("timeout", "TimeoutError")
  })
  try {
    const { deal, document } = await seedDeal()
    const job = await persistQueuedJob(deal.id, document, `uncertain-email-${deal.id}`)
    const failed = await processJobDelivery(job)
    assert.equal(failed.state, "failed")
    assert.equal((await getDatabase().prepare<{ error_code: string }>("SELECT error_code FROM mca_submission_attempts WHERE job_id = ?").get(job.id))?.error_code, "delivery_uncertain")
    assert.equal((await getDatabase().prepare<{ correlation_id: string }>("SELECT correlation_id FROM mca_submission_attempts WHERE job_id = ?").get(job.id))?.correlation_id, providerCorrelation)
    const uncertainRef = await getDatabase().prepare<{ external_ref: string }>("SELECT external_ref FROM mca_submission_attempts WHERE job_id = ?").get(job.id)
    assert.equal(parseEmailAttemptRef(uncertainRef?.external_ref)?.delivery, "uncertain")
    await Promise.all([processJobDelivery(job), processJobDelivery(job)])
    assert.equal(sends, 1)
    const blocked = await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [emailFunderId], confirmationKey: `repeat-email-${deal.id}` })
    assert.equal(blocked.jobs[0]?.state, "failed")
    assert.match(blocked.jobs[0]?.reason ?? "", /reconcile/i)
    await assert.rejects(() => reconcileUncertainEmailDelivery(actor(), job.id, { outcome: "accepted", evidence: "" }), { code: "validation_failed" })
    const accepted = await reconcileUncertainEmailDelivery(actor(), job.id, { outcome: "accepted", evidence: "receiver receipt fixture-1" })
    assert.equal(accepted.state, "sent")
    const acceptedRef = await getDatabase().prepare<{ external_ref: string }>("SELECT external_ref FROM mca_submission_attempts WHERE job_id = ?").get(job.id)
    assert.equal(parseEmailAttemptRef(acceptedRef?.external_ref)?.delivery, "sent")
    assert.equal(parseEmailAttemptRef(acceptedRef?.external_ref)?.messageId, parseEmailAttemptRef(uncertainRef?.external_ref)?.messageId)
    assert.equal(sends, 1)
    await assert.rejects(() => reconcileUncertainEmailDelivery(actor(), job.id, { outcome: "not_sent", evidence: "fixture" }), { code: "delivery_not_uncertain" })

    const other = await seedDeal()
    const second = await persistQueuedJob(other.deal.id, other.document, `uncertain-email-second-${other.deal.id}`)
    await processJobDelivery(second)
    assert.equal(sends, 2)
    const notSent = await reconcileUncertainEmailDelivery(actor(), second.id, { outcome: "not_sent", evidence: "receiver log confirms no acceptance" })
    assert.equal(notSent.state, "failed")
    assert.equal((await getDatabase().prepare<{ error_code: string }>("SELECT error_code FROM mca_submission_attempts WHERE job_id = ?").get(second.id))?.error_code, "delivery_not_sent")
    await getDatabase().prepare("UPDATE mca_submission_jobs SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * 60_000).toISOString(), second.id)
    setEmailDeliveryFetchForTests(async () => { sends += 1; return new Response("accepted", { status: 202 }) })
    const retry = await queueSubmissions({ actor: actor(), dealId: other.deal.id, funderIds: [emailFunderId], confirmationKey: `confirmed-not-sent-${other.deal.id}` })
    assert.equal(retry.jobs[0]?.state, "sent")
    assert.equal(sends, 3)
  } finally {
    if (priorGuard === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = priorGuard
    setEmailDeliveryFetchForTests(async () => { deliveries += 1; return new Response("accepted", { status: 202 }) })
  }
})

test("guarded concurrent email delivery does not call the relay twice", async () => {
  const priorGuard = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let sends = 0
  setEmailDeliveryFetchForTests(async () => { sends += 1; entered(); await held; return new Response("accepted", { status: 202 }) })
  try {
    const { deal, document } = await seedDeal()
    const job = await persistQueuedJob(deal.id, document, `concurrent-email-${deal.id}`)
    const first = processJobDelivery(job)
    await started
    const second = await processJobDelivery(job)
    assert.equal(second.state, "sending")
    const blocked = await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [emailFunderId], confirmationKey: `concurrent-email-repeat-${deal.id}` })
    assert.equal(blocked.jobs[0]?.state, "failed")
    assert.match(blocked.jobs[0]?.reason ?? "", /reconcile/i)
    release()
    assert.equal((await first).state, "sent")
    assert.equal(sends, 1)
  } finally {
    release()
    if (priorGuard === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = priorGuard
    setEmailDeliveryFetchForTests(async () => { deliveries += 1; return new Response("accepted", { status: 202 }) })
  }
})

test("completed attempt leaves job and cache unchanged with recovery unset", async () => {
  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-terminal-default")
  await insertAttempt({ workspaceId: queued.workspaceId, jobId: queued.id, attemptKey: queued.attemptKey, transport: queued.routeKind, state: "sent", correlationId: newId() })
  const sending = await updateJobRecord(queued.workspaceId, queued.id, { state: "sending" })
  deliveries = 0

  const saved = await withCompletedAttemptRecovery(false, () => processJobDelivery(sending))

  assert.equal(saved.state, "sending")
  assert.equal((await findJobById(queued.workspaceId, queued.id))?.state, "sending")
  const cache = await getDatabase().prepare<{ status: string }>("SELECT status FROM deal_submissions WHERE workspace_id = ? AND job_id = ?").get(queued.workspaceId, queued.id)
  assert.equal(cache?.status, "queued")
  assert.ok(await outboxProcessedAt(queued.id))
  assert.equal(await attemptCount(queued.id), 1)
  assert.equal(deliveries, 0)
})

test("completed attempt recovery restores sent job without a second delivery", async () => {
  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-terminal-sent")
  await insertAttempt({
    workspaceId: queued.workspaceId,
    jobId: queued.id,
    attemptKey: queued.attemptKey,
    transport: queued.routeKind,
    state: "sent",
    correlationId: newId(),
  })
  const sending = await updateJobRecord(queued.workspaceId, queued.id, { state: "sending" })
  deliveries = 0

  const saved = await withCompletedAttemptRecovery(true, () => processJobDelivery(sending))

  assert.equal(saved.state, "sent")
  assert.equal((await findJobById(queued.workspaceId, queued.id))?.state, "sent")
  assert.equal(await attemptCount(saved.id), 1)
  assert.ok(await outboxProcessedAt(saved.id))
  assert.equal(deliveries, 0)
  const attempt = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_submission_attempts WHERE job_id = ?",
  ).get(saved.id)
  assert.equal(attempt?.state, "sent")
  assert.equal((await processJobDelivery(saved)).state, "sent")
  assert.equal(deliveries, 0)
})

test("processJobDelivery restores a saved failed attempt without sending again", async () => {
  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-terminal-failed")
  await insertAttempt({
    workspaceId: queued.workspaceId,
    jobId: queued.id,
    attemptKey: queued.attemptKey,
    transport: queued.routeKind,
    state: "failed",
    correlationId: newId(),
    errorCode: "provider_rejected",
    errorMessage: "Provider rejected the delivery.",
  })
  const sending = await updateJobRecord(queued.workspaceId, queued.id, { state: "sending" })
  deliveries = 0

  const saved = await withCompletedAttemptRecovery(true, () => processJobDelivery(sending))

  assert.equal(saved.state, "failed")
  assert.equal(saved.reason, "Provider rejected the delivery.")
  assert.equal((await findJobById(queued.workspaceId, queued.id))?.state, "failed")
  assert.equal(await attemptCount(queued.id), 1)
  assert.ok(await outboxProcessedAt(queued.id))
  assert.equal(deliveries, 0)
})

test("queueSubmissions enqueues submission_delivery when background jobs are enabled", async () => {
  const { deal } = await seedDeal()
  process.env.MCA_BACKGROUND_JOBS = "enabled"
  try {
    const result = await queueSubmissions({
      actor: actor(),
      dealId: deal.id,
      funderIds: [emailFunderId],
      confirmationKey: "outbox-enqueue-jobs",
    })
    assert.equal(result.ok, true)
    assert.equal(result.jobs.length, 1)
    const queued = result.jobs[0]
    assert.ok(queued)
    assert.equal(queued.state, "queued")
    const job = await findJobById(actor().workspaceId, queued.jobId)
    assert.equal(job?.state, "queued")
    assert.equal(await attemptCount(queued.jobId), 0)
    assert.equal(await outboxProcessedAt(queued.jobId), null)
    const delivery = await getDatabase().prepare<{ kind: string; state: string; resource_id: string }>(
      "SELECT kind, state, resource_id FROM mca_background_jobs WHERE workspace_id = ? AND resource_id = ? AND kind = 'submission_delivery'",
    ).get(actor().workspaceId, queued.jobId)
    assert.equal(delivery?.kind, "submission_delivery")
    assert.equal(delivery?.resource_id, queued.jobId)
    assert.equal(delivery?.state, "queued")
  } finally {
    delete process.env.MCA_BACKGROUND_JOBS
  }
})

test("production preview_not_sent applies only to email preview refs", async () => {
  const previewRef = JSON.stringify({
    messageId: "<preview@submissions.mca.local>",
    threadId: "<preview@submissions.mca.local>",
    inReplyTo: null,
    references: ["<preview@submissions.mca.local>"],
    delivery: "preview",
    snapshot: {
      to: ["subs@outbox.example.test"],
      cc: [],
      replyTo: "broker@example.test",
      fromName: "Broker Desk",
      fromAddress: "broker@example.test",
      subject: "Preview",
      body: "Preview body",
      attachments: [],
      workspacePrefix: "",
      funderPrefix: "",
      signature: "",
      senderId: "sender-preview",
    },
  })
  const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setSubmissionEmailProductionForTests(true)
  try {
    assert.doesNotThrow(() => assertProductionDeliveryNotPreview({
      ok: true,
      state: "sent",
      correlationId: "corr-api",
      externalRef: "adapter-application-99",
    }))
    assert.throws(
      () => assertProductionDeliveryNotPreview({
        ok: true,
        state: "sent",
        correlationId: "corr-preview",
        externalRef: previewRef,
      }),
      (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "preview_not_sent",
    )
  } finally {
    setSubmissionEmailProductionForTests()
    if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
  }
})

test("production preview refs are not recorded as sent", async () => {
  const previewRef = JSON.stringify({
    messageId: "<preview@submissions.mca.local>",
    threadId: "<preview@submissions.mca.local>",
    inReplyTo: null,
    references: ["<preview@submissions.mca.local>"],
    delivery: "preview",
    snapshot: {
      to: ["subs@outbox.example.test"],
      cc: [],
      replyTo: "broker@example.test",
      fromName: "Broker Desk",
      fromAddress: "broker@example.test",
      subject: "Preview",
      body: "Preview body",
      attachments: [],
      workspacePrefix: "",
      funderPrefix: "",
      signature: "",
      senderId: "sender-preview",
    },
  })
  setSubmissionEmailProductionForTests(true)
  try {
    assert.throws(
      () => assertProductionDeliveryNotPreview({
        ok: true,
        state: "sent",
        correlationId: "corr-preview",
        externalRef: previewRef,
      }),
      (error: unknown) => error instanceof AppError && error.status === 409 && error.code === "preview_not_sent",
    )
    assert.doesNotThrow(() => assertProductionDeliveryNotPreview({
      ok: true,
      state: "sent",
      correlationId: "corr-sent",
      externalRef: previewRef.replace('"preview"', '"sent"'),
    }))
  } finally {
    setSubmissionEmailProductionForTests()
  }

  const { deal, document } = await seedDeal()
  const queued = await persistQueuedJob(deal.id, document, "outbox-prod-preview")
  const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setSubmissionEmailProductionForTests(true)
  try {
    const saved = await processJobDelivery(queued)
    assert.equal(saved.state, "failed")
    assert.notEqual(saved.state, "sent")
    const attempt = await getDatabase().prepare<{ state: string; error_code: string | null; external_ref: string | null }>(
      "SELECT state, error_code, external_ref FROM mca_submission_attempts WHERE job_id = ?",
    ).get(saved.id)
    assert.equal(attempt?.state, "failed")
    assert.ok(attempt?.error_code === "email_delivery_unconfigured" || attempt?.error_code === "preview_not_sent")
    assert.equal(attempt?.external_ref, null)
  } finally {
    setSubmissionEmailProductionForTests()
    if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
  }
})
