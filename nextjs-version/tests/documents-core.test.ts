import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { PDFDocument } from "pdf-lib"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createDeal, getDealForDocument } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { DocumentStorage } from "../src/lib/mca/documents/storage"
import { setDocumentStorageForTests } from "../src/lib/mca/documents/storage"
import type { DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentScannerForTests } from "../src/lib/mca/documents/scanner"
import type { DocumentExtractionProvider } from "../src/lib/mca/documents/extraction"
import { OpenAiDocumentExtractionProvider, setDocumentExtractionProviderForTests } from "../src/lib/mca/documents/extraction"
import { requireDocumentActor } from "../src/lib/mca/documents/http"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import {
  categorizeDocument, createDocumentDownloadToken, getDocument, getDocumentContent, listDocuments, retryDocumentScan,
  storeDocument, suggestStatementFilename,
} from "../src/lib/mca/documents/service"
import { generateApplicationPdf, recordMerchantAuthorization, renderApplicationPdf } from "../src/lib/mca/documents/pdf"
import { confirmApplicationScan, reviewApplicationMerge, saveApplicationReview, scanApplicationDocument } from "../src/lib/mca/documents/application-scan"
import { applyStatementFilename, previewStatementFilename } from "../src/lib/mca/documents/statement-filenames"
import { confirmApplicationDraft, createApplicationDraft, extractApplicationDraft, getApplicationDraft, retryApplicationDraftScan } from "../src/lib/mca/documents/application-drafts"
import { claimApplicationConfirmation, completeApplicationConfirmation } from "../src/lib/mca/documents/repository"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const temp = mkdtempSync(join(tmpdir(), "mca-documents-"))
delete process.env.MCA_DOCUMENT_SCANNER
let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const actor = (workspaceId = "workspace-docs"): DealActor => ({ workspaceId, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: `corr-${workspaceId}` })
const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) { if (memory.has(key)) throw new Error("duplicate storage key"); memory.set(key, new Uint8Array(bytes)) },
  async get(key) { const value = memory.get(key); if (!value) throw new Error("missing storage key"); return new Uint8Array(value) },
}
const scanner = (status: "clean" | "infected" | "error"): DocumentScanner => ({ name: `fixture-${status}`, async scan() { return status === "clean" ? { status, provider: `fixture-${status}`, evidence: { engineVerified: true } } : status === "infected" ? { status, provider: `fixture-${status}`, evidence: { signatureDetected: true } } : { status, provider: `fixture-${status}`, evidence: { reason: "fixture_error" } } } })
let providerLegalName = "Extracted Bakery LLC"
const provider: DocumentExtractionProvider = {
  name: "fixture-ai",
  async extractApplication() { return { version: 1, fields: { legalName: providerLegalName, contactEmail: "merchant@example.test", owners: [{ firstName: "Mira", lastName: "Chen", isPrimary: true }] }, evidence: { legalName: { confidence: 0.99, page: 1, text: providerLegalName }, "owners.0.identityLast4": { confidence: 0, page: 1, unknown: true } }, warnings: ["Owner SSN was not present and remains unknown."], provider: "fixture-ai", requestId: "fixture-request" } },
  async suggestFieldMapping() { return { mapping: { Company: "legalName" }, confidence: { Company: 0.98 }, warnings: [], provider: "fixture-ai" } },
  async extractStatementMetadata() { return { bankLabel: { value: "Harbor National Bank", confidence: 0.98, page: 1 }, statementMonth: { value: "2026-08", confidence: 0.94, page: 1 }, accountSuffix: { value: "6789", confidence: 0.9, page: 1 }, warnings: [], provider: "fixture-ai", requestId: "statement-fixture" } },
}

async function addWorkspace(id: string) {
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
}

