import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { crc32, deflateSync, inflateSync } from "node:zlib"
import { PDFDocument, StandardFonts, degrees } from "pdf-lib"
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
import { applyStamp, updateStampSettings } from "../src/lib/mca/submissions/stamps"
import {
  applyWatermark,
  CONTENT_INSET,
  getOutgoingDocumentBytes,
  getWatermarkSettings,
  updateWatermarkSettings,
  WATERMARK_OPACITY,
  type WatermarkPreviewResult,
  type WatermarkSettingsView,
} from "../src/lib/mca/submissions/watermarks"
import { GET as watermarksGet, PATCH as watermarksPatch } from "../src/app/api/mca/submissions/watermarks/route"
import { POST as watermarksPreview } from "../src/app/api/mca/submissions/watermarks/preview/route"
import { POST as watermarksLogo } from "../src/app/api/mca/submissions/watermarks/logo/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-watermarks",
  otherWorkspace: "workspace-watermarks-other",
  adminUser: "watermarks-admin-user",
  adminMember: "watermarks-admin-member",
  repUser: "watermarks-rep-user",
  repMember: "watermarks-rep-member",
  otherUser: "watermarks-other-user",
  otherMember: "watermarks-other-member",
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
const LOGO_SECRET = "secret-api-key"

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function makePng(width: number, height: number, rgba: [number, number, number, number] = [16, 72, 160, 255], text?: string) {
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
  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
  ]
  if (text) parts.push(pngChunk("tEXt", Buffer.from(`Comment\0${text}`)))
  parts.push(pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(parts))
}

async function statementPdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])
  page.drawText("Merchant statement", { x: 48, y: 720, size: 14, font })
  page.drawText(STATEMENT_FIGURE, { x: 48, y: 400, size: 11, font })
  const landscape = pdf.addPage([792, 612])
  landscape.drawText("Page 2 landscape", { x: 48, y: 560, size: 12, font })
  const rotated = pdf.addPage([612, 792])
  rotated.setRotation(degrees(90))
  rotated.drawText("Rotated statement", { x: 48, y: 400, size: 12, font })
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
let wideLogoBytes = new Uint8Array()
let logoDocumentId = ""
let wideLogoDocumentId = ""

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Watermarks Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "watermarks-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "watermarks-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "watermarks-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("watermarks-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("watermarks-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("watermarks-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
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
  testDatabase = await createPostgresTestDatabase("submissions_watermarks")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  await seed()
  pdfBytes = await statementPdf()
  pdfChecksum = sha256(pdfBytes)
  logoBytes = makePng(64, 64, [16, 72, 160, 255], LOGO_SECRET)
  wideLogoBytes = makePng(800, 40, [180, 40, 40, 255])
  const branding = (await createDeal(actor(), {
    idempotencyKey: "watermark-branding-deal",
    legalName: "Watermark Branding LLC",
  })).deal
  logoDocumentId = (await storeDocument(actor(), {
    dealId: branding.id,
    idempotencyKey: "watermark-logo",
    filename: "broker-logo.png",
    mimeType: "image/png",
    bytes: logoBytes,
    category: "other_stip",
    source: "test",
  })).id
  wideLogoDocumentId = (await storeDocument(actor(), {
    dealId: branding.id,
    idempotencyKey: "watermark-wide-logo",
    filename: "wide-logo.png",
    mimeType: "image/png",
    bytes: wideLogoBytes,
    category: "other_stip",
    source: "test",
  })).id
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
  await getDatabase().prepare("UPDATE workspaces SET logo_url = NULL WHERE id = ?").run(ids.workspace)
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
    idempotencyKey: `watermark-deal-${dealCounter}`,
    legalName: `Watermark Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `watermark-doc-${dealCounter}`,
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
  assert.equal(text.includes(LOGO_SECRET), false)
}

function assertCornerPlacement(page: WatermarkPreviewResult["pages"][number]) {
  assert.equal(page.opacity, WATERMARK_OPACITY)
  assert.ok(page.opacity <= 0.25)
  assert.equal(page.corner, "bottom-right")
  assert.ok(page.inset <= CONTENT_INSET)
  assert.ok(page.watermarkX >= page.inset)
  assert.ok(page.watermarkY >= page.inset)
  assert.ok(page.watermarkX + page.watermarkWidth <= page.width - page.inset + 0.001)
  assert.ok(page.watermarkY + page.watermarkHeight <= page.height - page.inset + 0.001)
  assert.ok(page.watermarkWidth <= page.width * 0.25 + 0.001)
  assert.ok(page.watermarkX > 48)
}

test("MIC-162: funder exclusion sends original or allowed prior derivative", async () => {
  const { document } = await seedDeal()
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId, excludedFunderIds: [northwindId] })
  const originals = asOriginal(document)

  const skipped = await applyWatermark(originals, northwindId)
  assert.equal(skipped[0]?.documentId, document.id)
  assert.equal(skipped[0]?.checksum, document.checksum)
  assert.equal(skipped[0]?.stage, "original")

  const watermarked = await applyWatermark(originals, harborId)
  assert.equal(watermarked[0]?.stage, "watermark")
  assert.notEqual(watermarked[0]?.checksum, document.checksum)
  assert.notEqual(watermarked[0]?.documentId, document.id)
  const harborBytes = await getOutgoingDocumentBytes(watermarked[0])
  assert.equal(pdfContains(harborBytes, STATEMENT_FIGURE), true)
  assert.equal(pdfContains(harborBytes, LOGO_SECRET), false)

  const preview = await watermarksPreview(bearerRequest("/api/mca/submissions/watermarks/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: northwindId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as WatermarkPreviewResult
  assert.equal(body.skipped, true)
  assert.equal(body.reason, "excluded")
  assert.equal(body.originalChecksum, document.checksum)
  assert.equal(body.derivative, undefined)
  assertNoDocumentBody(body)

  await updateStampSettings(actor(), { enabled: true, excludedFunderIds: [] })
  const stampedNorthwind = await applyStamp(originals, northwindId)
  assert.equal(stampedNorthwind[0]?.stage, "stamp")
  const watermarkSkipKeepsStamp = await applyWatermark(stampedNorthwind, northwindId)
  assert.equal(watermarkSkipKeepsStamp[0]?.stage, "stamp")
  assert.equal(watermarkSkipKeepsStamp[0]?.documentId, stampedNorthwind[0]?.documentId)
  assert.equal(watermarkSkipKeepsStamp[0]?.checksum, stampedNorthwind[0]?.checksum)

  await updateStampSettings(actor(), { enabled: true, excludedFunderIds: [harborId] })
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId, excludedFunderIds: [] })
  const stampSkipped = await applyStamp(originals, harborId)
  assert.equal(stampSkipped[0]?.stage, "original")
  const watermarkFromOriginal = await applyWatermark(stampSkipped, harborId)
  assert.equal(watermarkFromOriginal[0]?.stage, "watermark")
  assert.notEqual(watermarkFromOriginal[0]?.checksum, document.checksum)
})

test("MIC-162: stored original checksum remains unchanged", async () => {
  const { document } = await seedDeal()
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId })
  const before = await getDatabase().prepare<{ checksum: string; byte_length: number }>(
    "SELECT checksum, byte_length FROM mca_documents WHERE id = ?",
  ).get(document.id)
  assert.equal(before?.checksum, pdfChecksum)
  const storedBefore = sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`))
  assert.equal(storedBefore, pdfChecksum)

  const packaged = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packaged.originalChecksums[document.id], pdfChecksum)
  assert.equal(packaged.documents[0]?.stage, "watermark")
  assert.notEqual(packaged.documents[0]?.checksum, pdfChecksum)
  assert.equal(pdfContains(await getOutgoingDocumentBytes(packaged.documents[0]), STATEMENT_FIGURE), true)

  const after = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(document.id)
  assert.equal(after?.checksum, pdfChecksum)
  assert.equal(sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`)), pdfChecksum)
  assert.equal(pdfContains(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`), STATEMENT_FIGURE), true)
})

