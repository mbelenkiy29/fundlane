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
  applyCompression,
  DEFAULT_MAX_PAYLOAD_BYTES,
  encodedEmailBytes,
  encodedEmailPayloadBytes,
  getCompressSettings,
  getOutgoingDocumentBytes,
  PayloadTooLargeError,
  updateCompressSettings,
  type CompressPackageResult,
  type CompressPreviewResult,
  type CompressSettingsView,
} from "../src/lib/mca/submissions/compress"
import { GET as compressGet, PATCH as compressPatch, POST as compressPost } from "../src/app/api/mca/submissions/compress/route"
import { POST as compressPreview } from "../src/app/api/mca/submissions/compress/preview/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-compress",
  otherWorkspace: "workspace-compress-other",
  adminUser: "compress-admin-user",
  adminMember: "compress-admin-member",
  repUser: "compress-rep-user",
  repMember: "compress-rep-member",
  otherUser: "compress-other-user",
  otherMember: "compress-other-member",
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
const OVERSIZE_LIMIT = 800

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

async function bloatedPdf() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 0; index < 10; index += 1) {
    const page = pdf.addPage([612, 792])
    page.drawText("Merchant statement", { x: 48, y: 720, size: 14, font })
    page.drawText(STATEMENT_FIGURE, { x: 48, y: 400, size: 11, font })
    for (let line = 0; line < 36; line += 1) {
      page.drawText(`Statement line ${index + 1}.${line} filler for size-gated compression`, { x: 48, y: 680 - line * 14, size: 9, font })
    }
  }
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

async function pageCount(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()
}

let harborId = ""
let northwindId = ""
let dealCounter = 0
let pdfBytes = new Uint8Array()
let pdfChecksum = ""
let bloatedBytes = new Uint8Array()
let bloatedChecksum = ""

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Compress Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "compress-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "compress-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "compress-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("compress-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("compress-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("compress-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
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
  testDatabase = await createPostgresTestDatabase("submissions_compress")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  await seed()
  pdfBytes = await statementPdf()
  pdfChecksum = sha256(pdfBytes)
  bloatedBytes = await bloatedPdf()
  bloatedChecksum = sha256(bloatedBytes)
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
  await getDatabase().execute("DELETE FROM mca_compress_settings")
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

async function seedDeal(bytes = pdfBytes, filename = "statement.pdf") {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `compress-deal-${dealCounter}`,
    legalName: `Compress Merchant ${dealCounter} LLC`,
  })).deal
  const document = await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `compress-doc-${dealCounter}`,
    filename,
    mimeType: "application/pdf",
    bytes,
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

