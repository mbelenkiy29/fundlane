import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"
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
import { prepareOutgoingPackage } from "../src/lib/mca/submissions/package"
import {
  applyStamp,
  getOutgoingDocumentBytes,
  getStampSettings,
  stampTextForFunder,
  updateStampSettings,
  type StampPreviewResult,
  type StampSettingsView,
} from "../src/lib/mca/submissions/stamps"
import { GET as stampsGet, PATCH as stampsPatch } from "../src/app/api/mca/submissions/stamps/route"
import { POST as stampsPreview } from "../src/app/api/mca/submissions/stamps/preview/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-stamps",
  otherWorkspace: "workspace-stamps-other",
  adminUser: "stamps-admin-user",
  adminMember: "stamps-admin-member",
  repUser: "stamps-rep-user",
  repMember: "stamps-rep-member",
  otherUser: "stamps-other-user",
  otherMember: "stamps-other-member",
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

const STATEMENT_FIGURE = "Average daily balance 12,500.00"

async function statementPdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  page.drawText("Merchant statement", { x: 48, y: 720, size: 14, font })
  page.drawText(STATEMENT_FIGURE, { x: 48, y: 400, size: 11, font })
  const landscape = pdf.addPage([792, 612])
  landscape.drawText("Page 2 landscape", { x: 48, y: 560, size: 12, font })
  return new Uint8Array(await pdf.save({ useObjectStreams: false }))
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

function pdfContentHaystack(bytes: Uint8Array) {
  const buf = Buffer.from(bytes)
  let content = buf.toString("latin1")
  let pos = 0
  while (pos < buf.length) {
    const streamAt = buf.indexOf("\nstream", pos)
    if (streamAt < 0) break
    let dataStart = streamAt + 7
    if (buf[dataStart] === 13) dataStart += 1
    if (buf[dataStart] === 10) dataStart += 1
    const endAt = buf.indexOf("\nendstream", dataStart)
    if (endAt < 0) break
    const data = buf.subarray(dataStart, endAt)
    try { content += inflateSync(data).toString("latin1") } catch { /* raw or empty */ }
    pos = endAt + 10
  }
  return content.replace(/<([0-9A-Fa-f]+)>/g, (_match, hex: string) => {
    try { return Buffer.from(hex, "hex").toString("latin1") } catch { return "" }
  })
}

function pdfContains(bytes: Uint8Array, text: string) {
  return pdfContentHaystack(bytes).includes(text)
}

let harborId = ""
let northwindId = ""
let dealCounter = 0
let pdfBytes = new Uint8Array()
let pdfChecksum = ""

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Stamps Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "stamps-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "stamps-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "stamps-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("stamps-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("stamps-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("stamps-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
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
  testDatabase = await createPostgresTestDatabase("submissions_stamps")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  await seed()
  pdfBytes = await statementPdf()
  pdfChecksum = sha256(pdfBytes)
  harborId = (await createFunder(actor(), {
    idempotencyKey: "harbor-funder",
    legalName: "Harbor Capital Partners LLC",
    nickname: "Harbor",
    routes: [{ kind: "email", label: "Subs", destination: "subs@harbor.example.test", documentExceptions: [], active: true }],
  })).funder.id
  northwindId = (await createFunder(actor(), {
    idempotencyKey: "northwind-funder",
    legalName: "Northwind Funding Inc",
    nickname: "Northwind",
    routes: [{ kind: "email", label: "Subs", destination: "subs@northwind.example.test", documentExceptions: [], active: true }],
  })).funder.id
})

beforeEach(async () => {
  await getDatabase().execute("DELETE FROM mca_outgoing_derivatives")
  await getDatabase().execute("DELETE FROM mca_stamp_settings")
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

async function seedDeal() {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `stamp-deal-${dealCounter}`,
    legalName: `Stamp Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `stamp-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: pdfBytes,
    category: "statement",
    source: "test",
  })
  return { deal, document }
}

function asOriginal(document: { id: string; checksum: string; byteLength: number }) {
  return [{
    documentId: document.id,
    originalDocumentId: document.id,
    checksum: document.checksum,
    byteLength: document.byteLength,
    stage: "original" as const,
  }]
}

function assertNoDocumentBody(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes("%PDF"), false)
  assert.equal(text.includes(STATEMENT_FIGURE), false)
  assert.equal(text.includes("credentialCipher"), false)
}

