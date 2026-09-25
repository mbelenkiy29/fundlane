import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { crc32, deflateSync, inflateSync } from "node:zlib"
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
import { stampTextForFunder } from "../src/lib/mca/submissions/stamps"
import {
  getDocumentProtectionSettings,
  updateDocumentProtectionSettings,
  type DocumentProtectionPreviewResult,
  type DocumentProtectionView,
} from "../src/lib/mca/submissions/document-protection"
import { GET as protectionGet, PATCH as protectionPatch } from "../src/app/api/mca/submissions/document-protection/route"
import { POST as protectionLogo } from "../src/app/api/mca/submissions/document-protection/logo/route"
import { POST as protectionPreview } from "../src/app/api/mca/submissions/document-protection/preview/route"
import { GET as protectionFile } from "../src/app/api/mca/submissions/document-protection/preview/file/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-doc-protect",
  otherWorkspace: "workspace-doc-protect-other",
  adminUser: "doc-protect-admin-user",
  adminMember: "doc-protect-admin-member",
  repUser: "doc-protect-rep-user",
  repMember: "doc-protect-rep-member",
  otherUser: "doc-protect-other-user",
  otherMember: "doc-protect-other-member",
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

const STATEMENT_FIGURE = "Average daily balance 12,500.00"

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function makePng(width: number, height: number, rgba: [number, number, number, number] = [16, 72, 160, 255]) {
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
      raw[i] = rgba[0]
      raw[i + 1] = rgba[1]
      raw[i + 2] = rgba[2]
      raw[i + 3] = rgba[3]
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
  page.drawText(STATEMENT_FIGURE, { x: 48, y: 400, size: 11, font })
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
let logoBytes = new Uint8Array()

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Doc Protect Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "doc-protect-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "doc-protect-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "doc-protect-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("doc-protect-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("doc-protect-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("doc-protect-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  await database.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(
    "read-key", ids.workspace, "read-key", hashOpaqueToken("mca_read-secret"), JSON.stringify(["deals:read"]), ids.adminUser, now,
  )
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_document_protection")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  await seed()
  pdfBytes = await statementPdf()
  pdfChecksum = sha256(pdfBytes)
  logoBytes = makePng(64, 64)
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
  await getDatabase().execute("DELETE FROM mca_watermark_settings")
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

async function seedDeal(category: "statement" | "application" = "statement") {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `protect-deal-${dealCounter}`,
    legalName: `Protect Merchant ${dealCounter} LLC`,
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `protect-doc-${dealCounter}`,
    filename: category === "statement" ? "statement.pdf" : "application.pdf",
    mimeType: "application/pdf",
    bytes: pdfBytes,
    category,
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
}

test("issue 74: workspace setting turns on document protection", async () => {
  const empty = await protectionGet(cookieRequest("/api/mca/submissions/document-protection", "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as DocumentProtectionView
  assert.equal(emptyBody.settings.enabled, false)
  assert.equal(emptyBody.settings.watermarkEnabled, false)
  assert.equal(emptyBody.canManage, true)

  const enabled = await protectionPatch(cookieRequest("/api/mca/submissions/document-protection", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(enabled.status, 200)
  const enabledBody = await enabled.json() as DocumentProtectionView
  assert.equal(enabledBody.settings.enabled, true)
  assert.equal(enabledBody.settings.stampEnabled, true)
  assert.equal(enabledBody.settings.watermarkEnabled, false)
  assert.equal(enabledBody.settings.hasLogo, false)

  const saved = await getDocumentProtectionSettings(actor())
  assert.equal(saved.settings.enabled, true)
})

test("issue 74: outgoing statements are stamped with the destination funder name", async () => {
  const { document } = await seedDeal()
  await updateDocumentProtectionSettings(actor(), { enabled: true })
  const harbor = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  const northwind = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: northwindId })
  assert.equal(harbor.documents[0]?.stage, "stamp")
  assert.equal(northwind.documents[0]?.stage, "stamp")
  assert.notEqual(harbor.documents[0]?.checksum, northwind.documents[0]?.checksum)

  const harborKey = `${ids.workspace}/derivatives/stamp/${harbor.documents[0]!.documentId}`
  const northwindKey = `${ids.workspace}/derivatives/stamp/${northwind.documents[0]!.documentId}`
  assert.equal(pdfContains(await storage.get(harborKey), stampTextForFunder("Harbor Capital Partners LLC")), true)
  assert.equal(pdfContains(await storage.get(northwindKey), stampTextForFunder("Northwind Funding Inc")), true)
  assert.equal(pdfContains(await storage.get(harborKey), "Northwind Funding Inc"), false)
})

test("issue 74: shop logo upload watermarks outgoing statement copies", async () => {
  const { document } = await seedDeal()
  const uploaded = await protectionLogo(cookieRequest("/api/mca/submissions/document-protection/logo", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      filename: "shop-logo.png",
      mimeType: "image/png",
      base64: Buffer.from(logoBytes).toString("base64"),
    }),
  }))
  assert.equal(uploaded.status, 200)
  const uploadedBody = await uploaded.json() as DocumentProtectionView
  assert.equal(uploadedBody.settings.hasLogo, true)
  assert.equal(uploadedBody.settings.watermarkEnabled, false)

  const enabled = await protectionPatch(cookieRequest("/api/mca/submissions/document-protection", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal((await enabled.json() as DocumentProtectionView).settings.watermarkEnabled, true)

  const packaged = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packaged.documents[0]?.stage, "watermark")
  const watermarkKey = `${ids.workspace}/derivatives/watermark/${packaged.documents[0]!.documentId}`
  const watermarkBytes = await storage.get(watermarkKey)
  assert.equal(pdfContains(watermarkBytes, stampTextForFunder("Harbor Capital Partners LLC")), true)
  const parsed = await PDFDocument.load(watermarkBytes)
  assert.equal(parsed.getPages().length, 1)
})

test("issue 74: stored originals stay unmodified", async () => {
  const { document } = await seedDeal()
  await updateDocumentProtectionSettings(actor(), { enabled: true })
  await protectionLogo(cookieRequest("/api/mca/submissions/document-protection/logo", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      filename: "shop-logo.png",
      mimeType: "image/png",
      base64: Buffer.from(logoBytes).toString("base64"),
    }),
  }))
  const originalKey = `${ids.workspace}/${document.dealId}/${document.id}`
  assert.equal(sha256(await storage.get(originalKey)), pdfChecksum)

  const packaged = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packaged.originalChecksums[document.id], pdfChecksum)
  assert.notEqual(packaged.documents[0]?.checksum, pdfChecksum)
  assert.equal(packaged.documents[0]?.originalDocumentId, document.id)

  const after = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(document.id)
  assert.equal(after?.checksum, pdfChecksum)
  assert.equal(sha256(await storage.get(originalKey)), pdfChecksum)
  assert.equal(pdfContains(await storage.get(originalKey), "Submitted to Harbor"), false)
})

