import "./helpers/business-auth";
import test, { after, before } from "node:test"
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
import { queueSubmissions } from "../src/lib/mca/submissions/queue"
import { setWebhookFetchForTests } from "../src/lib/mca/submissions/webhook"
import { GET as portalGet, POST as portalPost } from "../src/app/api/mca/submissions/portal/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const WEBHOOK_TOKEN = "hook-token-never-leak"
const ids = {
  workspace: "workspace-portal",
  otherWorkspace: "workspace-portal-other",
  adminUser: "portal-admin-user",
  adminMember: "portal-admin-member",
  repUser: "portal-rep-user",
  repMember: "portal-rep-member",
  otherUser: "portal-other-user",
  otherMember: "portal-other-member",
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

let portalFunderId = ""
let webhookFunderId = ""
let dealCounter = 0

type CapturedWebhook = { url: string; authorization?: string; body: string; correlationId?: string }
const captured: CapturedWebhook[] = []

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Portal Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "portal-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "portal-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "portal-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("portal-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("portal-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("portal-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("portal-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("portal-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("portal-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_portal")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setWebhookFetchForTests(async (input, init) => {
    const headers = new Headers(init?.headers)
    captured.push({
      url: String(input),
      authorization: headers.get("authorization") ?? undefined,
      body: typeof init?.body === "string" ? init.body : "",
      correlationId: headers.get("x-correlation-id") ?? undefined,
    })
    return new Response("upstream failed", { status: 500 })
  })
  await seed()
  portalFunderId = (await createFunder(actor(), {
    idempotencyKey: "portal-funder",
    legalName: "Portal Capital LLC",
    nickname: "Portal Cap",
    routes: [{ kind: "manual_portal", label: "ISO portal", destination: "https://portal.example.test/apply", documentExceptions: [], active: true }],
  })).funder.id
  webhookFunderId = (await createFunder(actor(), {
    idempotencyKey: "webhook-funder",
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

after(async () => {
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

function params(dealId: string) {
  return { params: Promise.resolve({ dealId }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(WEBHOOK_TOKEN), false)
  assert.equal(text.includes("credentialCipher"), false)
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `portal-deal-${dealCounter}`,
    legalName: `Portal Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `portal-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return { deal, document }
}

async function jobRow(jobId: string) {
  return getDatabase().prepare<{
    id: string
    state: string
    funder_id: string
    route_kind: string
    reason: string | null
  }>("SELECT id, state, funder_id, route_kind, reason FROM mca_submission_jobs WHERE id = ?").get(jobId)
}

async function attemptRow(jobId: string) {
  return getDatabase().prepare<{
    state: string
    external_ref: string | null
    error_code: string | null
    error_message: string | null
    correlation_id: string
  }>("SELECT state, external_ref, error_code, error_message, correlation_id FROM mca_submission_attempts WHERE job_id = ?").get(jobId)
}

test("MIC-178 opening a portal URL stays pending_portal until deals:write confirms with optional external ref", async () => {
  const beforeCapture = captured.length
  const { deal, document } = await seedDeal()
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [portalFunderId],
    confirmationKey: `portal-open-${dealCounter}`,
  })
  assert.equal(queued.ok, true)
  const portalJob = queued.jobs.find((item) => item.funderId === portalFunderId)
  assert.ok(portalJob)
  assert.equal(portalJob.state, "pending_portal")
  assert.notEqual(portalJob.state, "sent")
  assert.equal(captured.length, beforeCapture)

  const opened = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "open" }),
  }), params(deal.id))
  assert.equal(opened.status, 200)
  const openedBody = await opened.json() as { ok: true; jobId: string; state: string; portalUrl: string }
  assertNoSecret(openedBody)
  assert.equal(openedBody.ok, true)
  assert.equal(openedBody.jobId, portalJob.jobId)
  assert.equal(openedBody.state, "pending_portal")
  assert.equal(openedBody.portalUrl, "https://portal.example.test/apply")
  const afterOpen = await jobRow(portalJob.jobId)
  assert.equal(afterOpen?.state, "pending_portal")
  assert.notEqual(afterOpen?.state, "sent")
  const openAttempt = await attemptRow(portalJob.jobId)
  assert.ok(openAttempt)
  assert.notEqual(openAttempt.state, "sent")

  const completed = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete", externalRef: "PORTAL-REF-17" }),
  }), params(deal.id))
  assert.equal(completed.status, 200)
  const completedBody = await completed.json() as { ok: true; jobId: string; state: string; externalRef?: string }
  assertNoSecret(completedBody)
  assert.equal(completedBody.jobId, portalJob.jobId)
  assert.equal(completedBody.state, "sent")
  assert.equal(completedBody.externalRef, "PORTAL-REF-17")

  const afterComplete = await jobRow(portalJob.jobId)
  assert.equal(afterComplete?.state, "sent")
  const completeAttempt = await attemptRow(portalJob.jobId)
  assert.equal(completeAttempt?.state, "sent")
  assert.equal(completeAttempt?.external_ref, "PORTAL-REF-17")

  const replay = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete", externalRef: "PORTAL-REF-18" }),
  }), params(deal.id))
  assert.equal(replay.status, 200)
  const replayBody = await replay.json() as { jobId: string; state: string; externalRef?: string }
  assert.equal(replayBody.jobId, portalJob.jobId)
  assert.equal(replayBody.state, "sent")
  assert.equal(replayBody.externalRef, "PORTAL-REF-17")
  assert.equal((await attemptRow(portalJob.jobId))?.external_ref, "PORTAL-REF-17")

  const cache = await getDatabase().prepare<{ status: string }>(
    "SELECT status FROM deal_submissions WHERE job_id = ?",
  ).get(portalJob.jobId)
  assert.equal(cache?.status, "sent")
  assert.equal(document.checksum, pdfChecksum)
})

