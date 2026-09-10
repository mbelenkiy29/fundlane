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
import { createSender, testSend } from "../src/lib/mca/senders/service"
import { queueSubmissions } from "../src/lib/mca/underwriting/submission-port"
import { GET as submissionsGet, POST as submissionsPost } from "../src/app/api/mca/submissions/[dealId]/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-submissions-password-never-leak"
const ids = {
  workspace: "workspace-submissions",
  otherWorkspace: "workspace-submissions-other",
  adminUser: "submissions-admin-user",
  adminMember: "submissions-admin-member",
  repUser: "submissions-rep-user",
  repMember: "submissions-rep-member",
  otherUser: "submissions-other-user",
  otherMember: "submissions-other-member",
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

let emailFunderId = ""
let brokenFunderId = ""
let dealCounter = 0

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Submissions Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "submissions-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "submissions-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "submissions-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("submissions-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("submissions-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("submissions-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_core")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
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
  emailFunderId = (await createFunder(actor(), {
    idempotencyKey: "email-funder",
    legalName: "Email Capital LLC",
    nickname: "Email Cap",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@emailcap.example.test", documentExceptions: [], active: true }],
  })).funder.id
  brokenFunderId = (await createFunder(actor(), {
    idempotencyKey: "broken-funder",
    legalName: "Broken Route LLC",
    nickname: "Broken",
  })).funder.id
})