test("issue 74: reps can preview a stamped copy before sending", async () => {
  const { document } = await seedDeal()
  await updateDocumentProtectionSettings(actor(), { enabled: true })
  const preview = await protectionPreview(cookieRequest("/api/mca/submissions/document-protection/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as DocumentProtectionPreviewResult
  assert.equal(body.skipped, false)
  assert.equal(body.stampText, stampTextForFunder("Harbor Capital Partners LLC"))
  assert.equal(body.originalChecksum, document.checksum)
  assert.equal(body.watermarkApplied, false)
  assert.ok(body.downloadPath?.includes(document.id))
  assert.ok(body.downloadPath?.includes(harborId))
  assertNoDocumentBody(body)

  const file = await protectionFile(cookieRequest(
    `/api/mca/submissions/document-protection/preview/file?documentId=${encodeURIComponent(document.id)}&funderId=${encodeURIComponent(harborId)}`,
    "rep-session-token",
  ))
  assert.equal(file.status, 200)
  assert.equal(file.headers.get("content-type"), "application/pdf")
  const bytes = new Uint8Array(await file.arrayBuffer())
  assert.equal(pdfContains(bytes, stampTextForFunder("Harbor Capital Partners LLC")), true)
  assert.equal(pdfContains(bytes, STATEMENT_FIGURE), true)
})

test("issue 74: previews skip non-statements and disabled workspaces", async () => {
  const { document: application } = await seedDeal("application")
  await updateDocumentProtectionSettings(actor(), { enabled: true })
  const skipped = await protectionPreview(cookieRequest("/api/mca/submissions/document-protection/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: application.id, funderId: harborId }),
  }))
  assert.equal(skipped.status, 200)
  assert.equal((await skipped.json() as DocumentProtectionPreviewResult).reason, "not_statement")

  await updateDocumentProtectionSettings(actor(), { enabled: false })
  const { document: statement } = await seedDeal()
  const disabled = await protectionPreview(cookieRequest("/api/mca/submissions/document-protection/preview", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: statement.id, funderId: harborId }),
  }))
  const disabledBody = await disabled.json() as DocumentProtectionPreviewResult
  assert.equal(disabledBody.skipped, true)
  assert.equal(disabledBody.reason, "disabled")
})

test("issue 74: settings writes are admin-only and previews stay workspace-scoped", async () => {
  const repPatch = await protectionPatch(cookieRequest("/api/mca/submissions/document-protection", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true }),
  }))
  assert.equal(repPatch.status, 403)

  const repLogo = await protectionLogo(cookieRequest("/api/mca/submissions/document-protection/logo", "rep-session-token", {
    method: "POST",
    body: JSON.stringify({ filename: "logo.png", mimeType: "image/png", base64: Buffer.from(logoBytes).toString("base64") }),
  }))
  assert.equal(repLogo.status, 403)

  const repGet = await protectionGet(cookieRequest("/api/mca/submissions/document-protection", "rep-session-token"))
  assert.equal(repGet.status, 200)
  assert.equal((await repGet.json() as DocumentProtectionView).canManage, false)

  const { document } = await seedDeal()
  const other = await protectionPreview(cookieRequest("/api/mca/submissions/document-protection/preview", "other-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(other.status, 404)

  const readPreview = await protectionPreview(bearerRequest("/api/mca/submissions/document-protection/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(readPreview.status, 200)

  const missing = await protectionFile(cookieRequest("/api/mca/submissions/document-protection/preview/file", "rep-session-token"))
  assert.equal(missing.status, 422)
})