let stagingDealId = ""
before(async () => {
  testDatabase = await createPostgresTestDatabase("documents_core")
  process.env.DATABASE_URL = testDatabase.databaseUrl
  setDocumentStorageForTests(storage)
  setDocumentExtractionProviderForTests(provider)
  await addWorkspace("workspace-docs"); await addWorkspace("workspace-other")
  const now = new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES ('fixture-user','fixture-user@example.test',NULL,'Fixture User',NULL,'FIXTURE-USER',?,?)`).run(now, now)
  stagingDealId = (await createDeal(actor(), { idempotencyKey: "staging", legalName: "Scan staging" })).deal.id
})
beforeEach(() => { providerLegalName = "Extracted Bakery LLC" })
after(async () => {
  setDocumentStorageForTests(); setDocumentScannerForTests(); setDocumentExtractionProviderForTests(); await closeDatabaseForTests(); await testDatabase.close(); rmSync(temp, { recursive: true, force: true })
})

const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))

test("MIC-169 vault fails closed, retries real scan state, keeps versions, and binds download tokens", async () => {
  setDocumentScannerForTests(undefined)
  const pending = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "vault-1", filename: "original.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })
  assert.equal(pending.processingState, "pending_scan")
  assert.equal((await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "vault-1", filename: "retry.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "statement", source: "test" })).id, pending.id)
  await assert.rejects(() => getDocumentContent(actor(), pending.id), (error: { code?: string }) => error.code === "document_not_clean")
  setDocumentScannerForTests(scanner("clean"))
  assert.equal((await retryDocumentScan(actor(), pending.id)).processingState, "clean")
  const token = await createDocumentDownloadToken(actor(), pending.id, 1_000)
  assert.equal(new Date(token.expiresAt).getTime(), 301_000)
  await assert.rejects(() => createDocumentDownloadToken(actor("workspace-other"), pending.id), (error: { code?: string }) => error.code === "document_not_found")
  const version2 = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "vault-2", filename: "new.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.5\n%%EOF\n")), category: "statement", source: "test", sourceReference: `document-version:${pending.id}` })
  assert.equal(version2.version, 2)
  assert.equal((await listDocuments(actor(), stagingDealId)).length >= 2, true)
  await assert.rejects(() => storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "bad-magic", filename: "image.png", mimeType: "image/png", bytes: minimalPdf, category: "other_stip", source: "test" }), (error: { code?: string }) => error.code === "document_content_mismatch")
  setDocumentScannerForTests(scanner("infected"))
  const infected = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "infected", filename: "infected.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.6\n%%EOF\n")), category: "other_stip", source: "test" })
  assert.equal(infected.processingState, "quarantined")
  await assert.rejects(() => getDocumentContent(actor(), infected.id), (error: { code?: string }) => error.code === "document_not_clean")
})

test("MIC-169 atomically reserves uploads, recovers lost responses, and preserves version lineage across category correction", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const key = "concurrent-replay"
  const input = { dealId: stagingDealId, idempotencyKey: key, filename: "race.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\nrace\n%%EOF\n")), category: "other_stip" as const, source: "test" }
  const [first, replay] = await Promise.all([storeDocument(actor(), input), storeDocument(actor(), input)])
  assert.equal(first.id, replay.id)
  assert.equal((await getDatabase().prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_documents WHERE workspace_id = ? AND idempotency_key = ?").get(actor().workspaceId, key))!.count, 1)

  const base = await storeDocument(actor(), { ...input, idempotencyKey: "lineage-base", filename: "lineage.pdf" })
  const versionInput = (keyValue: string) => ({ ...input, idempotencyKey: keyValue, filename: `${keyValue}.pdf`, sourceReference: `document-version:${base.id}` })
  const versions = await Promise.allSettled([storeDocument(actor(), versionInput("lineage-v2-a")), storeDocument(actor(), versionInput("lineage-v2-b"))])
  assert.equal(versions.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(versions.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "version_source_stale").length, 1)
  const child = versions.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof storeDocument>>> => result.status === "fulfilled")!.value
  assert.equal(child.version, 2)
  await categorizeDocument(actor(), base.id, "statement")
  assert.equal((await getDocument(actor(), base.id)).version, 1)
  assert.equal((await getDocument(actor(), child.id)).previousDocumentId, base.id)
  assert.equal((await getDocument(actor(), child.id)).category, "other_stip")

  const interruptedKey = "interrupted-storage"
  setDocumentStorageForTests({ name: "interrupt-on-write", async get() { throw new Error("missing") }, async putImmutable() { throw new Error("interrupted") } })
  await assert.rejects(() => storeDocument(actor(), { ...input, idempotencyKey: interruptedKey, filename: "interrupted.pdf" }))
  const reservation = await getDatabase().prepare<{ id: string; state: string }>("SELECT id, processing_state AS state FROM mca_documents WHERE workspace_id = ? AND idempotency_key = ?").get(actor().workspaceId, interruptedKey) as { id: string; state: string }
  assert.equal(reservation.state, "scan_failed")
  setDocumentStorageForTests(storage)
  const recovered = await storeDocument(actor(), { ...input, idempotencyKey: interruptedKey, filename: "interrupted.pdf" })
  assert.equal(recovered.id, reservation.id)
  assert.equal(recovered.processingState, "clean")
})

test("MIC-169 direct document access requires the exact read or write API scope", async () => {
  const now = new Date().toISOString()
  const addKey = (id: string, secret: string, scopes: string[]) => getDatabase().prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, 'workspace-docs', ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, 'fixture-user', ?)`).run(id, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), now)
  await addKey("read-key", "read-secret", ["deals:read"]); await addKey("write-key", "write-secret", ["deals:write"]); await addKey("intake-key", "intake-secret", ["intake:write"])
  const request = (secret: string) => new Request("http://localhost/api/mca/documents", { headers: { authorization: `Bearer mca_${secret}` } })
  assert.equal((await requireDocumentActor(request("read-secret"), "read")).workspaceId, "workspace-docs")
  assert.equal((await requireDocumentActor(request("write-secret"), "write")).workspaceId, "workspace-docs")
  await assert.rejects(() => requireDocumentActor(request("intake-secret"), "read"), (error: { code?: string }) => error.code === "scope_required")
  await assert.rejects(() => requireDocumentActor(request("intake-secret"), "write"), (error: { code?: string }) => error.code === "scope_required")
})

