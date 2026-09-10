import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { createFunder } from "../src/lib/mca/funders/directory"
import { createSender, testSend } from "../src/lib/mca/senders/service"
import {
  DEFAULT_REMINDER_BODY,
  THREAD_FALLBACK_DISCLOSURE,
  setReminderDeliveryFetchForTests,
  setReminderTransportForTests,
  type ReminderDeliveryMessage,
} from "../src/lib/mca/comms/reminders"
import { parseEmailAttemptRef } from "../src/lib/mca/submissions/email-templates"
import { queueSubmissions } from "../src/lib/mca/submissions/queue"
import { insertJob } from "../src/lib/mca/submissions/repository"
import { setWebhookFetchForTests } from "../src/lib/mca/submissions/webhook"
import { GET as remindersGet, POST as remindersPost } from "../src/app/api/mca/comms/reminders/route"
import { POST as previewPost } from "../src/app/api/mca/comms/reminders/preview/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-reminder-password-never-leak"
const WEBHOOK_TOKEN = "hook-token-never-leak"
const ids = {
  workspace: "workspace-m06-reminders",
  otherWorkspace: "workspace-m06-reminders-other",
  adminUser: "remind-admin-user",
  adminMember: "remind-admin-member",
  repUser: "remind-rep-user",
  repMember: "remind-rep-member",
  otherUser: "remind-other-user",
  otherMember: "remind-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

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

let senderId = ""
let emailFunderId = ""
let apiFunderId = ""
let portalFunderId = ""
let webhookFunderId = ""
let dealCounter = 0
const delivered: ReminderDeliveryMessage[] = []
const webhookBodies: string[] = []

type JobView = {
  jobId: string
  routeKind: string
  eligible: boolean
  remindControl: string
  ineligibleReason?: string
  submissionState: string
  lastRemindedAt?: string
  lastReminderId?: string
  displayFunderName: string
}

type ListBody = { dealId: string; canSend: boolean; defaultBody: string; jobs: JobView[] }
type PreviewBody = {
  reminderId: string
  jobId: string
  submissionState: string
  sender: { fromName: string; fromAddress: string }
  to: string[]
  cc: string[]
  subject: string
  body: string
  thread: { mode: string; messageId?: string; threadId?: string; inReplyTo?: string; references: string[]; disclosure?: string }
  delivery: string
  lastRemindedAt?: string
}
type SendBody = {
  reminderId: string
  jobId: string
  submissionState: string
  state: string
  lastRemindedAt?: string
  delivery: string
  correlationId: string
  error?: string
  thread: { mode: string }
}
type ErrorBody = { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Reminders Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "remind-closer@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "remind-originator@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "remind-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("remind-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("remind-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("remind-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("remind-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("remind-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("remind-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("m06_reminders")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setWebhookFetchForTests(async () => new Response("accepted", { status: 202 }))
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    signature: "Best,\nBroker Desk",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: SMTP_PASSWORD },
  })
  senderId = sender.id
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  emailFunderId = (await createFunder(actor(), {
    idempotencyKey: "email-reminder-funder",
    legalName: "Email Capital LLC",
    nickname: "Email Cap",
    routes: [{ kind: "email", label: "Email inbox", destination: "funder@lenders.example.test", documentExceptions: [], active: true }],
  })).funder.id
  apiFunderId = (await createFunder(actor(), {
    idempotencyKey: "api-reminder-funder",
    legalName: "API Capital LLC",
    nickname: "API Cap",
    routes: [{ kind: "api", label: "ISO API", destination: "https://api.example.test/submit", documentExceptions: [], active: true }],
  })).funder.id
  portalFunderId = (await createFunder(actor(), {
    idempotencyKey: "portal-reminder-funder",
    legalName: "Portal Capital LLC",
    nickname: "Portal Cap",
    routes: [{ kind: "manual_portal", label: "ISO portal", destination: "https://portal.example.test/apply", documentExceptions: [], active: true }],
  })).funder.id
  webhookFunderId = (await createFunder(actor(), {
    idempotencyKey: "webhook-reminder-funder",
    legalName: "Webhook Capital LLC",
    nickname: "Hook Cap",
    routes: [{
      kind: "custom_webhook",
      label: "Submission hook",
      destination: `https://${WEBHOOK_TOKEN}@hooks.example.test/submit`,
      documentExceptions: [],
      active: true,
    }],
  })).funder.id
})