test("MIC-160: incompressible oversized package is blocked with a size report", async () => {
  const first = await seedDeal(bloatedBytes)
  const second = await seedDeal(bloatedBytes, "statement-2.pdf")
  await updateCompressSettings(actor(), { automaticEmail: true, maxPayloadBytes: OVERSIZE_LIMIT, excludedFunderIds: [] })
  const originals = [...asOriginal(first.document), ...asOriginal(second.document)]
  const encoded = encodedEmailPayloadBytes([first.document.byteLength, second.document.byteLength])
  assert.ok(encoded > OVERSIZE_LIMIT)

  await assert.rejects(
    () => applyCompression(originals, harborId),
    (error: unknown) => {
      assert.equal(error instanceof PayloadTooLargeError, true)
      const blocked = error as PayloadTooLargeError
      assert.equal(blocked.status, 413)
      assert.equal(blocked.code, "payload_too_large")
      assert.equal(blocked.report.blocked, true)
      assert.equal(blocked.report.maxPayloadBytes, OVERSIZE_LIMIT)
      assert.ok(blocked.report.encodedPayloadBytes > OVERSIZE_LIMIT)
      assert.ok(blocked.report.rawPayloadBytes >= 1)
      assert.ok(blocked.report.encodedPayloadBytes <= encoded)
      assert.equal(blocked.report.documents.length, 2)
      assert.equal(blocked.fieldErrors?.maxPayloadBytes?.[0], String(OVERSIZE_LIMIT))
      assert.equal(blocked.fieldErrors?.encodedPayloadBytes?.[0], String(blocked.report.encodedPayloadBytes))
      assert.equal(blocked.fieldErrors?.rawPayloadBytes?.[0], String(blocked.report.rawPayloadBytes))
      assert.ok(blocked.fieldErrors?.documents?.some((row) => row.includes(first.document.id) && row.includes("encoded=")))
      assert.ok(blocked.message.includes(String(OVERSIZE_LIMIT)))
      assert.ok(!blocked.message.includes("%PDF"))
      assert.ok(!blocked.message.includes(STATEMENT_FIGURE))
      for (const row of blocked.report.documents) {
        assert.ok(row.outputBytes <= row.inputBytes || row.keptPreCompress)
        assert.equal(row.encodedBytes, encodedEmailBytes(row.outputBytes))
        assert.equal(row.pageCount, 10)
        assert.ok(!row.skipped || row.skipped === "not_pdf")
      }
      return true
    },
  )

  const afterFirst = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(first.document.id)
  const afterSecond = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(second.document.id)
  assert.equal(afterFirst?.checksum, bloatedChecksum)
  assert.equal(afterSecond?.checksum, bloatedChecksum)
  assert.equal(sha256(await storage.get(`${ids.workspace}/${first.document.dealId}/${first.document.id}`)), bloatedChecksum)

  await assert.rejects(
    () => prepareOutgoingPackage({ originals, funderId: harborId }),
    (error: unknown) => error instanceof PayloadTooLargeError,
  )

  const preview = await compressPreview(cookieRequest("/api/mca/submissions/compress/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentIds: [first.document.id, second.document.id], funderId: harborId }),
  }))
  assert.equal(preview.status, 413)
  const previewBody = await preview.json() as { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(previewBody.error.code, "payload_too_large")
  assert.equal(previewBody.error.fieldErrors?.maxPayloadBytes?.[0], String(OVERSIZE_LIMIT))
  assert.ok(Number(previewBody.error.fieldErrors?.encodedPayloadBytes?.[0]) > OVERSIZE_LIMIT)
  assertNoDocumentBody(previewBody)
})

test("MIC-160: stored original checksum remains unchanged and pages stay legible", async () => {
  const { document } = await seedDeal(bloatedBytes)
  await updateCompressSettings(actor(), { automaticEmail: true, excludedFunderIds: [] })
  const before = await getDatabase().prepare<{ checksum: string; byte_length: number }>(
    "SELECT checksum, byte_length FROM mca_documents WHERE id = ?",
  ).get(document.id)
  assert.equal(before?.checksum, bloatedChecksum)
  const storedBefore = sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`))
  assert.equal(storedBefore, bloatedChecksum)

  const packaged = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packaged.originalChecksums[document.id], bloatedChecksum)
  const outgoing = packaged.documents[0]
  assert.ok(outgoing)
  assert.equal(outgoing.originalDocumentId, document.id)
  const outgoingBytes = await getOutgoingDocumentBytes(outgoing)
  assert.equal(await pageCount(outgoingBytes), 10)
  assert.equal(pdfContains(outgoingBytes, STATEMENT_FIGURE), true)
  assert.equal(pdfContains(outgoingBytes, "Page 2 landscape") || pdfContains(outgoingBytes, "Merchant statement"), true)
  assert.ok(outgoing.byteLength <= document.byteLength)
  if (outgoing.byteLength < document.byteLength) {
    assert.equal(outgoing.stage, "compress")
    assert.notEqual(outgoing.documentId, document.id)
    assert.notEqual(outgoing.checksum, bloatedChecksum)
  } else {
    assert.equal(outgoing.stage, "original")
    assert.equal(outgoing.checksum, bloatedChecksum)
  }

  const replay = await applyCompression(asOriginal(document), harborId)
  assert.equal(replay[0]?.documentId, outgoing.documentId)
  assert.equal(replay[0]?.checksum, outgoing.checksum)

  const after = await getDatabase().prepare<{ checksum: string }>("SELECT checksum FROM mca_documents WHERE id = ?").get(document.id)
  assert.equal(after?.checksum, bloatedChecksum)
  assert.equal(sha256(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`)), bloatedChecksum)
  assert.equal(pdfContains(await storage.get(`${ids.workspace}/${document.dealId}/${document.id}`), STATEMENT_FIGURE), true)
})