test("MIC-193 redacted PDF excludes real contact text and metadata; signed generation requires recorded authorization", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const deal = await getDealForDocument(actor(), stagingDealId)
  const withContact = { ...deal, contactName: "Secret Merchant", contactEmail: "real-contact@example.test", contactPhone: "2125559999" }
  const redacted = await renderApplicationPdf(withContact, { contactMode: "redacted", signedOnBehalf: false })
  const parsed = await PDFDocument.load(redacted)
  assert.equal(parsed.getTitle(), "Merchant Funding Application")
  assert.equal([parsed.getTitle(), parsed.getSubject(), parsed.getAuthor(), parsed.getKeywords()].join(" ").includes("real-contact@example.test"), false)
  const pdfPath = join(temp, "redacted.pdf"), textPath = join(temp, "redacted.txt")
  writeFileSync(pdfPath, redacted)
  const extracted = spawnSync("pdftotext", [pdfPath, textPath])
  if (extracted.status === 0) {
    const text = readFileSync(textPath, "utf8")
    assert.match(text, /REDACTED/)
    assert.equal(text.includes("real-contact@example.test"), false)
    assert.equal(text.includes("2125559999"), false)
  }
  await assert.rejects(() => generateApplicationPdf(actor(), { dealId: stagingDealId, idempotencyKey: "signed-no-auth", contactMode: "omitted", signedOnBehalf: true }), (error: { code?: string }) => error.code === "merchant_authorization_required")
  const authorization = await recordMerchantAuthorization(actor(), { dealId: stagingDealId, merchantName: "Scan staging", authorizationReference: "recorded-call-2026-09-08" })
  const generated = await generateApplicationPdf(actor(), { dealId: stagingDealId, idempotencyKey: "signed-authorized", contactMode: "omitted", signedOnBehalf: true })
  assert.equal(generated.authorizationId, authorization.id)
  assert.equal(generated.document.category, "api_application")
  const replay = await generateApplicationPdf(actor(), { dealId: stagingDealId, idempotencyKey: "signed-authorized", contactMode: "omitted", signedOnBehalf: true })
  assert.equal(replay.document.id, generated.document.id)
  assert.equal(replay.replayed, true)
})

