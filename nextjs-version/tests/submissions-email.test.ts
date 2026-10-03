import "./helpers/business-auth";
import { queueWithSyntheticApproval as queueSubmissions } from "./helpers/broker-submission-preview"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { crc32, deflateSync } from "node:zlib"
import { PDFDocument, StandardFonts } from "pdf-lib"
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
import { createSender, updateSender } from "../src/lib/mca/senders/service"
import { getOutgoingDocumentBytes } from "../src/lib/mca/submissions/compress"
import {
  deliverRendered,
  sendSubmissionEmail,
  parseEmailAttemptRef,
  setEmailDeliveryFetchForTests,
  setSubmissionEmailProductionForTests,
  upsertSubmissionEmailTemplate,
} from "../src/lib/mca/submissions/email-templates"
import { prepareOutgoingPackage } from "../src/lib/mca/submissions/package"
import { setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import { listJobsForDeal } from "../src/lib/mca/submissions/repository"
import { prepareDealSubmission, readDealSubmissionPreview } from "../src/lib/mca/submissions/broker-preview"
import { updateWatermarkSettings } from "../src/lib/mca/submissions/watermarks"
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
  setSubmissionCompletenessForTests(true)
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
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), sender.workspaceId, sender.id)
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
  setSubmissionEmailProductionForTests()
  setSubmissionCompletenessForTests()
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

test("route document exclusions remove categories from previews and queued attachments", async () => {
  const { deal, document } = await seedDeal()
  const funderId = (await createFunder(actor(), {
    idempotencyKey: `excluded-document-funder-${dealCounter}`,
    legalName: "No Statements Capital",
    routes: [{ kind: "email", label: "Email", destination: "nostatements@example.test", documentExceptions: ["statement"], active: true }],
  })).funder.id
  const preview = await previewPost(cookieRequest("/api/mca/submissions/email/preview", "admin-session-token", {
    method: "POST", body: JSON.stringify({ dealId: deal.id, funderIds: [funderId] }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as PreviewBody
  assert.deepEqual(body.previews[0]?.attachments, [])
  const queued = await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [funderId], confirmationKey: `excluded-document-${dealCounter}` })
  assert.equal(queued.ok, true)
  const job = (await listJobsForDeal(actor().workspaceId, deal.id)).find((item) => item.funderId === funderId)
  assert.ok(job)
  assert.equal(job.packageDocumentIds.includes(document.id), false)
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
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), otherSender.workspaceId, otherSender.id)

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

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function makePng(width: number, height: number) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 4
      raw[i] = 16
      raw[i + 1] = 72
      raw[i + 2] = 160
      raw[i + 3] = 255
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]))
}

async function statementPdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  page.drawText("Merchant statement", { x: 48, y: 720, size: 14, font })
  return new Uint8Array(await pdf.save({ useObjectStreams: false }))
}

