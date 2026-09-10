import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
import type { AdapterStatusResult, FunderAdapter, SubmissionJob } from "../src/lib/mca/submissions/contracts"
import { registerAdapter } from "../src/lib/mca/submissions/adapters/registry"
import {
  requireAdapterRuntime,
  setAdapterEnvironmentForTests,
  upsertAdapterCredential,
} from "../src/lib/mca/submissions/adapters/credentials"
import { queueSubmissions } from "../src/lib/mca/submissions/queue"
import { WEBHOOK_SECRET_HEADER } from "../src/lib/mca/submissions/webhooks"
import { POST as webhookPost } from "../src/app/api/mca/submissions/webhooks/[slug]/route"
import { GET as refreshGet, POST as refreshPost } from "../src/app/api/mca/submissions/webhooks/refresh/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const API_SECRET = "status-adapter-api-secret-never-leak"
const WEBHOOK_SECRET = "status-adapter-webhook-secret-never-leak"
const SUBMIT_SECRET = "submit-only-adapter-secret-never-leak"
const STATUS_SLUG = "fixture-mic113-status"
const SUBMIT_SLUG = "fixture-mic113-submit"

const ids = {
  workspace: "workspace-status",
  otherWorkspace: "workspace-status-other",
  adminUser: "status-admin-user",
  adminMember: "status-admin-member",
  repUser: "status-rep-user",
  repMember: "status-rep-member",
  otherUser: "status-other-user",
  otherMember: "status-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: [membershipId],
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
const pdfChecksum = createHash("sha256").update(minimalPdf).digest("hex")

const statusQueue: AdapterStatusResult[] = []
let statusFunderId = ""
let submitFunderId = ""
let dealCounter = 0

const statusAdapter: FunderAdapter = {
  slug: STATUS_SLUG,
  capabilities: { submit: true, statusPoll: true, webhooks: true, offers: true },
  validate: () => ({ ok: true }),
  submit: async (job: SubmissionJob) => {
    const runtime = requireAdapterRuntime()
    return {
      ok: true,
      correlationId: runtime.correlationId,
      externalRef: `ext-${job.attemptKey}`,
      rawStatus: "accepted",
    }
  },
  getStatus: async () => {
    const runtime = requireAdapterRuntime()
    const next = statusQueue.shift()
    return {
      rawStatus: next?.rawStatus ?? "pending",
      normalized: next?.normalized,
      terms: next?.terms,
      eventId: next?.eventId,
      correlationId: runtime.correlationId,
      unknown: next?.unknown ?? false,
    }
  },
  parseWebhook: async (_headers, body) => {
    const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}
    const terms = payload.terms && typeof payload.terms === "object" && !Array.isArray(payload.terms)
      ? payload.terms as AdapterStatusResult["terms"]
      : undefined
    return {
      rawStatus: String(payload.status ?? payload.rawStatus ?? ""),
      terms,
      correlationId: String(payload.correlationId ?? "webhook-corr"),
      eventId: typeof payload.eventId === "string" ? payload.eventId : undefined,
      unknown: payload.unknown === true,
    }
  },
}

const submitOnly: FunderAdapter = {
  slug: SUBMIT_SLUG,
  capabilities: { submit: true, statusPoll: false, webhooks: false, offers: false },
  validate: () => ({ ok: true }),
  submit: async (job: SubmissionJob) => {
    const runtime = requireAdapterRuntime()
    return {
      ok: true,
      correlationId: runtime.correlationId,
      externalRef: `ext-${job.attemptKey}`,
      rawStatus: "accepted",
    }
  },
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Status Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "status-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "status-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "status-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("status-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("status-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("status-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("status-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("status-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("status-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_status")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  registerAdapter(statusAdapter)
  registerAdapter(submitOnly)
  await seed()
  statusFunderId = (await createFunder(actor(), {
    idempotencyKey: "status-funder",
    legalName: "Status Poll Capital LLC",
    nickname: "Status Poll",
    routes: [{ kind: "api", label: "API", destination: STATUS_SLUG, documentExceptions: [], active: true }],
  })).funder.id
  submitFunderId = (await createFunder(actor(), {
    idempotencyKey: "submit-only-funder",
    legalName: "Submit Only Status LLC",
    nickname: "Submit Only",
    routes: [{ kind: "api", label: "API", destination: SUBMIT_SLUG, documentExceptions: [], active: true }],
  })).funder.id
  await upsertAdapterCredential(actor(), {
    funderId: statusFunderId,
    adapterSlug: STATUS_SLUG,
    environment: "development",
    secrets: { apiKey: API_SECRET, webhookSecret: WEBHOOK_SECRET, baseUrl: "https://sandbox.status-adapter.test" },
  })
  await upsertAdapterCredential(actor(), {
    funderId: submitFunderId,
    adapterSlug: SUBMIT_SLUG,
    environment: "development",
    secrets: { apiKey: SUBMIT_SECRET, baseUrl: "https://sandbox.submit-adapter.test" },
  })
})

beforeEach(() => {
  statusQueue.length = 0
  setAdapterEnvironmentForTests("development")
})

after(async () => {
  setAdapterEnvironmentForTests()
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

function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(API_SECRET), false)
  assert.equal(text.includes(WEBHOOK_SECRET), false)
  assert.equal(text.includes(SUBMIT_SECRET), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `status-deal-${dealCounter}`,
    legalName: `Status Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `status-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return { deal, document }
}

async function submitJob(funderId: string) {
  const { deal, document } = await seedDeal()
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [funderId],
    confirmationKey: `status-confirm-${dealCounter}`,
  })
  const job = queued.jobs[0]
  assert.ok(job)
  assert.equal(job.state, "sent")
  assert.equal(document.checksum, pdfChecksum)
  return { deal, job }
}