test("MIC-193 paginates every owner and wraps long content without silent loss", async () => {
  const deal = await getDealForDocument(actor(), stagingDealId)
  const tail = "VISIBLE-END-MARKER"
  const bytes = await renderApplicationPdf({ ...deal, legalName: `${"Long merchant legal name ".repeat(18)}${tail}`, owners: Array.from({ length: 7 }, (_, index) => ({ id: `owner-${index}`, firstName: `Owner${index + 1}`, lastName: `Surname${index + 1}`, ownershipPercent: 10, email: `owner${index + 1}@example.test` })) }, { contactMode: "real", signedOnBehalf: false })
  const parsed = await PDFDocument.load(bytes)
  assert.ok(parsed.getPageCount() > 1)
  const pdfPath = join(temp, "owners.pdf"), textPath = join(temp, "owners.txt"); writeFileSync(pdfPath, bytes)
  const extracted = spawnSync("pdftotext", [pdfPath, textPath])
  if (extracted.status === 0) { const text = readFileSync(textPath, "utf8"); assert.match(text, /Owner7 Surname7/); assert.match(text, new RegExp(tail)); assert.match(text, /Page 2 of/) }
})

test("MIC-182 rescans preserve approved edits, missing SSN stays unknown, and merge conflicts require review", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const uploaded = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "application-source", filename: "merchant-application.pdf", mimeType: "application/pdf", bytes: minimalPdf, category: "application", source: "test" })
  const first = await scanApplicationDocument(actor(), uploaded.id)
  assert.equal(first.evidence["owners.0.identityLast4"].unknown, true)
  assert.equal(first.fields.owners?.[0].identityLast4, undefined)
  await saveApplicationReview(actor(), first.id, { legalName: "Human Approved Bakery LLC" })
  providerLegalName = "Different Model Guess LLC"
  const rescanned = await scanApplicationDocument(actor(), uploaded.id)
  assert.equal(rescanned.fields.legalName, "Human Approved Bakery LLC")
  const created = await confirmApplicationScan(actor(), { extractionId: rescanned.id, confirmationId: "confirm-create-1", mode: "create" })
  assert.equal(created.deal.legalName, "Human Approved Bakery LLC")
  assert.notEqual(created.sourceDocumentId, uploaded.id)
  assert.equal((await confirmApplicationScan(actor(), { extractionId: rescanned.id, confirmationId: "confirm-create-1", mode: "create" })).replayed, true)

  providerLegalName = "Conflict Winner LLC"
  const mergeScan = await scanApplicationDocument(actor(), uploaded.id)
  const target = (await createDeal(actor(), { idempotencyKey: "merge-target", legalName: "Existing Merchant LLC" })).deal
  const preview = await reviewApplicationMerge(actor(), mergeScan.id, target.id)
  assert.ok(preview.conflicts.includes("legalName"))
  await assert.rejects(() => confirmApplicationScan(actor(), { extractionId: mergeScan.id, confirmationId: "confirm-merge-1", mode: "merge", targetDealId: target.id, expectedVersion: target.version }), (error: { code?: string }) => error.code === "merge_conflicts_unreviewed")
  const merged = await confirmApplicationScan(actor(), { extractionId: mergeScan.id, confirmationId: "confirm-merge-1", mode: "merge", targetDealId: target.id, expectedVersion: target.version, acceptedConflictFields: preview.conflicts })
  assert.equal(merged.deal.legalName, "Human Approved Bakery LLC")
})

test("MIC-182 confirmation claim blocks concurrent duplicates and rejects a changed source", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const source = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "claim-source", filename: "claim.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\nclaim\n%%EOF\n")), category: "application", source: "test" })
  const review = await scanApplicationDocument(actor(), source.id)
  const attempts = await Promise.allSettled([
    confirmApplicationScan(actor(), { extractionId: review.id, confirmationId: "claim-a", mode: "create" }),
    confirmApplicationScan(actor(), { extractionId: review.id, confirmationId: "claim-b", mode: "create" }),
  ])
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(attempts.filter((result) => result.status === "rejected" && (result.reason as { code?: string }).code === "confirmation_conflict").length, 1)

  const staleSource = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "stale-source", filename: "stale.pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\nstale\n%%EOF\n")), category: "application", source: "test" })
  const staleReview = await scanApplicationDocument(actor(), staleSource.id)
  await categorizeDocument(actor(), staleSource.id, "other_stip")
  await assert.rejects(() => confirmApplicationScan(actor(), { extractionId: staleReview.id, confirmationId: "stale-confirm", mode: "create" }), (error: { code?: string }) => error.code === "extraction_source_changed")
})

