import "./helpers/business-auth";
import test, { after, afterEach, before } from "node:test"
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
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { setClock } from "../src/lib/mca/submissions/clock"
import { packageFingerprint, submissionMerchantIdentityKey } from "../src/lib/mca/submissions/identity"
import { assertDuplicatePolicy } from "../src/lib/mca/submissions/duplicate-policy"
import { queueSubmissions, setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { updateJobRecord } from "../src/lib/mca/submissions/repository"
import { setEmailDeliveryFetchForTests } from "../src/lib/mca/submissions/email-templates"
import { POST as submissionsPost } from "../src/app/api/mca/submissions/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-duplicates-password-never-leak"
const TWO_MIN_MS = 2 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const T0 = "2026-09-08T12:00:00.000Z"

const ids = {
  workspace: "workspace-duplicates",
  otherWorkspace: "workspace-duplicates-other",
  adminUser: "duplicates-admin-user",
  adminMember: "duplicates-admin-member",
  repUser: "duplicates-rep-user",
  repMember: "duplicates-rep-member",
  otherUser: "duplicates-other-user",
  otherMember: "duplicates-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace
    ? ids.otherUser
    : role === "rep"
      ? ids.repUser
      : role
        ? ids.adminUser
        : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace
    ? ids.otherMember
    : role === "rep"
      ? ids.repMember
      : role
        ? ids.adminMember
        : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [
    workspaceId === ids.otherWorkspace
      ? ids.otherMember
      : role === "rep"
        ? ids.repMember
        : ids.adminMember,
  ],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
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
const pdfChecksum = createHash("sha256").update(minimalPdf).digest("hex")
const extraPdf = new Uint8Array(Buffer.from("%PDF-1.4\n2 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))
const extraChecksum = createHash("sha256").update(extraPdf).digest("hex")
const SHARED_EIN = "12-8800221"

let emailFunderId = ""
let portalFunderId = ""
let secondPortalFunderId = ""
let dealCounter = 0
let keyCounter = 0

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

function confirmationKey(label: string): string {
  keyCounter += 1
  return `${label}-${keyCounter}`
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Duplicates Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "duplicates-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "duplicates-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "duplicates-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("duplicates-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("duplicates-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(
    "intake-key", ids.workspace, "intake-key", hashOpaqueToken("mca_intake-secret"), JSON.stringify(["intake:write"]), ids.adminUser, now,
  )
  await database.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(
    "write-key", ids.workspace, "write-key", hashOpaqueToken("mca_write-secret"), JSON.stringify(["deals:write"]), ids.adminUser, now,
  )
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_dup")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setSubmissionCompletenessForTests(true)
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: SMTP_PASSWORD },
  })
  await testSend(actor(), sender.id, { to: "ops@example.test" })
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email-duplicates.example.test/deliver"
  setEmailDeliveryFetchForTests(async () => new Response("Fixture provider failure", { status: 503 }))
  emailFunderId = (await createFunder(actor(), {
    idempotencyKey: "email-funder",
    legalName: "Email Capital LLC",
    nickname: "Email Cap",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@emailcap.example.test", documentExceptions: [], active: true }],
  })).funder.id
  portalFunderId = (await createFunder(actor(), {
    idempotencyKey: "portal-funder",
    legalName: "Portal Capital LLC",
    nickname: "Portal Cap",
    routes: [{ kind: "manual_portal", label: "Portal", destination: "https://portal.example.test/submit", documentExceptions: [], active: true }],
  })).funder.id
  secondPortalFunderId = (await createFunder(actor(), {
    idempotencyKey: "portal-funder-2",
    legalName: "Second Portal LLC",
    nickname: "Portal Two",
    routes: [{ kind: "manual_portal", label: "Portal", destination: "https://portal-two.example.test/submit", documentExceptions: [], active: true }],
  })).funder.id
})

afterEach(() => {
  setClock(null)
})