test("MIC-178 webhook HTTP 500 stays failed and is distinct from portal complete", async () => {
  const { deal } = await seedDeal()
  const beforeCapture = captured.length
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [portalFunderId, webhookFunderId],
    confirmationKey: `portal-webhook-${dealCounter}`,
  })
  const portalJob = queued.jobs.find((item) => item.funderId === portalFunderId)
  const webhookJob = queued.jobs.find((item) => item.funderId === webhookFunderId)
  assert.ok(portalJob)
  assert.ok(webhookJob)
  assert.equal(portalJob.state, "pending_portal")
  assert.equal(webhookJob.state, "failed")
  assert.notEqual(portalJob.state, webhookJob.state)
  assert.equal(captured.length, beforeCapture + 1)
  const delivery = captured[captured.length - 1]
  assert.equal(delivery.url.startsWith("https://hooks.example.test/submit"), true)
  assert.equal(delivery.url.includes(WEBHOOK_TOKEN), false)
  assert.equal(delivery.authorization, `Bearer ${WEBHOOK_TOKEN}`)
  assert.equal(delivery.body.includes(WEBHOOK_TOKEN), false)
  assert.equal(delivery.body.includes(deal.id), true)
  const payload = JSON.parse(delivery.body) as { jobId: string }
  assert.equal(payload.jobId, webhookJob.jobId)

  const webhookRow = await jobRow(webhookJob.jobId)
  assert.equal(webhookRow?.state, "failed")
  assert.equal(webhookRow?.reason?.includes("500"), true)
  assertNoSecret(webhookRow)
  const webhookAttempt = await attemptRow(webhookJob.jobId)
  assert.equal(webhookAttempt?.state, "failed")
  assert.equal(webhookAttempt?.error_code, "provider_error")
  assert.match(webhookAttempt?.error_message ?? "", /HTTP 500/)
  assertNoSecret(webhookAttempt)

  const completed = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete", externalRef: "ISO-88" }),
  }), params(deal.id))
  assert.equal(completed.status, 200)
  assert.equal((await completed.json() as { state: string }).state, "sent")
  assert.equal((await jobRow(portalJob.jobId))?.state, "sent")
  assert.equal((await jobRow(webhookJob.jobId))?.state, "failed")

  const offers = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deal_offers WHERE deal_id = ?",
  ).get(deal.id)
  assert.equal(Number(offers?.count), 0)

  const listed = await portalGet(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token"), params(deal.id))
  assert.equal(listed.status, 200)
  const board = await listed.json() as {
    portals: Array<{ jobId: string; state: string; portalUrl: string }>
    webhooks: Array<{ jobId: string; state: string; responseSync: boolean; destinationHost: string; schemaPreview: { sample: unknown; responseSync: boolean } }>
  }
  assertNoSecret(board)
  assert.equal(board.portals.find((item) => item.jobId === portalJob.jobId)?.state, "sent")
  const webhookView = board.webhooks.find((item) => item.jobId === webhookJob.jobId)
  assert.ok(webhookView)
  assert.equal(webhookView.state, "failed")
  assert.equal(webhookView.responseSync, false)
  assert.equal(webhookView.schemaPreview.responseSync, false)
  assert.equal(webhookView.destinationHost, "hooks.example.test")
})