test("MIC-162: wide logo and landscape/rotated pages keep a 48pt content inset", async () => {
  const { document } = await seedDeal()
  await updateWatermarkSettings(actor(), { enabled: true, logoDocumentId: wideLogoDocumentId })
  const preview = await watermarksPreview(cookieRequest("/api/mca/submissions/watermarks/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as WatermarkPreviewResult
  assert.equal(body.skipped, false)
  assert.equal(body.pages.length, 3)
  assert.equal(body.pages.every((page) => page.fitted), true)
  assert.equal(body.pages[0]?.page, 1)
  assert.equal(body.pages[1]?.width, 792)
  assert.equal(body.pages[1]?.height, 612)
  assert.equal(body.pages[2]?.rotation, 90)
  for (const page of body.pages) {
    assertCornerPlacement(page)
    assert.ok(page.watermarkWidth <= page.width - CONTENT_INSET * 2 + 0.001)
  }
  assert.ok((body.pages[1]?.watermarkWidth ?? 999) < 800)
  assertNoDocumentBody(body)

  const applied = await applyWatermark(asOriginal(document), harborId)
  const bytes = await getOutgoingDocumentBytes(applied[0])
  assert.equal(pdfContains(bytes, STATEMENT_FIGURE), true)
  assert.equal(pdfContains(bytes, "Page 2 landscape"), true)
})

test("MIC-162: watermark settings are admin-only and branding changes invalidate cache", async () => {
  const empty = await watermarksGet(cookieRequest("/api/mca/submissions/watermarks", "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as WatermarkSettingsView
  assert.equal(emptyBody.settings.enabled, false)
  assert.equal(emptyBody.settings.logoDocumentId, null)
  assert.deepEqual(emptyBody.settings.excludedFunderIds, [])
  assert.equal(emptyBody.canManage, true)
  assert.equal(emptyBody.settings.updatedAt, null)
  assert.equal(emptyBody.settings.logoSource, "none")

  const invalid = await watermarksPatch(cookieRequest("/api/mca/submissions/watermarks", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ excludedFunderIds: "harbor" }),
  }))
  assert.equal(invalid.status, 422)
  const invalidBody = await invalid.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(invalidBody.error.code, "validation_failed")
  assert.ok(invalidBody.error.fieldErrors?.excludedFunderIds)

  const badJson = await watermarksPatch(cookieRequest("/api/mca/submissions/watermarks", "admin-session-token", {
    method: "PATCH",
    body: "{",
  }))
  assert.equal(badJson.status, 400)

  const saved = await watermarksPatch(cookieRequest("/api/mca/submissions/watermarks", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: true, logoDocumentId, excludedFunderIds: [northwindId] }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as WatermarkSettingsView
  assert.equal(savedBody.settings.enabled, true)
  assert.equal(savedBody.settings.logoDocumentId, logoDocumentId)
  assert.deepEqual(savedBody.settings.excludedFunderIds, [northwindId])
  assert.equal(savedBody.settings.templateVersion, 1)
  assert.equal(savedBody.settings.logoSource, "document")
  assertNoDocumentBody(savedBody)

  const { document } = await seedDeal()
  const first = await applyWatermark(asOriginal(document), harborId)
  assert.equal(first[0]?.stage, "watermark")
  const replay = await applyWatermark(asOriginal(document), harborId)
  assert.equal(replay[0]?.documentId, first[0]?.documentId)
  assert.equal(replay[0]?.checksum, first[0]?.checksum)

  const previewReplay = await watermarksPreview(cookieRequest("/api/mca/submissions/watermarks/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(previewReplay.status, 200)
  const previewBody = await previewReplay.json() as WatermarkPreviewResult
  assert.equal(previewBody.replayed, true)
  assert.equal(previewBody.derivative?.documentId, first[0]?.documentId)
  assert.equal(previewBody.originalChecksum, document.checksum)
  assertNoDocumentBody(previewBody)

  const logoUpload = await watermarksLogo(cookieRequest("/api/mca/submissions/watermarks/logo", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      filename: "uploaded-logo.png",
      mimeType: "image/png",
      base64: Buffer.from(wideLogoBytes).toString("base64"),
    }),
  }))
  assert.equal(logoUpload.status, 200)
  const uploaded = await logoUpload.json() as WatermarkSettingsView
  assert.equal(uploaded.settings.templateVersion, 2)
  assert.notEqual(uploaded.settings.logoDocumentId, logoDocumentId)
  assert.equal(uploaded.settings.enabled, true)
  assertNoDocumentBody(uploaded)

  const afterBranding = await applyWatermark(asOriginal(document), harborId)
  assert.equal(afterBranding[0]?.stage, "watermark")
  assert.notEqual(afterBranding[0]?.documentId, first[0]?.documentId)
  assert.notEqual(afterBranding[0]?.checksum, first[0]?.checksum)

  const attachExisting = await watermarksLogo(cookieRequest("/api/mca/submissions/watermarks/logo", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: logoDocumentId }),
  }))
  assert.equal(attachExisting.status, 200)
  assert.equal((await attachExisting.json() as WatermarkSettingsView).settings.templateVersion, 3)

  const dataUri = `data:image/png;base64,${Buffer.from(logoBytes).toString("base64")}`
  await getDatabase().prepare("UPDATE workspaces SET logo_url = ? WHERE id = ?").run(dataUri, ids.workspace)
  await watermarksPatch(cookieRequest("/api/mca/submissions/watermarks", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ logoDocumentId: null }),
  }))
  const fallback = await getWatermarkSettings(actor())
  assert.equal(fallback.settings.logoDocumentId, null)
  assert.equal(fallback.settings.logoSource, "workspace")
  const workspaceLogo = await applyWatermark(asOriginal(document), harborId)
  assert.equal(workspaceLogo[0]?.stage, "watermark")

  const repGet = await watermarksGet(cookieRequest("/api/mca/submissions/watermarks", "rep-session-token"))
  assert.equal(repGet.status, 403)
  assert.equal((await repGet.json() as { error: { code: string } }).error.code, "permission_denied")

  const repPatch = await watermarksPatch(cookieRequest("/api/mca/submissions/watermarks", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  }))
  assert.equal(repPatch.status, 403)

  const intake = await watermarksPatch(bearerRequest("/api/mca/submissions/watermarks", "intake-secret", {
    method: "PATCH",
    body: JSON.stringify({ enabled: false }),
  }))
  assert.equal(intake.status, 403)

  const readGet = await watermarksGet(bearerRequest("/api/mca/submissions/watermarks", "read-secret"))
  assert.equal(readGet.status, 403)

  const missingFields = await watermarksPreview(cookieRequest("/api/mca/submissions/watermarks/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }))
  assert.equal(missingFields.status, 422)

  const otherPreview = await watermarksPreview(cookieRequest("/api/mca/submissions/watermarks/preview", "other-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(otherPreview.status, 404)

  const intakePreview = await watermarksPreview(bearerRequest("/api/mca/submissions/watermarks/preview", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(intakePreview.status, 403)

  const stillEnabled = await getWatermarkSettings(actor())
  assert.equal(stillEnabled.settings.enabled, true)
})
