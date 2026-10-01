import "./helpers/business-auth"
import { queueWithSyntheticApproval as queueSubmissions, syntheticApprovedJob } from "./helpers/broker-submission-preview"
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
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
import { setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import {
  WEBHOOK_SECRET_HEADER,
} from "../src/lib/mca/submissions/webhooks"
import {
  deliverWebhook,
  setWebhookFetchForTests,
  setWebhookLookupForTests,
} from "../src/lib/mca/submissions/webhook"
import { POST as webhookPost } from "../src/app/api/mca/submissions/webhooks/[slug]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const WEBHOOK_SECRET = "ssrf-adapter-webhook-secret-never-leak"
const API_SECRET = "ssrf-adapter-api-secret-never-leak"
const STATUS_SLUG = "fixture-ssrf-status"

const ids = {
  workspace: "workspace-webhooks-ssrf",
  adminUser: "ssrf-admin-user",
  adminMember: "ssrf-admin-member",
}

const actor = (role: Role | null = "admin"): DealActor => ({
  workspaceId: ids.workspace,
  userId: ids.adminUser,
  membershipId: ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [ids.adminMember],
  source: role ? "user" : "api_key",
  correlationId: `corr-ssrf-${role ?? "key"}`,
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

let statusFunderId = ""
let dealCounter = 0
const lookupCalls: string[] = []
const fetchCalls: string[] = []

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
    return {
      rawStatus: "pending",
      correlationId: runtime.correlationId,
      unknown: false,
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

function webhookJob(destination: string): SubmissionJob {
  return {
    id: "job-webhook-ssrf",
    workspaceId: ids.workspace,
    dealId: "deal-webhook-ssrf",
    funderId: "funder-webhook-ssrf",
    displayFunderName: "SSRF Hook Funder",
    routeKind: "custom_webhook",
    route: {
      id: "route-webhook-ssrf",
      kind: "custom_webhook",
      label: "Hook",
      destination,
      documentExceptions: [],
      active: true,
    },
    state: "sending",
    confirmationKey: "conf-ssrf",
    attemptKey: "attempt-ssrf",
    dealVersion: 1,
    documentVersions: [],
    packageDocumentIds: [],
    preflightErrors: [],
    merchantIdentityKey: "deal:deal-webhook-ssrf",
    packageFingerprint: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(ids.workspace, "Webhook SSRF", flags, visibility, actions, now, now)
  await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(ids.adminUser, "ssrf-admin@example.test", "SSRF Admin", "APP-ssrf01", now, now)
  await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES (?, ?, ?, 'admin', NULL, 'active', NULL, ?, ?)`).run(ids.adminMember, ids.workspace, ids.adminUser, now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("ssrf-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_webhooks_ssrf")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setSubmissionCompletenessForTests(true)
  registerAdapter(statusAdapter)
  await seed()
  statusFunderId = (await createFunder(actor(), {
    idempotencyKey: "ssrf-status-funder",
    legalName: "SSRF Status Capital LLC",
    nickname: "SSRF Status",
    routes: [{ kind: "api", label: "API", destination: STATUS_SLUG, documentExceptions: [], active: true }],
  })).funder.id
  await upsertAdapterCredential(actor(), {
    funderId: statusFunderId,
    adapterSlug: STATUS_SLUG,
    environment: "development",
    secrets: { apiKey: API_SECRET, webhookSecret: WEBHOOK_SECRET, baseUrl: "https://sandbox.ssrf-adapter.test" },
  })
  setAdapterEnvironmentForTests("development")
})

beforeEach(() => {
  lookupCalls.length = 0
  fetchCalls.length = 0
  setWebhookFetchForTests()
  setWebhookLookupForTests()
})

after(async () => {
  setWebhookFetchForTests()
  setWebhookLookupForTests()
  setSubmissionCompletenessForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  setAdapterEnvironmentForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

function slugParams(slug: string) {
  return { params: Promise.resolve({ slug }) }
}

async function submitJob() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `ssrf-deal-${dealCounter}`,
    legalName: `SSRF Merchant ${dealCounter} LLC`,
  })).deal
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `ssrf-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [statusFunderId],
    confirmationKey: `ssrf-confirm-${dealCounter}`,
  })
  const job = queued.jobs[0]
  assert.ok(job)
  assert.equal(job.state, "sent")
  return job
}

async function postWebhook(jobId: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ jobId, ...payload })
  return webhookPost(new Request(`http://localhost/api/mca/submissions/webhooks/${STATUS_SLUG}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET,
    },
    body,
  }), slugParams(STATUS_SLUG))
}

test("missing eventId and event_id returns 422 webhook_event_id_required", async () => {
  const job = await submitJob()
  const response = await postWebhook(job.jobId, { status: "approved" })
  assert.equal(response.status, 422)
  const body = await response.json() as { error: { code: string } }
  assert.equal(body.error.code, "webhook_event_id_required")
})

test("reference alone is not accepted as eventId", async () => {
  const job = await submitJob()
  const response = await postWebhook(job.jobId, {
    reference: "ref-not-an-event",
    status: "approved",
    terms: { amount: 10000, rate: 1.2, term: 6, frequency: "daily", commission: 5 },
  })
  assert.equal(response.status, 422)
  const body = await response.json() as { error: { code: string } }
  assert.equal(body.error.code, "webhook_event_id_required")
})

test("event_id is accepted for webhook idempotency", async () => {
  const job = await submitJob()
  const first = await postWebhook(job.jobId, {
    event_id: "evt-snake-1",
    status: "approved",
    terms: { amount: 12000, rate: 1.25, term: 8, frequency: "daily", commission: 6 },
  })
  assert.equal(first.status, 200)
  const firstBody = await first.json() as { duplicate: boolean }
  assert.equal(firstBody.duplicate, false)

  const replay = await postWebhook(job.jobId, {
    event_id: "evt-snake-1",
    status: "approved",
    terms: { amount: 1, rate: 1.25, term: 8, frequency: "daily", commission: 6 },
  })
  assert.equal(replay.status, 200)
  const replayBody = await replay.json() as { duplicate: boolean }
  assert.equal(replayBody.duplicate, true)
})

test("deliverWebhook blocks RFC1918 / loopback / link-local / CGNAT / IPv6 ULA DNS answers before fetch", async () => {
  setWebhookLookupForTests(async (hostname) => {
    lookupCalls.push(hostname)
    if (hostname === "private.example.test") return [{ address: "10.0.0.8", family: 4 }]
    if (hostname === "loopback.example.test") return [{ address: "127.0.0.1", family: 4 }]
    if (hostname === "linklocal.example.test") return [{ address: "169.254.10.10", family: 4 }]
    if (hostname === "cgnat.example.test") return [{ address: "100.64.1.1", family: 4 }]
    if (hostname === "ula.example.test") return [{ address: "fd00::1", family: 6 }]
    if (hostname === "public.example.test") return [{ address: "203.0.113.10", family: 4 }]
    throw new Error(`unexpected lookup: ${hostname}`)
  })
  setWebhookFetchForTests(async (input) => {
    fetchCalls.push(String(input))
    return new Response("ok", { status: 200 })
  })

  for (const host of [
    "private.example.test",
    "loopback.example.test",
    "linklocal.example.test",
    "cgnat.example.test",
    "ula.example.test",
  ]) {
    const result = await deliverWebhook(webhookJob(`https://token@${host}/hook`))
    assert.equal(result.ok, false, host)
    assert.equal(result.errorCode, "provider_unavailable", host)
    assert.match(result.errorMessage ?? "", /private-network|not allowed/i, host)
    assert.equal(lookupCalls.includes(host), true, host)
  }
  assert.equal(fetchCalls.length, 0)

  const allowed = await deliverWebhook(await syntheticApprovedJob(actor(), webhookJob("https://token@public.example.test/hook")))
  assert.equal(allowed.ok, true)
  assert.equal(allowed.state, "sent")
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0]?.startsWith("https://public.example.test/hook"), true)
  assert.equal(fetchCalls[0]?.includes("token"), false)
})