test("MIC-182 an expired confirmation lease is reclaimed and rejects stale worker completion", async () => {
  const workspaceId = actor().workspaceId
  const first = await claimApplicationConfirmation({ id: "lease-claim", workspaceId, sourceType: "draft", sourceId: "crashed-draft", confirmationId: "lease-confirmation", attemptToken: "old-worker", leaseExpiresAt: "2026-09-08T12:00:00.000Z", state: "claimed", createdAt: "2026-09-08T11:59:00.000Z", updatedAt: "2026-09-08T11:59:00.000Z" })
  assert.equal(first.acquired, true)
  const reclaimed = await claimApplicationConfirmation({ id: "ignored-new-id", workspaceId, sourceType: "draft", sourceId: "crashed-draft", confirmationId: "lease-confirmation", attemptToken: "retry-worker", leaseExpiresAt: "2026-09-08T12:02:00.000Z", state: "claimed", createdAt: "2026-09-08T12:01:00.000Z", updatedAt: "2026-09-08T12:01:00.000Z" })
  assert.equal(reclaimed.acquired, true)
  assert.equal(reclaimed.claim.attemptToken, "retry-worker")
  await assert.rejects(() => completeApplicationConfirmation(workspaceId, reclaimed.claim.id, "old-worker", "deal-old", "document-old", "2026-09-08T12:01:01.000Z"), /confirmation_claim_lost/)
  const completed = await completeApplicationConfirmation(workspaceId, reclaimed.claim.id, "retry-worker", "deal-recovered", "document-recovered", "2026-09-08T12:01:02.000Z")
  assert.equal(completed.state, "complete")
  assert.equal(completed.dealId, "deal-recovered")
})

test("MIC-182 pre-deal drafts are workspace scoped, recover scanning, and retain source on create", async () => {
  setDocumentScannerForTests(undefined)
  const draft = await createApplicationDraft(actor(), { idempotencyKey: "predeal-draft", filename: "new-merchant.pdf", mimeType: "application/pdf", bytes: minimalPdf })
  assert.equal(draft.processingState, "pending_scan")
  await assert.rejects(() => getApplicationDraft(actor("workspace-other"), draft.id), (error: { code?: string }) => error.code === "application_draft_not_found")
  setDocumentScannerForTests(scanner("clean"))
  assert.equal((await retryApplicationDraftScan(actor(), draft.id)).processingState, "clean")
  const extracted = await extractApplicationDraft(actor(), draft.id)
  assert.equal(extracted.fields.owners?.[0].identityLast4, undefined)
  providerLegalName = "Model Changed LLC"
  const rescanned = await extractApplicationDraft(actor(), draft.id, { legalName: "Reviewed Predeal LLC" })
  assert.equal(rescanned.fields.legalName, "Reviewed Predeal LLC")
  const confirmed = await confirmApplicationDraft(actor(), { draftId: draft.id, confirmationId: "predeal-confirm", mode: "create" })
  assert.equal(confirmed.deal.legalName, "Reviewed Predeal LLC")
  assert.equal((await getDocument(actor(), confirmed.sourceDocumentId)).category, "application")
  assert.equal((await confirmApplicationDraft(actor(), { draftId: draft.id, confirmationId: "predeal-confirm", mode: "create" })).replayed, true)
})