after(async () => {
  setClock(null)
  setSubmissionCompletenessForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  setEmailDeliveryFetchForTests()
  delete process.env.MCA_EMAIL_WEBHOOK_URL
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
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

function policyInput(dealId: string, funderId: string, extra: {
  ein?: string | null
  merchantId?: string | null
  checksums?: string[]
  privilegedRetry?: boolean
  privilegedReason?: string
  actor?: DealActor
} = {}) {
  return {
    actor: extra.actor ?? actor(),
    dealId,
    funderId,
    merchantIdentityKey: submissionMerchantIdentityKey({
      workspaceId: ids.workspace,
      ein: extra.ein,
      merchantId: extra.merchantId,
      dealId,
    }),
    packageFingerprint: packageFingerprint(extra.checksums ?? [pdfChecksum]),
    privilegedRetry: extra.privilegedRetry,
    privilegedReason: extra.privilegedReason,
  }
}

async function seedDeal(options: { ein?: string; forceDuplicate?: boolean } = {}) {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `duplicate-deal-${dealCounter}`,
    legalName: `Duplicate Merchant ${dealCounter} LLC`,
    ein: options.ein,
    forceDuplicate: options.forceDuplicate,
  })).deal
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `duplicate-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return deal
}

async function enqueue(dealId: string, funderIds: string[], extra: {
  confirmationKey?: string
  privilegedRetry?: boolean
  privilegedReason?: string
  actor?: DealActor
} = {}) {
  return queueSubmissions({
    actor: extra.actor ?? actor(),
    dealId,
    funderIds,
    confirmationKey: extra.confirmationKey ?? confirmationKey("dup"),
    privilegedRetry: extra.privilegedRetry,
    privilegedReason: extra.privilegedReason,
  })
}

async function privilegedAuditCount(dealId: string) {
  const row = await getDatabase().prepare<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM audit_events
     WHERE resource_id = ? AND action = 'submission.privileged_retry'`,
  ).get(dealId)
  return Number(row?.count ?? 0)
}

async function jobRows(dealId: string) {
  return getDatabase().prepare<{ id: string; funder_id: string; state: string; reason: string | null }>(
    "SELECT id, funder_id, state, reason FROM mca_submission_jobs WHERE deal_id = ? ORDER BY created_at ASC, id ASC",
  ).all(dealId)
}

async function attemptCount(jobId: string) {
  const row = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_submission_attempts WHERE job_id = ?").get(jobId)
  return Number(row?.count ?? 0)
}

test("MIC-174 error retries are blocked inside two minutes and allowed at the boundary", async () => {
  setClock(() => T0)
  const deal = await seedDeal()
  const first = await enqueue(deal.id, [emailFunderId])
  assert.equal(first.jobs.length, 1)
  assert.equal(first.jobs[0]?.state, "failed")
  assertNoSecret(first)

  const before = await assertDuplicatePolicy(policyInput(deal.id, emailFunderId, { merchantId: deal.merchantId }))
  const eligibleAt = plus(T0, TWO_MIN_MS)
  assert.equal(before.allowed, false)
  assert.equal(before.code, "retry_too_soon")
  assert.equal(before.eligibleAt, eligibleAt)
  assert.equal((before.reason ?? "").includes(eligibleAt), true)

  setClock(() => plus(T0, TWO_MIN_MS - 1))
  const early = await enqueue(deal.id, [emailFunderId])
  assert.equal(early.jobs[0]?.state, "blocked_duplicate")
  assert.equal((early.jobs[0]?.reason ?? "").includes(eligibleAt), true)
  assert.equal((await jobRows(deal.id)).some((row) => row.id === first.jobs[0]?.jobId && row.state === "failed"), true)

  setClock(() => eligibleAt)
  const retried = await enqueue(deal.id, [emailFunderId])
  assert.equal(retried.jobs[0]?.state, "failed")
  assert.notEqual(retried.jobs[0]?.jobId, first.jobs[0]?.jobId)
})

test("merchant+funder lock survives 24h and decline; new checksum allowed; shared EIN blocked", async () => {
  setClock(() => T0)
  const deal = await seedDeal({ ein: SHARED_EIN })
  const identity = {
    ein: SHARED_EIN,
    merchantId: deal.merchantId,
  }
  const first = await enqueue(deal.id, [portalFunderId])
  assert.equal(first.jobs[0]?.state, "pending_portal")
  const originalId = first.jobs[0]?.jobId
  assert.ok(originalId)

  setClock(() => plus(T0, DAY_MS))
  const afterDay = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, identity))
  assert.equal(afterDay.allowed, false)
  assert.equal(afterDay.code, "active_duplicate")
  assert.equal(afterDay.eligibleAt, undefined)
  const stillActive = await enqueue(deal.id, [portalFunderId])
  assert.equal(stillActive.jobs[0]?.state, "blocked_duplicate")
  assert.equal((stillActive.jobs[0]?.reason ?? "").includes(plus(T0, DAY_MS)), false)

  const otherDeal = await seedDeal({ ein: SHARED_EIN, forceDuplicate: true })
  const sharedEin = await enqueue(otherDeal.id, [portalFunderId])
  assert.equal(sharedEin.jobs[0]?.state, "blocked_duplicate")
  const sharedPolicy = await assertDuplicatePolicy(policyInput(otherDeal.id, portalFunderId, {
    ein: SHARED_EIN,
    merchantId: otherDeal.merchantId,
  }))
  assert.equal(sharedPolicy.allowed, false)
  assert.equal(sharedPolicy.code, "active_duplicate")

  await updateJobRecord(ids.workspace, originalId, { state: "declined" })
  const declinedSame = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, identity))
  assert.equal(declinedSame.allowed, false)
  assert.equal(declinedSame.code, "package_unchanged")
  const declinedQueue = await enqueue(deal.id, [portalFunderId])
  assert.equal(declinedQueue.jobs[0]?.state, "blocked_duplicate")

  await updateJobRecord(ids.workspace, originalId, { state: "funded" })
  const fundedSame = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, identity))
  assert.equal(fundedSame.allowed, false)
  assert.equal(fundedSame.code, "package_unchanged")

  dealCounter += 1
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `duplicate-doc-extra-${dealCounter}`,
    filename: "statement-2.pdf",
    mimeType: "application/pdf",
    bytes: extraPdf,
    category: "statement",
    source: "test",
  })
  const renewed = await enqueue(deal.id, [portalFunderId])
  assert.equal(renewed.jobs[0]?.state, "pending_portal")
  assert.notEqual(renewed.jobs[0]?.jobId, originalId)
  const newPackage = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, {
    ...identity,
    checksums: [pdfChecksum, extraChecksum],
  }))
  assert.equal(newPackage.allowed, false)
  assert.equal(newPackage.code, "active_duplicate")
})