async function offerRows(dealId: string) {
  return getDatabase().prepare<{
    id: string
    status: string
    amount: number | null
    raw_status: string | null
    source: string | null
    terms_unknown: number | string
  }>("SELECT id, status, amount, raw_status, source, terms_unknown FROM deal_offers WHERE deal_id = ? ORDER BY id").all(dealId)
}

async function submissionRow(jobId: string) {
  return getDatabase().prepare<{ status: string }>("SELECT status FROM deal_submissions WHERE job_id = ?").get(jobId)
}

async function postWebhook(jobId: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const body = JSON.stringify({ jobId, ...payload })
  return webhookPost(new Request(`http://localhost/api/mca/submissions/webhooks/${STATUS_SLUG}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET,
      ...headers,
    },
    body,
  }), slugParams(STATUS_SLUG))
}

const fundedTerms = { amount: 25000, rate: 1.29, term: 12, frequency: "daily", commission: 8 }
const pendingTerms = { amount: 10000, rate: 1.49, term: 6, frequency: "weekly", commission: 5 }

test("MIC-113: replayed webhook does not duplicate offers", async () => {
  const { deal, job } = await submitJob(statusFunderId)
  const first = await postWebhook(job.jobId, {
    eventId: "evt-replay-1",
    status: "approved",
    terms: fundedTerms,
  })
  assert.equal(first.status, 200)
  const firstBody = await first.json() as { duplicate: boolean; offer?: { id: string; status: string }; rawStatus: string }
  assertNoSecret(firstBody)
  assert.equal(firstBody.duplicate, false)
  assert.ok(firstBody.offer?.id)
  assert.equal(firstBody.offer?.status, "presented")
  assert.equal(firstBody.rawStatus, "approved")

  const replay = await postWebhook(job.jobId, {
    eventId: "evt-replay-1",
    status: "approved",
    terms: { ...fundedTerms, amount: 99 },
  })
  assert.equal(replay.status, 200)
  const replayBody = await replay.json() as { duplicate: boolean; offer?: { id: string; status: string; amount?: number } }
  assertNoSecret(replayBody)
  assert.equal(replayBody.duplicate, true)
  assert.equal(replayBody.offer?.id, firstBody.offer?.id)
  assert.equal(replayBody.offer?.status, "presented")

  const rows = await offerRows(deal.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, firstBody.offer?.id)
  assert.equal(Number(rows[0]?.amount), 25000)
  assert.equal(rows[0]?.source, "api")
  assert.equal(rows[0]?.raw_status, "approved")
})

test("MIC-113: out-of-order pending does not regress funded or duplicate offers", async () => {
  const { deal, job } = await submitJob(statusFunderId)
  const funded = await postWebhook(job.jobId, {
    eventId: "evt-funded-later",
    status: "funded",
    terms: fundedTerms,
  })
  assert.equal(funded.status, 200)
  const fundedBody = await funded.json() as { ignored: boolean; offer?: { id: string; status: string }; normalized: string }
  assertNoSecret(fundedBody)
  assert.equal(fundedBody.ignored, false)
  assert.equal(fundedBody.normalized, "funded")
  assert.equal(fundedBody.offer?.status, "accepted")

  const stale = await postWebhook(job.jobId, {
    eventId: "evt-pending-earlier",
    status: "pending",
    terms: pendingTerms,
  })
  assert.equal(stale.status, 200)
  const staleBody = await stale.json() as { ignored: boolean; ignoredReason?: string; offer?: { id: string; status: string; amount?: number } }
  assertNoSecret(staleBody)
  assert.equal(staleBody.ignored, true)
  assert.equal(staleBody.ignoredReason, "funded_terminal")
  assert.equal(staleBody.offer?.id, fundedBody.offer?.id)
  assert.equal(staleBody.offer?.status, "accepted")
  assert.equal(staleBody.offer?.amount, 25000)

  const rows = await offerRows(deal.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.status, "accepted")
  assert.equal(Number(rows[0]?.amount), 25000)
  assert.equal(rows[0]?.raw_status, "funded")
  const cache = await submissionRow(job.jobId)
  assert.equal(cache?.status, "approved")
})

test("MIC-113: unknown status remains visible with the original value and does not invent terms", async () => {
  const { deal, job } = await submitJob(statusFunderId)
  const webhook = await postWebhook(job.jobId, {
    eventId: "evt-unknown-hold",
    status: "CREDIT_COMMITTEE_HOLD",
  })
  assert.equal(webhook.status, 200)
  const body = await webhook.json() as { unknown: boolean; rawStatus: string; normalized: string; offer?: unknown }
  assertNoSecret(body)
  assert.equal(body.unknown, true)
  assert.equal(body.rawStatus, "CREDIT_COMMITTEE_HOLD")
  assert.equal(body.normalized, "unknown")
  assert.equal(body.offer, undefined)
  assert.equal((await offerRows(deal.id)).length, 0)
  assert.equal((await submissionRow(job.jobId))?.status, "CREDIT_COMMITTEE_HOLD")

  statusQueue.push({
    rawStatus: "AWAITING_BANK_VERIFICATION",
    correlationId: "poll",
    unknown: true,
  })
  const polled = await refreshPost(cookieRequest("/api/mca/submissions/webhooks/refresh", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(polled.status, 200)
  const polledBody = await polled.json() as { unknown: boolean; rawStatus: string; offer?: unknown }
  assertNoSecret(polledBody)
  assert.equal(polledBody.unknown, true)
  assert.equal(polledBody.rawStatus, "AWAITING_BANK_VERIFICATION")
  assert.equal(polledBody.offer, undefined)
  assert.equal((await offerRows(deal.id)).length, 0)
  assert.equal((await submissionRow(job.jobId))?.status, "AWAITING_BANK_VERIFICATION")
})

test("MIC-113: submit-only adapter poll is 409; empty, validation, permissions, and secrets", async () => {
  const emptyDeal = (await createDeal(actor(), {
    idempotencyKey: `status-empty-${Date.now()}`,
    legalName: "Empty Status Merchant LLC",
  })).deal
  const empty = await refreshGet(cookieRequest(`/api/mca/submissions/webhooks/refresh?dealId=${emptyDeal.id}`, "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { state: string; jobs: unknown[]; offers: unknown[]; message?: string }
  assert.equal(emptyBody.state, "empty")
  assert.equal(emptyBody.jobs.length, 0)
  assert.equal(emptyBody.offers.length, 0)

  const missing = await refreshGet(cookieRequest("/api/mca/submissions/webhooks/refresh", "admin-session-token"))
  assert.equal(missing.status, 422)
  const missingBody = await missing.json() as { error: { fieldErrors?: { dealId?: string[] } } }
  assert.ok(missingBody.error.fieldErrors?.dealId?.length)

  const invalid = await refreshPost(cookieRequest("/api/mca/submissions/webhooks/refresh", "admin-session-token", {
    method: "POST",
    body: "{",
  }))
  assert.equal(invalid.status, 400)

  const { job } = await submitJob(submitFunderId)
  const poll = await refreshPost(cookieRequest("/api/mca/submissions/webhooks/refresh", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(poll.status, 409)
  const pollBody = await poll.json() as { error: { code: string; message: string } }
  assert.equal(pollBody.error.code, "capability_unsupported")
  assert.match(pollBody.error.message, /cannot check status/i)
  assertNoSecret(pollBody)

  const intake = await refreshPost(bearerRequest("/api/mca/submissions/webhooks/refresh", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(intake.status, 403)

  const readWrite = await refreshPost(bearerRequest("/api/mca/submissions/webhooks/refresh", "read-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: job.jobId }),
  }))
  assert.equal(readWrite.status, 403)

  const readGet = await refreshGet(bearerRequest(`/api/mca/submissions/webhooks/refresh?dealId=${emptyDeal.id}`, "read-secret"))
  assert.equal(readGet.status, 200)

  const forged = await refreshGet(cookieRequest(`/api/mca/submissions/webhooks/refresh?dealId=${emptyDeal.id}`, "other-session-token"))
  assert.equal(forged.status, 404)

  const unauthenticated = await webhookPost(new Request(`http://localhost/api/mca/submissions/webhooks/${STATUS_SLUG}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.jobId, eventId: "evt-no-secret", status: "funded", terms: fundedTerms }),
  }), slugParams(STATUS_SLUG))
  assert.equal(unauthenticated.status, 401)
  const unauthBody = await unauthenticated.json() as { error: { code: string } }
  assert.equal(unauthBody.error.code, "webhook_unauthenticated")
  assertNoSecret(unauthBody)
})