test("application-scan confirm create blocks duplicate EIN unless attach or force", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const seed = await createDeal(actor(), {
    idempotencyKey: "dup-scan-seed",
    legalName: "Dup Scan Existing LLC",
    ein: "88-1112223",
    contactName: "Scan Contact",
    owners: [{ firstName: "Scan", lastName: "Owner", isPrimary: true }],
  })
  const uploaded = await storeDocument(actor(), {
    dealId: stagingDealId, idempotencyKey: "dup-scan-source", filename: "dup-scan.pdf",
    mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\ndup-scan\n%%EOF\n")), category: "application", source: "test",
  })
  const blockedReview = await scanApplicationDocument(actor(), uploaded.id)
  await assert.rejects(
    () => confirmApplicationScan(actor(), {
      extractionId: blockedReview.id, confirmationId: "dup-scan-blocked", mode: "create",
      manualFields: { ein: "88-1112223", legalName: "Dup Scan Blocked LLC" },
    }),
    (error: { code?: string; status?: number }) => error.code === "merchant_exists" && error.status === 409,
  )
  assert.equal((await getDatabase().prepare<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM deals WHERE workspace_id = ? AND legal_name = ?",
  ).get(actor().workspaceId, "Dup Scan Blocked LLC"))?.count, 0)

  const attachReview = await scanApplicationDocument(actor(), uploaded.id)
  const attached = await confirmApplicationScan(actor(), {
    extractionId: attachReview.id, confirmationId: "dup-scan-attach", mode: "create",
    attachMerchantId: seed.deal.merchantId,
    manualFields: { ein: "88-1112223", legalName: "Dup Scan Attached LLC" },
  })
  assert.notEqual(attached.deal.id, seed.deal.id)
  assert.equal(attached.deal.merchantId, seed.deal.merchantId)
  const attachedFull = await getDealForDocument(actor(), attached.deal.id)
  assert.equal(attachedFull.contactName, "Scan Contact")

  const forceReview = await scanApplicationDocument(actor(), uploaded.id)
  const forced = await confirmApplicationScan(actor(), {
    extractionId: forceReview.id, confirmationId: "dup-scan-force", mode: "create",
    forceDuplicate: true,
    manualFields: { ein: "88-1112223", legalName: "Dup Scan Forced LLC" },
  })
  assert.notEqual(forced.deal.merchantId, seed.deal.merchantId)
})

test("application-draft confirm create hits the same EIN duplicate gate", async () => {
  setDocumentScannerForTests(scanner("clean"))
  await createDeal(actor(), { idempotencyKey: "dup-draft-seed", legalName: "Dup Draft Existing LLC", ein: "88-1112233" })
  const draft = await createApplicationDraft(actor(), {
    idempotencyKey: "dup-draft-file", filename: "dup-draft.pdf", mimeType: "application/pdf", bytes: minimalPdf,
  })
  await extractApplicationDraft(actor(), draft.id, { legalName: "Dup Draft Blocked LLC", ein: "88-1112233" })
  await assert.rejects(
    () => confirmApplicationDraft(actor(), { draftId: draft.id, confirmationId: "dup-draft-blocked", mode: "create" }),
    (error: { code?: string; status?: number }) => error.code === "merchant_exists" && error.status === 409,
  )
  const forcedDraft = await createApplicationDraft(actor(), {
    idempotencyKey: "dup-draft-force-file", filename: "dup-draft-force.pdf", mimeType: "application/pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.4\ndup-draft-force\n%%EOF\n")),
  })
  await extractApplicationDraft(actor(), forcedDraft.id, { legalName: "Dup Draft Forced LLC", ein: "88-1112233" })
  const forced = await confirmApplicationDraft(actor(), {
    draftId: forcedDraft.id, confirmationId: "dup-draft-force", mode: "create", forceDuplicate: true,
  })
  assert.equal(forced.deal.legalName, "Dup Draft Forced LLC")
})

test("supporting files can be stored onto a deal after application-draft confirm", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const draft = await createApplicationDraft(actor(), {
    idempotencyKey: "support-after-confirm-draft", filename: "support-app.pdf", mimeType: "application/pdf",
    bytes: new Uint8Array(Buffer.from("%PDF-1.4\nsupport-app\n%%EOF\n")),
  })
  await extractApplicationDraft(actor(), draft.id, { legalName: "Support After Confirm LLC", ein: "88-1112244" })
  const confirmed = await confirmApplicationDraft(actor(), { draftId: draft.id, confirmationId: "support-after-confirm", mode: "create" })
  const statement = await storeDocument(actor(), {
    dealId: confirmed.deal.id, idempotencyKey: "support-stmt", filename: "bank-statement.pdf",
    mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\nstmt\n%%EOF\n")), category: "statement", source: "user_upload",
  })
  const check = await storeDocument(actor(), {
    dealId: confirmed.deal.id, idempotencyKey: "support-check", filename: "voided-check.pdf",
    mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\ncheck\n%%EOF\n")), category: "voided_check", source: "user_upload",
  })
  const license = await storeDocument(actor(), {
    dealId: confirmed.deal.id, idempotencyKey: "support-id", filename: "driver-license.pdf",
    mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.4\nid\n%%EOF\n")), category: "driver_license", source: "user_upload",
  })
  const listed = await listDocuments(actor(), confirmed.deal.id)
  assert.equal((await getDocument(actor(), confirmed.sourceDocumentId)).category, "application")
  assert.equal(statement.category, "statement")
  assert.equal(check.category, "voided_check")
  assert.equal(license.category, "driver_license")
  assert.equal(listed.some((item) => item.id === statement.id && item.category === "statement"), true)
  assert.equal(listed.some((item) => item.id === check.id && item.category === "voided_check"), true)
  assert.equal(listed.some((item) => item.id === license.id && item.category === "driver_license"), true)
})