test("MIC-171: two funders receive distinct correct stamps", async () => {
  const { document } = await seedDeal()
  await updateStampSettings(actor(), { enabled: true, excludedFunderIds: [] })
  const originals = asOriginal(document)
  const harbor = await applyStamp(originals, harborId)
  const northwind = await applyStamp(originals, northwindId)
  assert.equal(harbor.length, 1)
  assert.equal(northwind.length, 1)
  assert.equal(harbor[0].stage, "stamp")
  assert.equal(northwind[0].stage, "stamp")
  assert.equal(harbor[0].originalDocumentId, document.id)
  assert.equal(northwind[0].originalDocumentId, document.id)
  assert.notEqual(harbor[0].documentId, document.id)
  assert.notEqual(harbor[0].checksum, northwind[0].checksum)
  assert.notEqual(harbor[0].documentId, northwind[0].documentId)

  const harborBytes = await getOutgoingDocumentBytes(harbor[0])
  const northwindBytes = await getOutgoingDocumentBytes(northwind[0])
  assert.equal(pdfContains(harborBytes, stampTextForFunder("Harbor Capital Partners LLC")), true)
  assert.equal(pdfContains(northwindBytes, stampTextForFunder("Northwind Funding Inc")), true)
  assert.equal(pdfContains(harborBytes, "Northwind Funding Inc"), false)
  assert.equal(pdfContains(northwindBytes, "Harbor Capital Partners LLC"), false)

  const preview = await stampsPreview(cookieRequest("/api/mca/submissions/stamps/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as StampPreviewResult
  assert.equal(body.skipped, false)
  assert.equal(body.originalChecksum, document.checksum)
  assert.equal(body.derivative?.documentId, harbor[0].documentId)
  assert.equal(body.replayed, true)
  assert.equal(body.pages.length, 2)
  assert.equal(body.pages.every((page) => page.fitted), true)
  assert.equal(body.pages[0]?.page, 1)
  assert.equal(body.pages[1]?.page, 2)
  assert.ok((body.pages[0]?.stampY ?? 99) <= 48)
  assertNoDocumentBody(body)

  const replay = await applyStamp(originals, harborId)
  assert.equal(replay[0].documentId, harbor[0].documentId)
  assert.equal(replay[0].checksum, harbor[0].checksum)
})

test("MIC-171: stored original checksum remains unchanged", async () => {
  const { document } = await seedDeal()
  await updateStampSettings(actor(), { enabled: true })
  const before = await getDatabase().prepare<{ checksum: string; byte_length: number }>(
    "SELECT checksum, byte_length FROM mca_documents WHERE id = ?",
  ).get(document.id)
  assert.equal(before?.checksum, pdfChecksum)
  const storedBefore = sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`))
  assert.equal(storedBefore, pdfChecksum)

  const packaged = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packaged.originalChecksums[document.id], pdfChecksum)
  assert.equal(packaged.documents[0]?.stage, "stamp")
  assert.notEqual(packaged.documents[0]?.checksum, pdfChecksum)

  const after = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(document.id)
  assert.equal(after?.checksum, pdfChecksum)
  assert.equal(sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`)), pdfChecksum)
  assert.equal(pdfContains(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`), "Submitted to Harbor"), false)
})

test("MIC-171: funder exclusion skips stamp and returns original", async () => {
  const { document } = await seedDeal()
  await updateStampSettings(actor(), { enabled: true, excludedFunderIds: [northwindId] })
  const originals = asOriginal(document)
  const skipped = await applyStamp(originals, northwindId)
  assert.equal(skipped[0]?.documentId, document.id)
  assert.equal(skipped[0]?.checksum, document.checksum)
  assert.equal(skipped[0]?.stage, "original")

  const stamped = await applyStamp(originals, harborId)
  assert.equal(stamped[0]?.stage, "stamp")
  assert.notEqual(stamped[0]?.checksum, document.checksum)

  const preview = await stampsPreview(bearerRequest("/api/mca/submissions/stamps/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: northwindId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as StampPreviewResult
  assert.equal(body.skipped, true)
  assert.equal(body.reason, "excluded")
  assert.equal(body.originalChecksum, document.checksum)
  assert.equal(body.derivative, undefined)
  assertNoDocumentBody(body)
})

test("MIC-171: stamp settings are admin-only", async () => {
  const empty = await stampsGet(cookieRequest("/api/mca/submissions/stamps", "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as StampSettingsView
  assert.equal(emptyBody.settings.enabled, false)
  assert.deepEqual(emptyBody.settings.excludedFunderIds, [])
  assert.equal(emptyBody.canManage, true)
  assert.equal(emptyBody.settings.updatedAt, null)

  const invalid = await stampsPatch(cookieRequest("/api/mca/submissions/stamps", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ excludedFunderIds: "harbor" }),
  }))
  assert.equal(invalid.status, 422)
  const invalidBody = await invalid.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(invalidBody.error.code, "validation_failed")
  assert.ok(invalidBody.error.fieldErrors?.excludedFunderIds)

  const badJson = await stampsPatch(cookieRequest("/api/mca/submissions/stamps", "admin-session-token", {
    method: "PATCH",
    body: "{",
  }))
  assert.equal(badJson.status, 400)

  const saved = await stampsPatch(cookieRequest("/api/mca/submissions/stamps", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, excludedFunderIds: [northwindId] }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as StampSettingsView
  assert.equal(savedBody.settings.enabled, true)
  assert.deepEqual(savedBody.settings.excludedFunderIds, [northwindId])
  assert.equal(savedBody.settings.templateVersion, 1)

  const repGet = await stampsGet(cookieRequest("/api/mca/submissions/stamps", "rep-session-token"))
  assert.equal(repGet.status, 403)
  assert.equal((await repGet.json() as { error: { code: string } }).error.code, "permission_denied")

  const repPatch = await stampsPatch(cookieRequest("/api/mca/submissions/stamps", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  }))
  assert.equal(repPatch.status, 403)
  assert.equal((await repPatch.json() as { error: { code: string } }).error.code, "permission_denied")

  const intake = await stampsPatch(bearerRequest("/api/mca/submissions/stamps", "intake-secret", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  }))
  assert.equal(intake.status, 403)

  const readGet = await stampsGet(bearerRequest("/api/mca/submissions/stamps", "read-secret"))
  assert.equal(readGet.status, 403)

  const { document } = await seedDeal()
  const missingFields = await stampsPreview(cookieRequest("/api/mca/submissions/stamps/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }))
  assert.equal(missingFields.status, 422)

  const otherPreview = await stampsPreview(cookieRequest("/api/mca/submissions/stamps/preview", "other-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(otherPreview.status, 404)

  const intakePreview = await stampsPreview(bearerRequest("/api/mca/submissions/stamps/preview", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(intakePreview.status, 403)

  const stillEnabled = await getStampSettings(actor())
  assert.equal(stillEnabled.settings.enabled, true)
})