test("email webhook attaches packaged document bytes, not vault originals", async () => {
  dealCounter += 1
  const pdfBytes = await statementPdf()
  const originalChecksum = createHash("sha256").update(pdfBytes).digest("hex")
  const deal = (await createDeal(actor(), {
    idempotencyKey: `email-packaged-deal-${dealCounter}`,
    legalName: `Packaged Merchant ${dealCounter} LLC`,
    requestedAmount: 75_000,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `email-packaged-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: pdfBytes,
    category: "statement",
    source: "test",
  })
  const branding = (await createDeal(actor(), {
    idempotencyKey: `email-logo-deal-${dealCounter}`,
    legalName: `Packaged Branding ${dealCounter} LLC`,
  })).deal
  const logo = await storeDocument(actor(), {
    dealId: branding.id,
    idempotencyKey: `email-logo-${dealCounter}`,
    filename: "broker-logo.png",
    mimeType: "image/png",
    bytes: makePng(64, 64),
    category: "other_stip",
    source: "test",
  })
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId: logo.id, excludedFunderIds: [] })
  const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://email-packaged.example.test/send"
  const beforeCapture = captured.length
  try {
    const queued = await queueSubmissions({
      actor: actor(),
      dealId: deal.id,
      funderIds: [alphaFunderId],
      confirmationKey: `email-packaged-${dealCounter}`,
    })
    assert.equal(queued.ok, true)
    assert.equal(queued.jobs[0]?.state, "sent")
    assert.equal(captured.length, beforeCapture + 1)
    const payload = JSON.parse(captured[beforeCapture]?.body ?? "{}") as {
      attachments?: Array<{ documentId: string; checksum: string; filename: string; byteLength: number; bytesBase64?: string }>
    }
    const attachment = payload.attachments?.find((item) => item.filename === "statement.pdf")
    assert.ok(attachment?.bytesBase64)
    const sentBytes = Buffer.from(attachment.bytesBase64, "base64")
    assert.notEqual(createHash("sha256").update(sentBytes).digest("hex"), originalChecksum)
    assert.notEqual(attachment.documentId, document.id)
    assert.notEqual(attachment.checksum, originalChecksum)

    const packaged = await prepareOutgoingPackage({
      originals: [{
        documentId: document.id,
        originalDocumentId: document.id,
        checksum: document.checksum,
        byteLength: document.byteLength,
        stage: "original",
      }],
      funderId: alphaFunderId,
    })
    const packagedBytes = await getOutgoingDocumentBytes(packaged.documents[0])
    assert.equal(createHash("sha256").update(sentBytes).digest("hex"), createHash("sha256").update(packagedBytes).digest("hex"))
    assert.equal(attachment.documentId, packaged.documents[0]?.documentId)
    assert.equal(attachment.checksum, packaged.documents[0]?.checksum)
    assert.equal(createHash("sha256").update(memory.get(`${ids.workspace}/${document.dealId}/${document.id}`) ?? new Uint8Array()).digest("hex"), originalChecksum)
  } finally {
    await updateWatermarkSettings(actor(), { enabled: false, logoDocumentId: null, excludedFunderIds: [] })
    if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
  }
})

test("queue fails closed when watermark is enabled without a logo", async () => {
  const { deal } = await seedDeal()
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId: null, excludedFunderIds: [] })
  try {
    await assert.rejects(() => queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [alphaFunderId], confirmationKey: `email-watermark-nologo-${dealCounter}` }), (error: unknown) => (error as { code?: string }).code === "watermark_logo_required")
  } finally {
    await updateWatermarkSettings(actor(), { enabled: false, logoDocumentId: null, excludedFunderIds: [] })
  }
})

test("production missing webhook or preview delivery fails the job", async () => {
  const { deal } = await seedDeal()
  const previousWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setSubmissionEmailProductionForTests(true)
  try {
    const queued = await queueSubmissions({
      actor: actor(),
      dealId: deal.id,
      funderIds: [alphaFunderId],
      confirmationKey: `email-prod-preview-${dealCounter}`,
    })
    assert.equal(queued.ok, true)
    assert.equal(queued.jobs[0]?.state, "failed")
    assert.notEqual(queued.jobs[0]?.state, "sent")
    const attempt = await attemptRow(queued.jobs[0]!.jobId)
    assert.equal(attempt?.state, "failed")
    assert.ok(attempt?.error_code === "email_delivery_unconfigured" || attempt?.error_code === "preview_not_sent")
    assert.equal(parseEmailAttemptRef(attempt?.external_ref)?.delivery === "sent", false)
  } finally {
    setSubmissionEmailProductionForTests()
    if (previousWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = previousWebhook
  }
})

test("approved ambiguous relay responses stay uncertain even with the optional legacy guard disabled", async () => {
  const priorWebhook = process.env.MCA_EMAIL_WEBHOOK_URL
  const priorGuard = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://controlled.example.test/send"
  try {
    for (const [guard, response, expected] of [
      ["true", "timeout", "delivery_uncertain"],
      ["true", "http500", "delivery_uncertain"],
      ["true", "http400", "email_delivery_failed"],
      ["false", "timeout", "delivery_uncertain"],
    ] as const) {
      process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = guard
      setEmailDeliveryFetchForTests(async () => {
        if (response === "timeout") throw new DOMException("timed out", "TimeoutError")
        return new Response("fixture", { status: response === "http500" ? 500 : 400 })
      })
      const { deal } = await seedDeal()
      const queued = await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [alphaFunderId], confirmationKey: `email-ambiguous-${dealCounter}` })
      assert.equal(queued.jobs[0]?.state, "failed")
      assert.equal((await attemptRow(queued.jobs[0]!.jobId))?.error_code, expected)
    }
  } finally {
    if (priorGuard === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = priorGuard
    if (priorWebhook === undefined) delete process.env.MCA_EMAIL_WEBHOOK_URL
    else process.env.MCA_EMAIL_WEBHOOK_URL = priorWebhook
    setEmailDeliveryFetchForTests(async (_input, init) => {
      captured.push({ body: typeof init?.body === "string" ? init.body : "", correlationId: new Headers(init?.headers).get("x-correlation-id") ?? undefined })
      return new Response("accepted", { status: 202 })
    })
  }
})

async function withProvider(provider: "usesend" | "resend", run: (calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }>) => Promise<void>, respond: () => Response | Promise<Response> = () => Response.json({ emailId: "em-1", id: "em-1" })) {
  const keys = ["MCA_EMAIL_WEBHOOK_URL", "MCA_SUBMISSION_EMAIL_SYSTEM_PROVIDER_ENABLED", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_RESEND_API_KEY", "MCA_RESEND_FROM", "MCA_SYSTEM_EMAIL_PROVIDER", "MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED"] as const
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  if (provider === "resend") {
    process.env.MCA_SYSTEM_EMAIL_PROVIDER = "resend"
    process.env.MCA_RESEND_API_KEY = "re_test_key"
    process.env.MCA_RESEND_FROM = "Fundlane <system@resend.example.test>"
  } else process.env.MCA_SYSTEM_EMAIL_PROVIDER = "usesend"
  process.env.MCA_SUBMISSION_EMAIL_SYSTEM_PROVIDER_ENABLED = "true"
  process.env.MCA_USESEND_API_KEY = "us_test_key"
  process.env.MCA_USESEND_FROM = "Fundlane <system@mail.example.test>"
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = []
  setEmailDeliveryFetchForTests(async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
    return respond()
  })
  try { await run(calls) } finally {
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key] }
    setEmailDeliveryFetchForTests(async (_input, init) => {
      captured.push({ body: typeof init?.body === "string" ? init.body : "", correlationId: new Headers(init?.headers).get("x-correlation-id") ?? undefined })
      return new Response("accepted", { status: 202 })
    })
  }
}

async function queueOne(documents = 0) {
  const { deal } = await seedDeal()
  for (let i = 0; i < documents; i += 1) {
    await storeDocument(actor(), { dealId: deal.id, idempotencyKey: `email-extra-${dealCounter}-${i}`, filename: `extra-${i}.pdf`, mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from(`%PDF-1.4\n% extra ${dealCounter}-${i}\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n`)), category: "statement", source: "test" })
  }
  const queued = await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [alphaFunderId], confirmationKey: `email-usesend-${dealCounter}` })
  return { job: queued.jobs[0]!, attempt: await attemptRow(queued.jobs[0]!.jobId) }
}

for (const [provider, url, key, from, replyToKey] of [
  ["usesend", "https://app.usesend.com/api/v1/emails", "us_test_key", "Fundlane <system@mail.example.test>", "replyTo"],
  ["resend", "https://api.resend.com/emails", "re_test_key", "Fundlane <system@resend.example.test>", "reply_to"],
] as const) {
  test(`${provider} submission send carries attachments, Reply-To, Message-ID and References`, async () => {
    await withProvider(provider, async (calls) => {
      const { job, attempt } = await queueOne()
      assert.equal(job.state, "sent")
      assert.equal(calls.length, 1)
      const { url: sentUrl, headers, body } = calls[0]!
      assert.equal(sentUrl, url)
      assert.equal(headers.get("authorization"), `Bearer ${key}`)
      assert.equal(headers.get("idempotency-key"), attempt?.correlation_id)
      assert.equal(body.from, from)
      assert.equal(body[replyToKey], "broker@example.test")
      assert.deepEqual(body.to, ["alpha@funders.example.test"])
      const ref = parseEmailAttemptRef(attempt?.external_ref)
      assert.equal(ref?.attemptedMessageId, (body.headers as Record<string, string>)["Message-ID"])
      assert.equal((body.headers as Record<string, string>).References, (body.headers as Record<string, string>)["Message-ID"])
      assert.equal(ref?.messageId, "")
      assert.equal(ref?.threadId, "")
      assert.deepEqual(ref?.references, [])
      assert.equal(ref?.threadStatus, "unknown")
      assert.equal(ref?.providerEmailId, "em-1")
      assert.equal(ref?.provider, provider)
      assert.equal(ref?.snapshot.fromAddress, provider === "resend" ? "system@resend.example.test" : "system@mail.example.test")
      const files = body.attachments as Array<{ filename: string; content: string }>
      assert.equal(files.length, 1)
      assert.equal(files[0]!.filename, "statement.pdf")
      assert.ok(Buffer.from(files[0]!.content, "base64").length > 0)
    })
  })
}

test("useSend submission send fails closed above ten attachments without calling the provider", async () => {
  await withProvider("usesend", async (calls) => {
    const { job, attempt } = await queueOne(10)
    assert.equal(job.state, "failed")
    assert.equal(attempt?.error_code, "email_attachment_limit_exceeded")
    assert.equal(calls.length, 0)
  })
})

test("broker approval shows the delivered system sender and becomes stale after provider configuration changes", async () => {
  await withProvider("resend", async (calls) => {
    const { deal } = await seedDeal()
    const preview = await prepareDealSubmission(actor(), deal.id, [alphaFunderId])
    assert.equal(preview.destinations[0]?.email?.from, "system@resend.example.test")
    assert.equal(preview.destinations[0]?.email?.replyTo, "broker@example.test")
    for (const [key, value] of [["MCA_RESEND_FROM", "Changed <changed@example.test>"], ["MCA_RESEND_API_KEY", "changed-provider-account"], ["MCA_SYSTEM_EMAIL_PROVIDER", "usesend"]] as const) {
      const before = process.env[key]
      process.env[key] = value
      await assert.rejects(readDealSubmissionPreview(actor(), deal.id, preview.id), { code: "submission_preview_stale" })
      if (before === undefined) delete process.env[key]; else process.env[key] = before
    }
    assert.equal(calls.length, 0)
  })
})

test("every malformed successful provider response remains uncertain under the send guard", async () => {
  for (const status of [200, 201, 202]) {
    await withProvider("resend", async () => {
      process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
      assert.equal((await queueOne()).attempt?.error_code, "delivery_uncertain")
    }, () => Response.json({}, { status }))
  }
})

test("approved queued system emails refuse provider, sender, account or transport drift before dispatch", async () => {
  await withProvider("resend", async (calls) => {
    const { deal } = await seedDeal()
    await queueSubmissions({ actor: actor(), dealId: deal.id, funderIds: [alphaFunderId], confirmationKey: `frozen-system-${dealCounter}`, deferDelivery: true })
    const [job] = await listJobsForDeal(ids.workspace, deal.id)
    assert.ok(job?.approvedPackage?.email)
    assert.equal(job.approvedPackage.email.fromAddress, "system@resend.example.test")
    assert.equal(job.approvedPackage.email.submissionSenderAddress, "broker@example.test")
    for (const [key, value] of [["MCA_RESEND_FROM", "Changed <changed@example.test>"], ["MCA_RESEND_API_KEY", "changed-provider-account"], ["MCA_SYSTEM_EMAIL_PROVIDER", "usesend"], ["MCA_SUBMISSION_EMAIL_SYSTEM_PROVIDER_ENABLED", "false"], ["MCA_EMAIL_WEBHOOK_URL", "https://new-webhook.example.test/send"]] as const) {
      const before = process.env[key]
      process.env[key] = value
      assert.equal((await sendSubmissionEmail(job, job.approvedPackage.documents)).errorCode, "approved_email_transport_changed")
      if (before === undefined) delete process.env[key]; else process.env[key] = before
    }
    assert.equal(calls.length, 0)
  })
})

test("useSend submission send maps provider errors", async () => {
  for (const [respond, expected] of [
    [() => new Response("{}", { status: 422 }), "email_delivery_failed"],
    [() => new Response("{}", { status: 500 }), "delivery_uncertain"],
    [() => { throw new DOMException("timed out", "TimeoutError") }, "delivery_uncertain"],
  ] as const) {
    await withProvider("usesend", async () => {
      process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
      assert.equal((await queueOne()).attempt?.error_code, expected)
    }, respond)
  }
})

test("webhook stays preferred; flag off keeps production unconfigured", async () => {
  await withProvider("usesend", async (calls) => {
    process.env.MCA_EMAIL_WEBHOOK_URL = "https://hook.example.test/send"
    assert.equal((await queueOne()).job.state, "sent")
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, "https://hook.example.test/send")
  })
  for (const provider of ["usesend", "resend"] as const) {
    await withProvider(provider, async (calls) => {
      process.env.MCA_SUBMISSION_EMAIL_SYSTEM_PROVIDER_ENABLED = "false"
      setSubmissionEmailProductionForTests(true)
      try { assert.equal((await queueOne()).attempt?.error_code, "email_delivery_unconfigured") } finally { setSubmissionEmailProductionForTests() }
      assert.equal(calls.length, 0)
    })
  }
})

test("Resend submission send fails closed above 40MB and maps errors", async () => {
  await withProvider("resend", async (calls) => {
    // Packaging caps payloads at 25MB first, so exercise the provider guard directly.
    const file = (n: number) => ({ documentId: `d${n}`, filename: `f${n}.pdf`, checksum: "x", byteLength: 1, category: "statement", bytesBase64: "A".repeat(21 * 1024 * 1024) })
    const result = await deliverRendered({ funderId: alphaFunderId, funderName: "Alpha", senderId, fromName: "B", fromAddress: "broker@example.test", to: ["alpha@funders.example.test"], cc: [], replyTo: "broker@example.test", subject: "s", body: "b", workspacePrefix: "", funderPrefix: "", signature: "", attachments: [file(1), file(2)] }, "corr-size")
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, "email_attachment_size_exceeded")
    assert.equal(calls.length, 0)
  })
  for (const [respond, expected] of [
    [() => new Response("{}", { status: 422 }), "email_delivery_failed"],
    [() => new Response("{}", { status: 500 }), "delivery_uncertain"],
  ] as const) {
    await withProvider("resend", async () => {
      process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
      assert.equal((await queueOne()).attempt?.error_code, expected)
    }, respond)
  }
})