test("MIC-177 suggests readable stable statement names without full account numbers and preserves original name", async () => {
  setDocumentScannerForTests(scanner("clean"))
  const document = await storeDocument(actor(), { dealId: stagingDealId, idempotencyKey: "statement-name", filename: "download (19).pdf", mimeType: "application/pdf", bytes: new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF\n")), category: "statement", source: "test" })
  const preview = await previewStatementFilename(actor(), document.id)
  assert.match(preview.suggestedFilename, /^Harbor-National-Bank-2026-08-Acct-6789-/)
  assert.equal(preview.suggestedFilename.includes("123456789"), false)
  const applied = await applyStatementFilename(actor(), { documentId: document.id, bankLabel: "Harbor National Bank", statementMonth: "2026-08", accountSuffix: "6789" })
  assert.equal(applied.currentFilename, suggestStatementFilename({ documentId: document.id, bankLabel: "Harbor National Bank", statementMonth: "2026-08", accountSuffix: "6789" }))
  assert.equal((await getDocument(actor(), document.id)).originalFilename, "download (19).pdf")
  assert.equal((await getDocument(actor(), document.id)).checksum, document.checksum)
  const audit = await getDatabase().prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE workspace_id = ? AND action = 'statement.filename_applied' AND resource_id = ? ORDER BY created_at DESC LIMIT 1").get(actor().workspaceId, document.id) as { metadata: string }
  assert.equal(audit.metadata.includes(document.originalFilename), false)
  assert.equal(audit.metadata.includes(applied.currentFilename), false)
  const otherName = suggestStatementFilename({ documentId: "different-document-id", bankLabel: "Harbor National Bank", statementMonth: "2026-08", accountSuffix: "6789" })
  assert.notEqual(otherName, applied.currentFilename)
  await assert.rejects(() => applyStatementFilename(actor(), { documentId: document.id, bankLabel: "Bank", statementMonth: "2026-08", accountSuffix: "123456789" }), (error: { code?: string }) => error.code === "account_suffix_invalid")
})

test("MIC-182/MIC-177 OpenAI adapter sends file data with strict structured output and disables provider storage", async () => {
  const originalFetch = globalThis.fetch
  let requestBody: Record<string, unknown> = {}
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ id: "resp_fixture", output: [{ content: [{ type: "output_text", text: JSON.stringify({
      bankLabel: { value: "Example Bank", confidence: 0.9, page: 1, text: "Example Bank" }, statementMonth: { value: "2026-08", confidence: 0.9, page: 1, text: "August 2026" }, accountSuffix: { value: "1234", confidence: 0.9, page: 1, text: "ending 1234" }, warnings: [],
    }) }] }] }), { status: 200, headers: { "x-request-id": "request_fixture" } })
  }
  try {
    const adapter = new OpenAiDocumentExtractionProvider("test-key", "test-model")
    const result = await adapter.extractStatementMetadata(actor(), { filename: "statement.pdf", mimeType: "application/pdf", bytes: minimalPdf, sourceReference: "fixture" })
    assert.equal(result.requestId, "request_fixture")
    assert.equal(requestBody.store, false)
    assert.equal((requestBody.text as { format: { type: string; strict: boolean } }).format.type, "json_schema")
    assert.equal((requestBody.text as { format: { type: string; strict: boolean } }).format.strict, true)
    assert.match(JSON.stringify(requestBody.input), /data:application\/pdf;base64/)
  } finally { globalThis.fetch = originalFetch }
})