after(async () => {
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
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `submission-deal-${dealCounter}`,
    legalName: `Submission Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `submission-doc-${dealCounter}`,
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
    confirmation_key: string
    deal_version: number
    document_versions_json: string
    state: string
    funder_id: string
  }>("SELECT id, confirmation_key, deal_version, document_versions_json, state, funder_id FROM mca_submission_jobs WHERE id = ?").get(jobId)
}

async function attemptCount(jobId: string) {
  const row = await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_submission_attempts WHERE job_id = ?").get(jobId)
  return Number(row?.count ?? 0)
}

test("MIC-166 independent destinations freeze versions and keep one rejected job from stopping the other", async () => {
  const { deal, document } = await seedDeal()
  const runId = "analysis-run-independent"
  const result = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [emailFunderId, brokenFunderId],
    analysisRunId: runId,
  })
  assert.equal(result.ok, true)
  assert.equal(result.jobs.length, 2)
  const emailJob = result.jobs.find((item) => item.funderId === emailFunderId)
  const brokenJob = result.jobs.find((item) => item.funderId === brokenFunderId)
  assert.ok(emailJob)
  assert.ok(brokenJob)
  assert.equal(brokenJob.state, "preflight_failed")
  assert.ok(["failed", "queued", "sent"].includes(emailJob.state))
  assert.notEqual(emailJob.state, brokenJob.state)

  const emailRow = await jobRow(emailJob.jobId)
  const brokenRow = await jobRow(brokenJob.jobId)
  assert.ok(emailRow)
  assert.ok(brokenRow)
  assert.equal(emailRow.confirmation_key, runId)
  assert.equal(brokenRow.confirmation_key, runId)
  assert.equal(Number(emailRow.deal_version), deal.version)
  assert.equal(Number(brokenRow.deal_version), deal.version)
  assert.equal(emailRow.document_versions_json.includes(document.checksum), true)
  assert.equal(emailRow.document_versions_json.includes(pdfChecksum), true)

  const outbox = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM mca_submission_outbox WHERE job_id IN (?, ?)",
  ).get(emailJob.jobId, brokenJob.jobId)
  assert.equal(Number(outbox?.count), 2)

  const cache = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deal_submissions WHERE deal_id = ? AND funder_id IS NOT NULL AND job_id IS NOT NULL AND route_kind IS NOT NULL",
  ).get(deal.id)
  assert.equal(Number(cache?.count), 2)
  assert.equal(await attemptCount(emailJob.jobId), 1)
  assert.equal(await attemptCount(brokenJob.jobId), 0)

  const replay = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [emailFunderId, brokenFunderId],
    analysisRunId: runId,
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.jobs.find((item) => item.funderId === emailFunderId)?.jobId, emailJob.jobId)
  assert.equal(replay.jobs.find((item) => item.funderId === brokenFunderId)?.jobId, brokenJob.jobId)
  assert.equal(await attemptCount(emailJob.jobId), 1)
  assert.equal(await attemptCount(brokenJob.jobId), 0)
  const jobCount = await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM mca_submission_jobs WHERE deal_id = ? AND confirmation_key = ?",
  ).get(deal.id, runId)
  assert.equal(Number(jobCount?.count), 2)
})

test("MIC-166 HTTP confirmation is idempotent and mixed destinations stay independent", async () => {
  const { deal } = await seedDeal()
  const listed = await submissionsGet(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token"), params(deal.id))
  assert.equal(listed.status, 200)
  const selection = await listed.json() as {
    funders: Array<{ id: string; preflightErrors: Array<{ message: string }> }>
    documents: Array<{ checksum: string }>
  }
  assertNoSecret(selection)
  assert.equal(selection.funders.some((item) => item.id === emailFunderId), true)
  assert.equal(selection.funders.find((item) => item.id === brokenFunderId)?.preflightErrors.length !== 0, true)
  assert.equal(selection.documents.some((item) => item.checksum === pdfChecksum), true)

  const empty = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ funderIds: [] }),
  }), params(deal.id))
  assert.equal(empty.status, 422)
  assert.equal((await empty.json() as { error: { fieldErrors?: { funderIds?: string[] } } }).error.fieldErrors?.funderIds?.length !== 0, true)

  const confirmationKey = "confirm-http-once"
  const first = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ funderIds: [emailFunderId, brokenFunderId], confirmationKey }),
  }), params(deal.id))
  assert.equal(first.status, 200)
  const firstBody = await first.json() as {
    ok: true
    confirmationKey: string
    jobs: Array<{ jobId: string; funderId: string; state: string; reason?: string }>
  }
  assertNoSecret(firstBody)
  assert.equal(firstBody.ok, true)
  assert.equal(firstBody.confirmationKey, confirmationKey)
  const emailJob = firstBody.jobs.find((item) => item.funderId === emailFunderId)
  const brokenJob = firstBody.jobs.find((item) => item.funderId === brokenFunderId)
  assert.ok(emailJob)
  assert.ok(brokenJob)
  assert.equal(brokenJob.state, "preflight_failed")
  assert.ok(["failed", "queued", "sent"].includes(emailJob.state))

  const second = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ funderIds: [emailFunderId, brokenFunderId], confirmationKey }),
  }), params(deal.id))
  assert.equal(second.status, 200)
  const secondBody = await second.json() as { jobs: Array<{ jobId: string; funderId: string }> }
  assertNoSecret(secondBody)
  assert.equal(secondBody.jobs.find((item) => item.funderId === emailFunderId)?.jobId, emailJob.jobId)
  assert.equal(secondBody.jobs.find((item) => item.funderId === brokenFunderId)?.jobId, brokenJob.jobId)
  assert.equal(await attemptCount(emailJob.jobId), 1)
})

test("MIC-166 email without a usable submission sender fails independently of other destinations", async () => {
  const other = actor(ids.otherWorkspace)
  const deal = (await createDeal(other, { idempotencyKey: "no-sender-deal", legalName: "No Sender Merchant LLC" })).deal
  await storeDocument(other, {
    dealId: deal.id,
    idempotencyKey: "no-sender-doc",
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  const email = (await createFunder(other, {
    idempotencyKey: "other-email",
    legalName: "Other Email Capital LLC",
    routes: [{ kind: "email", label: "Submissions", destination: "subs@other.example.test", documentExceptions: [], active: true }],
  })).funder
  const broken = (await createFunder(other, {
    idempotencyKey: "other-broken",
    legalName: "Other Broken LLC",
  })).funder
  const result = await queueSubmissions({
    actor: other,
    dealId: deal.id,
    funderIds: [email.id, broken.id],
    analysisRunId: "no-sender-run",
  })
  assert.equal(result.ok, true)
  const emailJob = result.jobs.find((item) => item.funderId === email.id)
  const brokenJob = result.jobs.find((item) => item.funderId === broken.id)
  assert.ok(emailJob)
  assert.ok(brokenJob)
  assert.equal(emailJob.state, "preflight_failed")
  assert.equal(brokenJob.state, "preflight_failed")
  assert.match(emailJob.reason ?? "", /sender/i)
  assert.match(brokenJob.reason ?? "", /route/i)
  assert.equal(await attemptCount(emailJob.jobId), 0)
  assert.equal(await attemptCount(brokenJob.jobId), 0)
})

test("MIC-166 permissions: deals:read lists, intake and read keys cannot confirm, forged workspace is 404", async () => {
  const { deal } = await seedDeal()
  const foreign = (await createDeal(actor(ids.otherWorkspace), {
    idempotencyKey: "foreign-submission-deal",
    legalName: "Foreign Merchant LLC",
  })).deal

  const listed = await submissionsGet(bearerRequest(`/api/mca/submissions/${deal.id}`, "read-secret"), params(deal.id))
  assert.equal(listed.status, 200)
  assertNoSecret(await listed.json())

  const intake = await submissionsPost(bearerRequest(`/api/mca/submissions/${deal.id}`, "intake-secret", {
    method: "POST",
    body: JSON.stringify({ funderIds: [emailFunderId], confirmationKey: "intake-blocked" }),
  }), params(deal.id))
  assert.equal(intake.status, 403)
  const intakeBody = await intake.json() as { error: { code: string } }
  assert.equal(intakeBody.error.code === "scope_required" || intakeBody.error.code === "permission_denied", true)
  assertNoSecret(intakeBody)

  const readWrite = await submissionsPost(bearerRequest(`/api/mca/submissions/${deal.id}`, "read-secret", {
    method: "POST",
    body: JSON.stringify({ funderIds: [emailFunderId], confirmationKey: "read-blocked" }),
  }), params(deal.id))
  assert.equal(readWrite.status, 403)

  const writeOk = await submissionsPost(bearerRequest(`/api/mca/submissions/${deal.id}`, "write-secret", {
    method: "POST",
    body: JSON.stringify({ funderIds: [brokenFunderId], confirmationKey: "write-allowed" }),
  }), params(deal.id))
  assert.equal(writeOk.status, 200)
  assert.equal((await writeOk.json() as { ok: boolean }).ok, true)

  const forgedGet = await submissionsGet(cookieRequest(`/api/mca/submissions/${deal.id}`, "other-session-token"), params(deal.id))
  assert.equal(forgedGet.status, 404)
  const forgedPost = await submissionsPost(cookieRequest(`/api/mca/submissions/${deal.id}`, "other-session-token", {
    method: "POST",
    body: JSON.stringify({ funderIds: [emailFunderId], confirmationKey: "forged" }),
  }), params(deal.id))
  assert.equal(forgedPost.status, 404)

  const localOnForeign = await submissionsGet(cookieRequest(`/api/mca/submissions/${foreign.id}`, "admin-session-token"), params(foreign.id))
  assert.equal(localOnForeign.status, 404)
})

test("dashboard scopes rows, detail, filter choices and manual history without exposing terms", async () => {
  const { listSubmissionDashboard, getSubmissionDashboardDetail, validateDashboardParams } = await import("../src/lib/mca/submissions/dashboard")
  const { GET: listGet } = await import("../src/app/api/mca/submissions/route")
  const { GET: detailGet } = await import("../src/app/api/mca/submissions/records/[recordId]/route")
  const db = getDatabase()
  const admin = { ...actor(), activeMembershipIds: [ids.adminMember, ids.repMember] }
  const deal = (await createDeal(admin, { idempotencyKey:"dashboard-visible", legalName:"Dashboard Coffee", assignments:[{membershipId:ids.repMember,kind:"originator"}] })).deal
  const hidden = (await createDeal(admin, { idempotencyKey:"dashboard-hidden", legalName:"Private business", assignments:[{membershipId:ids.adminMember,kind:"originator"}] })).deal
  await db.prepare("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES (?,?,?,?,?)").run("dashboard-legacy",ids.workspace,deal.id,"Dashboard Funder","sent")
  await db.prepare("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES (?,?,?,?,?)").run("dashboard-hidden",ids.workspace,hidden.id,"Private Funder","approved")
  await db.prepare("INSERT INTO mca_manual_submissions (id,workspace_id,deal_id,funder_name,historical_at,reason,state,source,idempotency_key,created_by_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'submitted','historical',?,?,?,?)").run("dashboard-manual",ids.workspace,deal.id,"Historical Funder","2026-01-01","secret financial reason", "dashboard-manual",ids.adminUser,"2026-01-01","2026-01-01")
  const repResult = await listSubmissionDashboard(actor(ids.workspace,"rep"),new URLSearchParams("q=dashboard"))
  assert.equal(repResult.rows.some(row=>row.id === "legacy:dashboard-legacy"),true)
  assert.equal(repResult.choices.funders.some(f=>f.name === "Private Funder"),false)
  assert.equal(repResult.choices.funders.some(f=>f.name === "Historical Funder"),false)
  const legacy = await getSubmissionDashboardDetail(actor(ids.workspace,"rep"),"legacy:dashboard-legacy")
  assert.equal(legacy.submittedAt,null); assert.equal(legacy.delivery,"sent"); assert.equal(legacy.response,"unknown")
  assert.equal(legacy.attempts.length,0)
  await assert.rejects(getSubmissionDashboardDetail(actor(ids.workspace,"rep"),"legacy:dashboard-hidden"), {status:404})
  await assert.rejects(getSubmissionDashboardDetail(actor(ids.otherWorkspace),"legacy:dashboard-legacy"), {status:404})
  for (const role of ["admin","super_admin"] as const) assert.equal((await listSubmissionDashboard(actor(ids.workspace,role),new URLSearchParams())).rows.some(r=>r.id === "manual:dashboard-manual"),true)
  const manager = {...actor(ids.workspace,"manager"), managedMembershipIds:[ids.repMember]}
  assert.equal((await listSubmissionDashboard(manager,new URLSearchParams("q=dashboard"))).rows.some(r=>r.id === "legacy:dashboard-legacy"),true)
  assert.equal((await listSubmissionDashboard(actor(ids.workspace,null),new URLSearchParams())).rows.some(r=>r.source === "manual"),false)
  const adminDetail = await getSubmissionDashboardDetail(admin,"manual:dashboard-manual")
  assert.equal(JSON.stringify(adminDetail).includes("secret financial"),false)
  assert.throws(()=>validateDashboardParams(new URLSearchParams("from=2026-02-30")))
  assert.throws(()=>validateDashboardParams(new URLSearchParams("page=-1")))
  assert.throws(()=>validateDashboardParams(new URLSearchParams("from=2026-09-10&to=2026-09-09")))
  assert.equal((await listGet(bearerRequest("/api/mca/submissions","read-secret"))).status,200)
  assert.equal((await listGet(bearerRequest("/api/mca/submissions","intake-secret"))).status,403)
  assert.equal((await listGet(new Request("http://localhost/api/mca/submissions"))).status,401)
  assert.equal((await detailGet(cookieRequest("/api/mca/submissions/records/legacy:dashboard-hidden","rep-session-token"),{params:Promise.resolve({recordId:"legacy:dashboard-hidden"})})).status,404)
  // Every linked cache row contributes only its job row.
  const jobs = await db.prepare<{id:string}>("SELECT id FROM mca_submission_jobs WHERE workspace_id=?").all(ids.workspace)
  const all = await listSubmissionDashboard(admin,new URLSearchParams())
  for (const job of jobs) assert.equal(all.rows.filter(row=>row.id===`automated:${job.id}`).length,1)
  if (jobs[0]) {
    await db.prepare("INSERT INTO mca_submission_attempts (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,error_message,created_at) VALUES (?,?,?,?,'email','failed',?,?,'2026-09-09T12:00:00.000Z')").run("dashboard-attempt",ids.workspace,jobs[0].id,"dashboard-attempt","correlation","secret financial provider payload")
    const detail = await getSubmissionDashboardDetail(admin,`automated:${jobs[0].id}`)
    assert.equal(detail.attempts.some(attempt=>attempt.id === "dashboard-attempt"),true)
    assert.equal(JSON.stringify(detail).includes("secret financial"),false)
    assert.match(detail.attempts.find(attempt=>attempt.id === "dashboard-attempt")!.guidance!,/retry/)
  }
  assertNoSecret(all)
})