beforeEach(() => {
  delivered.length = 0
  webhookBodies.length = 0
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_TOKEN
  setReminderTransportForTests()
  setReminderDeliveryFetchForTests()
})

after(async () => {
  setReminderTransportForTests()
  setReminderDeliveryFetchForTests()
  setWebhookFetchForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes(WEBHOOK_TOKEN), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `remind-deal-${dealCounter}`,
    legalName: `Remind Merchant ${dealCounter} LLC`,
    requestedAmount: 80_000,
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `remind-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return deal
}

async function queueEmail(dealId: string) {
  const queued = await queueSubmissions({
    actor: actor(),
    dealId,
    funderIds: [emailFunderId],
    confirmationKey: `remind-email-${dealCounter}-${createHash("sha256").update(dealId).digest("hex").slice(0, 8)}`,
  })
  const job = queued.jobs[0]
  assert.ok(job)
  assert.equal(job.state, "sent")
  return job
}

async function queuePortalAndWebhook(dealId: string) {
  const portal = await queueSubmissions({
    actor: actor(),
    dealId,
    funderIds: [portalFunderId],
    confirmationKey: `remind-portal-${dealCounter}`,
  })
  const webhook = await queueSubmissions({
    actor: actor(),
    dealId,
    funderIds: [webhookFunderId],
    confirmationKey: `remind-webhook-${dealCounter}`,
  })
  return { portal: portal.jobs[0], webhook: webhook.jobs[0] }
}

async function insertApiJob(dealId: string) {
  const inserted = await insertJob({
    workspaceId: ids.workspace,
    dealId,
    funderId: apiFunderId,
    displayFunderName: "API Cap",
    routeKind: "api",
    route: {
      id: "api-route",
      kind: "api",
      label: "ISO API",
      destination: "https://api.example.test/submit",
      documentExceptions: [],
      active: true,
    },
    state: "sent",
    confirmationKey: `remind-api-${dealCounter}`,
    attemptKey: `remind-api-${dealCounter}`,
    dealVersion: 1,
    documentVersions: [],
    packageDocumentIds: [],
    preflightErrors: [],
    createdByUserId: ids.adminUser,
  })
  return inserted.job
}

async function jobState(jobId: string) {
  return getDatabase().prepare<{ state: string }>(
    "SELECT state FROM mca_submission_jobs WHERE workspace_id = ? AND id = ?",
  ).get(ids.workspace, jobId)
}

async function reminderRow(reminderId: string) {
  return getDatabase().prepare<{ state: string; last_reminded_at: string | null; correlation_id: string; job_id: string }>(
    "SELECT state, last_reminded_at, correlation_id, job_id FROM mca_funder_reminders WHERE workspace_id = ? AND id = ?",
  ).get(ids.workspace, reminderId)
}

async function attemptRef(jobId: string) {
  const row = await getDatabase().prepare<{ external_ref: string | null }>(
    "SELECT external_ref FROM mca_submission_attempts WHERE job_id = ? ORDER BY created_at DESC, id DESC",
  ).get(jobId)
  return parseEmailAttemptRef(row?.external_ref)
}

test("MIC-154: email reminder uses original thread, records delivery separately, and leaves submission status unchanged", async () => {
  const deal = await seedDeal()
  const job = await queueEmail(deal.id)
  const original = await attemptRef(job.jobId)
  assert.ok(original?.messageId)
  const beforeState = (await jobState(job.jobId))?.state
  assert.equal(beforeState, "sent")

  let sends = 0
  setReminderTransportForTests(async (message) => {
    sends += 1
    delivered.push(message)
    return { delivery: "sent" }
  })

  const listed = await remindersGet(cookieRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "admin-session-token"))
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as ListBody
  assert.equal(listBody.defaultBody, DEFAULT_REMINDER_BODY)
  const emailJob = listBody.jobs.find((item) => item.jobId === job.jobId)
  assert.ok(emailJob)
  assert.equal(emailJob.eligible, true)
  assert.equal(emailJob.remindControl, "remind")
  assert.equal(emailJob.submissionState, "sent")
  assertNoSecret(listBody)

  const preview = await previewPost(cookieRequest("/api/mca/comms/reminders/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(preview.status, 200)
  assert.equal(sends, 0)
  const previewBody = await preview.json() as PreviewBody
  assert.equal(previewBody.delivery, "preview")
  assert.equal(previewBody.body, DEFAULT_REMINDER_BODY)
  assert.deepEqual(previewBody.to, ["funder@lenders.example.test"])
  assert.equal(previewBody.sender.fromAddress, "broker@example.test")
  assert.equal(previewBody.sender.fromName, "Broker Desk")
  assert.equal(previewBody.thread.mode, "reply")
  assert.equal(previewBody.thread.inReplyTo, original.messageId)
  assert.equal(previewBody.thread.threadId, original.threadId)
  assert.equal(previewBody.thread.references.includes(original.messageId), true)
  assert.equal(previewBody.submissionState, "sent")
  assert.match(previewBody.subject, /^Re:/)
  assertNoSecret(previewBody)

  const edited = "Checking in on the package below — no new documents attached."
  const sent = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, reminderId: previewBody.reminderId, body: edited }),
  }))
  assert.equal(sent.status, 200)
  const sentBody = await sent.json() as SendBody
  assert.equal(sentBody.state, "sent")
  assert.equal(sentBody.delivery, "sent")
  assert.equal(sentBody.reminderId, previewBody.reminderId)
  assert.equal(sentBody.submissionState, "sent")
  assert.ok(sentBody.lastRemindedAt)
  assert.equal(sends, 1)
  assert.equal(delivered[0]?.body, edited)
  assert.equal(delivered[0]?.inReplyTo, original.messageId)
  assert.deepEqual(delivered[0]?.to, ["funder@lenders.example.test"])
  assert.equal(delivered[0]?.threadMode, "reply")
  assertNoSecret(delivered[0])
  assertNoSecret(sentBody)

  const stored = await reminderRow(sentBody.reminderId)
  assert.equal(stored?.state, "sent")
  assert.ok(stored?.last_reminded_at)
  assert.equal(stored?.correlation_id, sentBody.correlationId)
  assert.equal((await jobState(job.jobId))?.state, beforeState)

  const replay = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, reminderId: sentBody.reminderId, body: edited }),
  }))
  const replayBody = await replay.json() as SendBody
  assert.equal(replay.status, 200)
  assert.equal(replayBody.reminderId, sentBody.reminderId)
  assert.equal(sends, 1)
  assert.equal((await jobState(job.jobId))?.state, "sent")

  const relisted = await remindersGet(cookieRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "rep-session-token"))
  const relistBody = await relisted.json() as ListBody
  assert.equal(relistBody.jobs.find((item) => item.jobId === job.jobId)?.lastRemindedAt, stored?.last_reminded_at)
})

test("MIC-154: API/portal/webhook have no reminder control; failed send is not a reminder; missing thread headers are disclosed", async () => {
  const deal = await seedDeal()
  const emailJob = await queueEmail(deal.id)
  const apiJob = await insertApiJob(deal.id)
  const { portal, webhook } = await queuePortalAndWebhook(deal.id)
  assert.ok(portal)
  assert.ok(webhook)

  const listed = await remindersGet(cookieRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "admin-session-token"))
  const listBody = await listed.json() as ListBody
  const byId = new Map(listBody.jobs.map((item) => [item.jobId, item]))
  assert.equal(byId.get(emailJob.jobId)?.remindControl, "remind")
  for (const item of [byId.get(apiJob.id), byId.get(portal.jobId), byId.get(webhook.jobId)]) {
    assert.ok(item)
    assert.equal(item.eligible, false)
    assert.equal(item.remindControl, "hidden")
    assert.equal(item.ineligibleReason, "unsupported_transport")
  }

  for (const jobId of [apiJob.id, portal.jobId, webhook.jobId]) {
    const preview = await previewPost(cookieRequest("/api/mca/comms/reminders/preview", "admin-session-token", {
      method: "POST",
      body: JSON.stringify({ jobId }),
    }))
    assert.equal(preview.status, 409)
    assert.equal((await preview.json() as ErrorBody).error.code, "reminder_unsupported_transport")
    const send = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
      method: "POST",
      body: JSON.stringify({ jobId, body: DEFAULT_REMINDER_BODY }),
    }))
    assert.equal(send.status, 409)
    assert.equal((await send.json() as ErrorBody).error.code, "reminder_unsupported_transport")
    assert.equal((await jobState(jobId))?.state, byId.get(jobId)?.submissionState)
  }

  await getDatabase().prepare(
    "UPDATE mca_submission_attempts SET external_ref = NULL WHERE job_id = ?",
  ).run(emailJob.jobId)
  const fallbackPreview = await previewPost(cookieRequest("/api/mca/comms/reminders/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: emailJob.jobId }),
  }))
  assert.equal(fallbackPreview.status, 200)
  const fallbackBody = await fallbackPreview.json() as PreviewBody
  assert.equal(fallbackBody.thread.mode, "fallback")
  assert.equal(fallbackBody.thread.disclosure, THREAD_FALLBACK_DISCLOSURE)
  assert.deepEqual(fallbackBody.to, ["funder@lenders.example.test"])
  assert.equal(fallbackBody.sender.fromAddress, "broker@example.test")

  setReminderTransportForTests(async () => ({ delivery: "failed", error: "The email provider did not accept the reminder." }))
  const failed = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: emailJob.jobId, reminderId: fallbackBody.reminderId, body: DEFAULT_REMINDER_BODY }),
  }))
  assert.equal(failed.status, 200)
  const failedBody = await failed.json() as SendBody
  assert.equal(failedBody.state, "failed")
  assert.equal(failedBody.delivery, "failed")
  assert.equal(failedBody.lastRemindedAt, undefined)
  assert.equal(failedBody.reminderId, fallbackBody.reminderId)
  const failedRow = await reminderRow(failedBody.reminderId)
  assert.equal(failedRow?.state, "failed")
  assert.equal(failedRow?.last_reminded_at, null)
  assert.equal((await jobState(emailJob.jobId))?.state, "sent")

  setReminderTransportForTests(async (message) => {
    delivered.push(message)
    return { delivery: "sent" }
  })
  const retried = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: emailJob.jobId, reminderId: failedBody.reminderId, body: DEFAULT_REMINDER_BODY }),
  }))
  const retriedBody = await retried.json() as SendBody
  assert.equal(retriedBody.reminderId, failedBody.reminderId)
  assert.equal(retriedBody.state, "sent")
  assert.ok(retriedBody.lastRemindedAt)
  assert.equal(delivered[0]?.threadMode, "fallback")
  assert.equal(delivered[0]?.inReplyTo, undefined)

  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO mca_funder_replies
    (id, workspace_id, sender_id, provider_message_id, thread_id, from_address, subject, body_cipher,
     matched_deal_id, matched_job_id, match_evidence, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 'matched', ?, ?)`).run(
    `reply-${dealCounter}`,
    ids.workspace,
    senderId,
    `provider-reply-${dealCounter}`,
    "funder@lenders.example.test",
    "Re: submission",
    deal.id,
    emailJob.jobId,
    JSON.stringify({ method: "thread", flagsUnchanged: true, notes: ["fixture"] }),
    now,
    now,
  )
  const blocked = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: emailJob.jobId, body: DEFAULT_REMINDER_BODY }),
  }))
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json() as ErrorBody).error.code, "reminder_already_responded")
  const blockedList = await remindersGet(cookieRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "admin-session-token"))
  const blockedJob = ((await blockedList.json()) as ListBody).jobs.find((item) => item.jobId === emailJob.jobId)
  assert.equal(blockedJob?.eligible, false)
  assert.equal(blockedJob?.remindControl, "hidden")
  assert.equal(blockedJob?.ineligibleReason, "has_response")
  assert.equal((await jobState(emailJob.jobId))?.state, "sent")
})