test("MIC-178 HTTP permissions: deals:read lists, intake and read keys cannot complete, secrets omitted", async () => {
  const { deal } = await seedDeal()
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [portalFunderId],
    confirmationKey: `portal-acl-${dealCounter}`,
  })
  const portalJob = queued.jobs.find((item) => item.funderId === portalFunderId)
  assert.ok(portalJob)
  assert.equal(portalJob.state, "pending_portal")

  const listed = await portalGet(bearerRequest(`/api/mca/submissions/portal/${deal.id}`, "read-secret"), params(deal.id))
  assert.equal(listed.status, 200)
  const listBody = await listed.json()
  assertNoSecret(listBody)
  assert.equal((listBody as { portals: Array<{ jobId: string }> }).portals.some((item) => item.jobId === portalJob.jobId), true)

  const intake = await portalPost(bearerRequest(`/api/mca/submissions/portal/${deal.id}`, "intake-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete", externalRef: "INTAKE" }),
  }), params(deal.id))
  assert.equal(intake.status, 403)
  const intakeBody = await intake.json() as { error: { code: string } }
  assert.equal(intakeBody.error.code === "scope_required" || intakeBody.error.code === "permission_denied", true)
  assertNoSecret(intakeBody)
  assert.equal((await jobRow(portalJob.jobId))?.state, "pending_portal")

  const readWrite = await portalPost(bearerRequest(`/api/mca/submissions/portal/${deal.id}`, "read-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete" }),
  }), params(deal.id))
  assert.equal(readWrite.status, 403)

  const invalid = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "submit" }),
  }), params(deal.id))
  assert.equal(invalid.status, 422)

  const writeOk = await portalPost(bearerRequest(`/api/mca/submissions/portal/${deal.id}`, "write-secret", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete", externalRef: "WRITE-OK" }),
  }), params(deal.id))
  assert.equal(writeOk.status, 200)
  assert.equal((await writeOk.json() as { state: string }).state, "sent")

  const foreign = (await createDeal(actor(ids.otherWorkspace), {
    idempotencyKey: "foreign-portal-deal",
    legalName: "Foreign Portal Merchant LLC",
  })).deal
  const forgedGet = await portalGet(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "other-session-token"), params(deal.id))
  assert.equal(forgedGet.status, 404)
  const forgedPost = await portalPost(cookieRequest(`/api/mca/submissions/portal/${deal.id}`, "other-session-token", {
    method: "POST",
    body: JSON.stringify({ jobId: portalJob.jobId, action: "complete" }),
  }), params(deal.id))
  assert.equal(forgedPost.status, 404)
  const localOnForeign = await portalGet(cookieRequest(`/api/mca/submissions/portal/${foreign.id}`, "admin-session-token"), params(foreign.id))
  assert.equal(localOnForeign.status, 404)
})