test("MIC-174 concurrent queueSubmissions accept one attempt and block the rest", async () => {
  setClock(() => T0)
  const deal = await seedDeal()
  const [first, second] = await Promise.all([
    enqueue(deal.id, [portalFunderId], { confirmationKey: confirmationKey("concurrent-a") }),
    enqueue(deal.id, [portalFunderId], { confirmationKey: confirmationKey("concurrent-b") }),
  ])
  const jobs = [...first.jobs, ...second.jobs]
  const accepted = jobs.filter((job) => job.state !== "blocked_duplicate")
  const blocked = jobs.filter((job) => job.state === "blocked_duplicate")
  assert.equal(jobs.length, 2)
  assert.equal(accepted.length, 1)
  assert.equal(blocked.length, 1)
  assert.equal(accepted[0]?.state, "pending_portal")
  assert.equal((blocked[0]?.reason ?? "").includes("2026-09-09T12:00:00.000Z"), false)
  assert.match(blocked[0]?.reason ?? "", /active/i)
  assert.equal(await attemptCount(accepted[0]!.jobId), 1)
  assert.equal(await attemptCount(blocked[0]!.jobId), 0)
  assert.equal((await jobRows(deal.id)).filter((row) => row.funder_id === portalFunderId).length, 2)
})

test("MIC-174 privileged retry requires a reason and retains prior jobs", async () => {
  setClock(() => T0)
  const deal = await seedDeal()
  const first = await enqueue(deal.id, [portalFunderId])
  const originalId = first.jobs[0]?.jobId
  assert.ok(originalId)
  assert.equal(first.jobs[0]?.state, "pending_portal")
  assert.equal(await privilegedAuditCount(deal.id), 0)

  const missingReason = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, {
    merchantId: deal.merchantId,
    privilegedRetry: true,
  }))
  assert.equal(missingReason.allowed, false)
  assert.equal(missingReason.code, "active_duplicate")
  assert.equal(missingReason.eligibleAt, undefined)

  const blankReason = await enqueue(deal.id, [portalFunderId], {
    privilegedRetry: true,
    privilegedReason: "   ",
  })
  assert.equal(blankReason.jobs[0]?.state, "blocked_duplicate")
  assert.equal(await privilegedAuditCount(deal.id), 0)

  const override = await assertDuplicatePolicy(policyInput(deal.id, portalFunderId, {
    merchantId: deal.merchantId,
    privilegedRetry: true,
    privilegedReason: "Merchant sent corrected statements.",
  }))
  assert.equal(override.allowed, true)
  assert.equal(override.code, "privileged_retry")
  assert.equal(await privilegedAuditCount(deal.id), 1)

  const retried = await enqueue(deal.id, [portalFunderId], {
    privilegedRetry: true,
    privilegedReason: "Merchant sent corrected statements.",
  })
  assert.equal(retried.jobs[0]?.state, "pending_portal")
  assert.notEqual(retried.jobs[0]?.jobId, originalId)
  assert.equal(await privilegedAuditCount(deal.id), 2)

  const rows = await jobRows(deal.id)
  assert.equal(rows.some((row) => row.id === originalId && row.state === "pending_portal"), true)
  assert.equal(rows.some((row) => row.id === retried.jobs[0]?.jobId && row.state === "pending_portal"), true)
  assert.equal(rows.filter((row) => row.state === "pending_portal").length, 2)
})