test("deliverWebhook rejects literal private destinations without DNS lookup", async () => {
  setWebhookLookupForTests(async (hostname) => {
    lookupCalls.push(hostname)
    return [{ address: "203.0.113.10", family: 4 }]
  })
  setWebhookFetchForTests(async (input) => {
    fetchCalls.push(String(input))
    return new Response("ok", { status: 200 })
  })

  const loopback = await deliverWebhook(webhookJob("https://127.0.0.1/hook"))
  assert.equal(loopback.ok, false)
  assert.equal(loopback.errorCode, "provider_unavailable")
  assert.equal(lookupCalls.includes("127.0.0.1"), false)
  assert.equal(fetchCalls.length, 0)

  const metadata = await deliverWebhook(webhookJob("https://169.254.169.254/latest/meta-data/"))
  assert.equal(metadata.ok, false)
  assert.equal(fetchCalls.length, 0)

  const ula = await deliverWebhook(webhookJob("https://[fd00::1]/hook"))
  assert.equal(ula.ok, false)
  assert.equal(fetchCalls.length, 0)
})

test("deliverWebhook does not follow a 302 to a private IP as success", async () => {
  const privateUrl = "https://10.0.0.8/secret"
  setWebhookLookupForTests(async (hostname) => {
    lookupCalls.push(hostname)
    if (hostname === "public.example.test") return [{ address: "203.0.113.10", family: 4 }]
    throw new Error(`unexpected lookup: ${hostname}`)
  })
  setWebhookFetchForTests(async (input, init) => {
    const url = String(input)
    fetchCalls.push(url)
    const redirect = init?.redirect ?? "follow"
    if (url.startsWith("https://public.example.test/hook")) {
      if (redirect === "error") {
        throw new TypeError("URI requested responds with a redirect, redirect mode is set to error")
      }
      if (redirect === "manual") {
        return new Response(null, { status: 302, headers: { location: privateUrl } })
      }
      fetchCalls.push(privateUrl)
      return new Response("ssrf", { status: 200 })
    }
    if (url === privateUrl || url.includes("10.0.0.8")) {
      return new Response("ssrf", { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })

  const result = await deliverWebhook(await syntheticApprovedJob(actor(), webhookJob("https://token@public.example.test/hook")))
  assert.equal(result.ok, false)
  assert.notEqual(result.state, "sent")
  assert.equal(fetchCalls.includes(privateUrl), false)
  assert.equal(fetchCalls.some((url) => url.includes("10.0.0.8")), false)
  assert.equal(lookupCalls.includes("10.0.0.8"), false)
})