test("MIC-154: API permissions match the UI, validation and loading states are usable, and secrets stay out of JSON", async () => {
  const deal = await seedDeal()
  const job = await queueEmail(deal.id)
  const source = readFileSync(resolve(process.cwd(), "src/components/mca/comms/remind-funder.tsx"), "utf8")
  assert.match(source, /Loading funder reminders/)
  assert.match(source, /No unanswered email submissions are ready to remind/)
  assert.match(source, /Enter reminder text/)
  assert.match(source, /Reminder sent\. Submission status is unchanged/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Remind Funder/)
  assert.match(source, /job\.eligible && job\.remindControl === "remind"/)
  assert.match(source, /API, portal, and webhook jobs have no reminder control/)

  const missingDeal = await remindersGet(cookieRequest("/api/mca/comms/reminders", "admin-session-token"))
  assert.equal(missingDeal.status, 422)

  const invalidJson = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: "{",
  }))
  assert.equal(invalidJson.status, 400)

  const blank = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, body: "   " }),
  }))
  assert.equal(blank.status, 422)
  assert.equal((await blank.json() as ErrorBody).error.fieldErrors?.body?.[0], "Enter reminder text.")

  const intakeGet = await remindersGet(bearerRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "intake-secret"))
  assert.equal(intakeGet.status, 403)
  const intakeSend = await remindersPost(bearerRequest("/api/mca/comms/reminders", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, body: DEFAULT_REMINDER_BODY }),
  }))
  assert.equal(intakeSend.status, 403)

  const readList = await remindersGet(bearerRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "read-secret"))
  assert.equal(readList.status, 200)
  const readPreview = await previewPost(bearerRequest("/api/mca/comms/reminders/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(readPreview.status, 200)
  const readSend = await remindersPost(bearerRequest("/api/mca/comms/reminders", "read-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, body: DEFAULT_REMINDER_BODY }),
  }))
  assert.equal(readSend.status, 403)

  const writeList = await remindersGet(bearerRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "write-secret"))
  assert.equal(writeList.status, 403)
  const writeSend = await remindersPost(bearerRequest("/api/mca/comms/reminders", "write-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId, body: DEFAULT_REMINDER_BODY }),
  }))
  assert.equal(writeSend.status, 200)
  const writeBody = await writeSend.json() as SendBody
  assert.equal(writeBody.state, "sent")
  assert.ok(writeBody.lastRemindedAt)
  assertNoSecret(writeBody)
  assert.equal((await jobState(job.jobId))?.state, "sent")

  const cross = await remindersGet(cookieRequest(`/api/mca/comms/reminders?dealId=${deal.id}`, "other-session-token"))
  assert.equal(cross.status, 404)

  const fresh = await seedDeal()
  const freshJob = await queueEmail(fresh.id)
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email-webhook.example.test/send"
  process.env.MCA_EMAIL_WEBHOOK_TOKEN = "webhook-auth-never-leak"
  setReminderDeliveryFetchForTests(async (_input, init) => {
    webhookBodies.push(typeof init?.body === "string" ? init.body : "")
    return new Response("accepted", { status: 202 })
  })
  const hooked = await remindersPost(cookieRequest("/api/mca/comms/reminders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: freshJob.jobId, body: DEFAULT_REMINDER_BODY }),
  }))
  const hookedBody = await hooked.json() as SendBody
  assert.equal(hooked.status, 200)
  assert.equal(hookedBody.state, "sent")
  assert.equal(webhookBodies.length, 1)
  assertNoSecret(webhookBodies[0])
  assert.equal(webhookBodies[0]?.includes("webhook-auth-never-leak"), false)
  assert.equal(webhookBodies[0]?.includes("funder_reminder"), true)
  assert.equal((await jobState(freshJob.jobId))?.state, "sent")
})