test("privilegedRetry is forbidden for rep sessions and API keys", async () => {
  setClock(() => T0)
  const deal = await seedDeal()
  const first = await enqueue(deal.id, [portalFunderId])
  assert.equal(first.jobs[0]?.state, "pending_portal")

  await assert.rejects(
    () => assertDuplicatePolicy(policyInput(deal.id, portalFunderId, {
      merchantId: deal.merchantId,
      actor: actor(ids.workspace, "rep"),
      privilegedRetry: true,
      privilegedReason: "Rep override attempt",
    })),
    (error: unknown) => {
      assert.equal((error as { status?: number; code?: string }).status, 403)
      assert.equal((error as { code?: string }).code, "privileged_retry_forbidden")
      return true
    },
  )

  await assert.rejects(
    () => enqueue(deal.id, [portalFunderId], {
      actor: actor(ids.workspace, null),
      privilegedRetry: true,
      privilegedReason: "API key override attempt",
    }),
    (error: unknown) => {
      assert.equal((error as { status?: number; code?: string }).status, 403)
      assert.equal((error as { code?: string }).code, "privileged_retry_forbidden")
      return true
    },
  )

  const repHttp = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "rep-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderIds: [portalFunderId],
      confirmationKey: confirmationKey("http-rep"),
      privilegedRetry: true,
      privilegedReason: "Rep HTTP override",
    }),
  }), params(deal.id))
  assert.equal(repHttp.status, 403)
  const repBody = await repHttp.json() as { error: { code: string } }
  assert.equal(repBody.error.code, "privileged_retry_forbidden")
  assertNoSecret(repBody)

  const apiHttp = await submissionsPost(bearerRequest(`/api/mca/submissions/${deal.id}`, "write-secret", {
    method: "POST",
    body: JSON.stringify({
      funderIds: [portalFunderId],
      confirmationKey: confirmationKey("http-api"),
      privilegedRetry: true,
      privilegedReason: "API key HTTP override",
    }),
  }), params(deal.id))
  assert.equal(apiHttp.status, 403)
  const apiBody = await apiHttp.json() as { error: { code: string } }
  assert.equal(apiBody.error.code, "privileged_retry_forbidden")
  assertNoSecret(apiBody)

  assert.equal(await privilegedAuditCount(deal.id), 0)
  assert.equal((await jobRows(deal.id)).filter((row) => row.state === "pending_portal").length, 1)
})

test("MIC-174 other funders stay independent and HTTP uses the same policy", async () => {
  setClock(() => T0)
  const deal = await seedDeal()
  const first = await enqueue(deal.id, [portalFunderId])
  assert.equal(first.jobs[0]?.state, "pending_portal")

  const other = await enqueue(deal.id, [emailFunderId, secondPortalFunderId])
  const emailJob = other.jobs.find((job) => job.funderId === emailFunderId)
  const secondPortal = other.jobs.find((job) => job.funderId === secondPortalFunderId)
  assert.equal(emailJob?.state, "failed")
  assert.equal(secondPortal?.state, "pending_portal")
  assert.notEqual(emailJob?.state, "blocked_duplicate")
  assert.notEqual(secondPortal?.state, "blocked_duplicate")

  const duplicateSame = await enqueue(deal.id, [portalFunderId])
  assert.equal(duplicateSame.jobs[0]?.state, "blocked_duplicate")

  const intake = await submissionsPost(bearerRequest(`/api/mca/submissions/${deal.id}`, "intake-secret", {
    method: "POST",
    body: JSON.stringify({ funderIds: [portalFunderId], confirmationKey: confirmationKey("http-intake"), privilegedRetry: true, privilegedReason: "nope" }),
  }), params(deal.id))
  assert.equal(intake.status, 403)
  assertNoSecret(await intake.json())

  const http = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ funderIds: [portalFunderId], confirmationKey: confirmationKey("http-dup") }),
  }), params(deal.id))
  assert.equal(http.status, 200)
  const body = await http.json() as { ok: true; jobs: Array<{ state: string; reason?: string }> }
  assertNoSecret(body)
  assert.equal(body.jobs[0]?.state, "blocked_duplicate")
  assert.equal((body.jobs[0]?.reason ?? "").includes("2026-09-09T12:00:00.000Z"), false)
  assert.match(body.jobs[0]?.reason ?? "", /active/i)
  assert.equal(body.jobs[0]?.reason?.includes(pdfChecksum), false)

  const adminOverride = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      funderIds: [portalFunderId],
      confirmationKey: confirmationKey("http-admin-privileged"),
      privilegedRetry: true,
      privilegedReason: "Admin HTTP privileged retry",
    }),
  }), params(deal.id))
  assert.equal(adminOverride.status, 200)
  const overrideBody = await adminOverride.json() as { ok: true; jobs: Array<{ state: string }> }
  assert.equal(overrideBody.jobs[0]?.state, "pending_portal")
  assert.equal(await privilegedAuditCount(deal.id), 1)
})
