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
import { setSenderDeliveryFetchForTests } from "../src/lib/mca/senders/delivery"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { setEmailDeliveryFetchForTests, setSubmissionEmailProductionForTests } from "../src/lib/mca/submissions/email-templates"
import { assertProductionDeliveryNotPreview, processJobDelivery } from "../src/lib/mca/submissions/outbox"
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

test("processJobDelivery resumes a sending attempt, keeps one row, and marks outbox processed", async () => {
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

  const saved = await processJobDelivery(sending)

  assert.equal(saved.state, "sent")
  assert.equal(await attemptCount(saved.id), 1)
  const attempt = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_submission_attempts WHERE job_id = ?",
  ).get(saved.id)
  assert.equal(attempt?.state, "sent")
  assert.ok(await outboxProcessedAt(saved.id))
  assert.equal(deliveries, 1)
})

test("processJobDelivery marks sent, failed, or skipped attempts processed without a second row", async () => {
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

  const saved = await processJobDelivery(sending)

  assert.equal(await attemptCount(saved.id), 1)
  assert.ok(await outboxProcessedAt(saved.id))
  assert.equal(deliveries, 0)
  const attempt = await getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_submission_attempts WHERE job_id = ?",
  ).get(saved.id)
  assert.equal(attempt?.state, "sent")
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
