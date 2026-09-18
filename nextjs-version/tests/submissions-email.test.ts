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
import { createSender, testSend, updateSender } from "../src/lib/mca/senders/service"
import {
  parseEmailAttemptRef,
  setEmailDeliveryFetchForTests,
  upsertSubmissionEmailTemplate,
} from "../src/lib/mca/submissions/email-templates"
import { queueSubmissions } from "../src/lib/mca/submissions/queue"
import { GET as templatesGet, PUT as templatesPut } from "../src/app/api/mca/submissions/email/route"
import { POST as previewPost } from "../src/app/api/mca/submissions/email/preview/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-email-templates-password-never-leak"
const MERCHANT_EMAIL = "merchant-followup@example.test"
const ids = {
  workspace: "workspace-email-templates",
  otherWorkspace: "workspace-email-templates-other",
  adminUser: "email-admin-user",
  adminMember: "email-admin-member",
  repUser: "email-rep-user",
  repMember: "email-rep-member",
  otherUser: "email-other-user",
  otherMember: "email-other-member",
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
const pdfChecksum = createHash("sha256").update(minimalPdf).digest("hex")

let senderId = ""
let alphaFunderId = ""
let betaFunderId = ""
let dealCounter = 0
const captured: Array<{ body: string; correlationId?: string }> = []

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Email Templates Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "email-closer@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "email-originator@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "email-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("email-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("email-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("email-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("email-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("email-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("email-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_email")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setEmailDeliveryFetchForTests(async (_input, init) => {
    captured.push({
      body: typeof init?.body === "string" ? init.body : "",
      correlationId: new Headers(init?.headers).get("x-correlation-id") ?? undefined,
    })
    return new Response("accepted", { status: 202 })
  })
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
  alphaFunderId = (await createFunder(actor(), {
    idempotencyKey: "alpha-email-funder",
    legalName: "Alpha Capital LLC",
    nickname: "Alpha",
    routes: [{ kind: "email", label: "Alpha inbox", destination: "alpha@funders.example.test", documentExceptions: [], active: true }],
  })).funder.id
  betaFunderId = (await createFunder(actor(), {
    idempotencyKey: "beta-email-funder",
    legalName: "Beta Funding Inc",
    nickname: "Beta",
    routes: [{ kind: "email", label: "Beta inbox", destination: "beta@funders.example.test", documentExceptions: [], active: true }],
  })).funder.id
  await upsertSubmissionEmailTemplate(actor(), {
    subjectTemplate: "{{legalName}} funding submission",
    bodyTemplate: "Package for {{legalName}} ({{displayId}}). Amount {{requestedAmount}}.",
    prefix: "WS",
    ccOriginator: false,
    ccCloser: false,
  })
  await upsertSubmissionEmailTemplate(actor(), {
    funderId: alphaFunderId,
    subjectTemplate: "{{legalName}} for Alpha",
    bodyTemplate: "Alpha package for {{legalName}}.",
    prefix: "ALPHA",
    ccOriginator: true,
    ccCloser: false,
  })
  await upsertSubmissionEmailTemplate(actor(), {
    funderId: betaFunderId,
    subjectTemplate: "{{legalName}} for Beta",
    bodyTemplate: "Beta package for {{legalName}}.",
    prefix: "BETA",
    ccOriginator: false,
    ccCloser: true,
  })
})

after(async () => {
  setEmailDeliveryFetchForTests()
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
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `email-deal-${dealCounter}`,
    legalName: `Email Merchant ${dealCounter} LLC`,
    requestedAmount: 75_000,
    contactEmail: MERCHANT_EMAIL,
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `email-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return { deal, document }
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

type PreviewBody = {
  delivery: string
  sender: { id: string; fromName: string; fromAddress: string }
  previews: Array<{
    funderId: string
    funderName: string
    to: string[]
    cc: string[]
    replyTo: string
    subject: string
    body: string
    workspacePrefix: string
    funderPrefix: string
    signature: string
    attachments: Array<{ documentId: string; filename: string; checksum: string }>
    error?: string
  }>
}

test("MIC-153: two funders receive separately addressed packages with originator/closer CC and no live SMTP preview", async () => {
  const beforeCapture = captured.length
  const { deal, document } = await seedDeal()
  const preview = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, funderIds: [alphaFunderId, betaFunderId] }),
  }))
  assert.equal(preview.status, 200)
  const previewBody = await preview.json() as PreviewBody
  assert.equal(previewBody.delivery, "preview")
  assert.equal(previewBody.sender.fromAddress, "broker@example.test")
  assert.equal(captured.length, beforeCapture)
  assertNoSecret(previewBody)

  const alpha = previewBody.previews.find((item) => item.funderId === alphaFunderId)
  const beta = previewBody.previews.find((item) => item.funderId === betaFunderId)
  assert.ok(alpha)
  assert.ok(beta)
  assert.deepEqual(alpha.to, ["alpha@funders.example.test"])
  assert.deepEqual(beta.to, ["beta@funders.example.test"])
  assert.deepEqual(alpha.cc, ["email-originator@example.test"])
  assert.deepEqual(beta.cc, ["email-closer@example.test"])
  assert.equal(alpha.replyTo, "broker@example.test")
  assert.equal(beta.replyTo, "broker@example.test")
  assert.equal(alpha.to.includes("beta@funders.example.test"), false)
  assert.equal(beta.to.includes("alpha@funders.example.test"), false)
  assert.equal(alpha.cc.includes("beta@funders.example.test"), false)
  assert.equal(beta.cc.includes("alpha@funders.example.test"), false)
  assert.equal(alpha.cc.includes(MERCHANT_EMAIL), false)
  assert.equal(beta.cc.includes(MERCHANT_EMAIL), false)
  assert.equal(alpha.subject.startsWith("WS ALPHA "), true)
  assert.equal(beta.subject.startsWith("WS BETA "), true)
  assert.match(alpha.subject, /Email Merchant/)
  assert.match(alpha.body, /Best,\nBroker Desk/)
  assert.equal(alpha.attachments.some((item) => item.documentId === document.id && item.checksum === pdfChecksum), true)
  assert.equal(beta.attachments.some((item) => item.filename === "statement.pdf"), true)

  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [alphaFunderId, betaFunderId],
    confirmationKey: `email-send-${dealCounter}`,
  })
  assert.equal(queued.ok, true)
  assert.equal(queued.jobs.every((job) => job.state === "sent"), true)
  assert.equal(captured.length, beforeCapture)

  const alphaAttempt = parseEmailAttemptRef((await attemptRow(queued.jobs.find((job) => job.funderId === alphaFunderId)!.jobId))!.external_ref)
  const betaAttempt = parseEmailAttemptRef((await attemptRow(queued.jobs.find((job) => job.funderId === betaFunderId)!.jobId))!.external_ref)
  assert.ok(alphaAttempt?.messageId)
  assert.equal(alphaAttempt.threadId, alphaAttempt.messageId)
  assert.deepEqual(alphaAttempt.snapshot.to, ["alpha@funders.example.test"])
  assert.deepEqual(betaAttempt?.snapshot.to, ["beta@funders.example.test"])
  assert.deepEqual(alphaAttempt.snapshot.cc, ["email-originator@example.test"])
  assert.deepEqual(betaAttempt?.snapshot.cc, ["email-closer@example.test"])
  assert.equal(alphaAttempt.snapshot.to.includes("beta@funders.example.test"), false)
  assert.equal(betaAttempt?.snapshot.to.includes("alpha@funders.example.test"), false)
  assert.equal(JSON.stringify(alphaAttempt).includes(MERCHANT_EMAIL), false)
  assert.equal(alphaAttempt.delivery, "preview")
  assertNoSecret(alphaAttempt)
  assertNoSecret(betaAttempt)
})

test("MIC-153: prefix or signature change does not rewrite a stored prior attempt", async () => {
  const { deal } = await seedDeal()
  const queued = await queueSubmissions({
    actor: actor(),
    dealId: deal.id,
    funderIds: [alphaFunderId],
    confirmationKey: `email-immutable-${dealCounter}`,
  })
  const jobId = queued.jobs[0]?.jobId
  assert.ok(jobId)
  const before = parseEmailAttemptRef((await attemptRow(jobId))!.external_ref)
  assert.ok(before)
  const storedSubject = before.snapshot.subject
  const storedBody = before.snapshot.body
  const storedPrefix = before.snapshot.funderPrefix
  const storedSignature = before.snapshot.signature
  assert.equal(storedPrefix, "ALPHA")
  assert.match(storedSignature, /Broker Desk/)

  await upsertSubmissionEmailTemplate(actor(), {
    funderId: alphaFunderId,
    subjectTemplate: "{{legalName}} CHANGED",
    bodyTemplate: "Changed body",
    prefix: "NEWALPHA",
    ccOriginator: true,
    ccCloser: true,
  })
  await updateSender(actor(), senderId, { signature: "Updated signature — should not rewrite history." })

  const after = parseEmailAttemptRef((await attemptRow(jobId))!.external_ref)
  assert.deepEqual(after, before)
  assert.equal(after?.snapshot.subject, storedSubject)
  assert.equal(after?.snapshot.body, storedBody)
  assert.equal(after?.snapshot.funderPrefix, "ALPHA")
  assert.equal(after?.snapshot.signature, storedSignature)
  assert.equal(after?.snapshot.body.includes("Updated signature"), false)
  assert.equal(after?.messageId, before.messageId)

  const preview = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, funderIds: [alphaFunderId] }),
  }))
  const previewBody = await preview.json() as PreviewBody
  assert.match(previewBody.previews[0]?.subject ?? "", /NEWALPHA/)
  assert.match(previewBody.previews[0]?.body ?? "", /Updated signature/)
  assert.notEqual(previewBody.previews[0]?.subject, storedSubject)
})

test("MIC-153: unauthorized sender is 403, preview is deals:read, templates are admin, and secrets stay out of JSON", async () => {
  const { deal } = await seedDeal()
  const otherSender = await createSender(actor(ids.otherWorkspace), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Other Desk",
    fromAddress: "other@example.test",
    smtp: { host: "smtp.example.test", port: 587, username: "other", password: SMTP_PASSWORD },
  })
  await testSend(actor(ids.otherWorkspace), otherSender.id, { to: "ops@example.test" })

  const forged = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, senderId, funderIds: [alphaFunderId] }),
  }))
  assert.equal(forged.status, 403)
  assert.equal((await forged.json() as { error: { code: string } }).error.code, "permission_denied")

  const missing = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, senderId: "missing-sender", funderIds: [alphaFunderId] }),
  }))
  assert.equal(missing.status, 403)
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "permission_denied")

  const cross = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "other-session-token", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, funderIds: [alphaFunderId] }),
  }))
  assert.equal(cross.status, 404)

  const intakePreview = await previewPost(bearerRequest("/api/mca/submissions/email/preview", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, funderIds: [alphaFunderId] }),
  }))
  assert.equal(intakePreview.status, 403)

  const intakeTemplates = await templatesGet(bearerRequest("/api/mca/submissions/email", "intake-secret"))
  assert.equal(intakeTemplates.status, 403)

  const readTemplates = await templatesGet(bearerRequest("/api/mca/submissions/email", "read-secret"))
  assert.equal(readTemplates.status, 403)

  const readPreview = await previewPost(bearerRequest("/api/mca/submissions/email/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ dealId: deal.id, funderIds: [alphaFunderId, betaFunderId] }),
  }))
  assert.equal(readPreview.status, 200)
  const readBody = await readPreview.json() as PreviewBody
  assert.equal(readBody.delivery, "preview")
  assert.equal(readBody.previews.length, 2)
  assertNoSecret(readBody)

  const writeTemplates = await templatesPut(bearerRequest("/api/mca/submissions/email", "write-secret", {
    method: "PUT",
    body: JSON.stringify({ prefix: "NOPE" }),
  }))
  assert.equal(writeTemplates.status, 403)

  const invalid = await templatesPut(cookieRequest("/api/mca/submissions/email", "admin-session-token", {
    method: "PUT",
    body: "{",
  }))
  assert.equal(invalid.status, 400)

  const saved = await templatesPut(cookieRequest("/api/mca/submissions/email", "admin-session-token", {
    method: "PUT",
    body: JSON.stringify({
      funderId: betaFunderId,
      prefix: "BETAV2",
      subjectTemplate: "{{legalName}} for Beta",
      bodyTemplate: "Beta package for {{legalName}}.",
      ccOriginator: false,
      ccCloser: true,
    }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as { prefix: string; funderId: string; ccCloser: boolean }
  assert.equal(savedBody.prefix, "BETAV2")
  assert.equal(savedBody.funderId, betaFunderId)
  assert.equal(savedBody.ccCloser, true)
  assertNoSecret(savedBody)

  const listed = await templatesGet(cookieRequest("/api/mca/submissions/email", "admin-session-token"))
  assert.equal(listed.status, 200)
  assertNoSecret(await listed.json())
})