test("MIC-160: funder exclusion skips compression and returns the pre-compress derivative", async () => {
  const { document } = await seedDeal()
  await updateCompressSettings(actor(), { automaticEmail: true, excludedFunderIds: [northwindId] })
  const originals = asOriginal(document)
  const skipped = await applyCompression(originals, northwindId)
  assert.equal(skipped[0]?.documentId, document.id)
  assert.equal(skipped[0]?.checksum, document.checksum)
  assert.equal(skipped[0]?.stage, "original")

  const harbor = await applyCompression(originals, harborId)
  assert.ok(harbor[0])
  assert.equal(harbor[0].originalDocumentId, document.id)
  if (harbor[0].stage === "compress") {
    assert.notEqual(harbor[0].documentId, document.id)
    assert.notEqual(harbor[0].checksum, document.checksum)
    assert.ok(harbor[0].byteLength <= document.byteLength)
    const bytes = await getOutgoingDocumentBytes(harbor[0])
    assert.equal(await pageCount(bytes), 2)
    assert.equal(pdfContains(bytes, STATEMENT_FIGURE), true)
  } else {
    assert.equal(harbor[0].stage, "original")
    assert.equal(harbor[0].checksum, document.checksum)
  }

  const preview = await compressPreview(bearerRequest("/api/mca/submissions/compress/preview", "read-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: northwindId }),
  }))
  assert.equal(preview.status, 200)
  const body = await preview.json() as CompressPreviewResult
  assert.equal(body.skipped, true)
  assert.equal(body.reason, "excluded")
  assert.equal(body.originalChecksum, document.checksum)
  assert.equal(body.derivative, undefined)
  assert.equal(body.report.documents[0]?.skipped, "excluded")
  assertNoDocumentBody(body)
})

test("MIC-160: compress settings are admin-only and manual compress honors exclusions", async () => {
  const empty = await compressGet(cookieRequest("/api/mca/submissions/compress", "admin-session-token"))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as CompressSettingsView
  assert.equal(emptyBody.settings.automaticEmail, false)
  assert.equal(emptyBody.settings.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES)
  assert.deepEqual(emptyBody.settings.excludedFunderIds, [])
  assert.equal(emptyBody.canManage, true)
  assert.equal(emptyBody.settings.updatedAt, null)

  const invalid = await compressPatch(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ excludedFunderIds: "harbor" }),
  }))
  assert.equal(invalid.status, 422)
  const invalidBody = await invalid.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(invalidBody.error.code, "validation_failed")
  assert.ok(invalidBody.error.fieldErrors?.excludedFunderIds)

  const badMax = await compressPatch(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ maxPayloadBytes: 0 }),
  }))
  assert.equal(badMax.status, 422)

  const badJson = await compressPatch(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "PATCH",
    body: "{",
  }))
  assert.equal(badJson.status, 400)

  const saved = await compressPatch(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ automaticEmail: true, maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES, excludedFunderIds: [northwindId] }),
  }))
  assert.equal(saved.status, 200)
  const savedBody = await saved.json() as CompressSettingsView
  assert.equal(savedBody.settings.automaticEmail, true)
  assert.equal(savedBody.settings.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES)
  assert.deepEqual(savedBody.settings.excludedFunderIds, [northwindId])
  assertNoDocumentBody(savedBody)

  const { document } = await seedDeal(bloatedBytes)
  const disabled = await updateCompressSettings(actor(), { automaticEmail: false, excludedFunderIds: [] })
  assert.equal(disabled.settings.automaticEmail, false)
  const packagedOff = await prepareOutgoingPackage({ originals: asOriginal(document), funderId: harborId })
  assert.equal(packagedOff.documents[0]?.stage, "original")
  assert.equal(packagedOff.documents[0]?.checksum, document.checksum)

  const manual = await compressPost(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(manual.status, 200)
  const manualBody = await manual.json() as CompressPackageResult
  assert.equal(manualBody.report.blocked, false)
  assert.ok(manualBody.documents[0])
  assert.equal(manualBody.documents[0].originalDocumentId, document.id)
  assert.equal(manualBody.report.documents[0]?.pageCount, 10)
  assert.equal(manualBody.report.encodedPayloadBytes, encodedEmailBytes(manualBody.documents[0].byteLength))
  assertNoDocumentBody(manualBody)

  const replayManual = await compressPost(cookieRequest("/api/mca/submissions/compress", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(replayManual.status, 200)
  const replayBody = await replayManual.json() as CompressPackageResult
  assert.equal(replayBody.documents[0]?.documentId, manualBody.documents[0]?.documentId)
  assert.equal(replayBody.documents[0]?.checksum, manualBody.documents[0]?.checksum)
  if (manualBody.documents[0]?.stage === "compress") {
    assert.equal(replayBody.replayed, true)
  }

  await updateCompressSettings(actor(), { automaticEmail: false, excludedFunderIds: [northwindId] })
  const excludedManual = await compressPost(bearerRequest("/api/mca/submissions/compress", "write-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: northwindId }),
  }))
  assert.equal(excludedManual.status, 200)
  const excludedBody = await excludedManual.json() as CompressPackageResult
  assert.equal(excludedBody.documents[0]?.stage, "original")
  assert.equal(excludedBody.report.documents[0]?.skipped, "excluded")

  const repGet = await compressGet(cookieRequest("/api/mca/submissions/compress", "rep-session-token"))
  assert.equal(repGet.status, 403)
  assert.equal((await repGet.json() as { error: { code: string } }).error.code, "permission_denied")

  const repPatch = await compressPatch(cookieRequest("/api/mca/submissions/compress", "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ automaticEmail: false }),
  }))
  assert.equal(repPatch.status, 403)

  const intake = await compressPatch(bearerRequest("/api/mca/submissions/compress", "intake-secret", {
    method: "PATCH",
    body: JSON.stringify({ automaticEmail: false }),
  }))
  assert.equal(intake.status, 403)

  const readGet = await compressGet(bearerRequest("/api/mca/submissions/compress", "read-secret"))
  assert.equal(readGet.status, 403)

  const readPost = await compressPost(bearerRequest("/api/mca/submissions/compress", "read-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(readPost.status, 403)

  const intakePost = await compressPost(bearerRequest("/api/mca/submissions/compress", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(intakePost.status, 403)

  const missingFields = await compressPreview(cookieRequest("/api/mca/submissions/compress/preview", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({}),
  }))
  assert.equal(missingFields.status, 422)

  const otherPreview = await compressPreview(cookieRequest("/api/mca/submissions/compress/preview", "other-session-token", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(otherPreview.status, 404)

  const intakePreview = await compressPreview(bearerRequest("/api/mca/submissions/compress/preview", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ documentId: document.id, funderId: harborId }),
  }))
  assert.equal(intakePreview.status, 403)

  const stillOff = await getCompressSettings(actor())
  assert.equal(stillOff.settings.automaticEmail, false)
  assert.deepEqual(stillOff.settings.excludedFunderIds, [northwindId])
})
