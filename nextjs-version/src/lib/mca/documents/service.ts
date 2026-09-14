import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { DOCUMENT_CATEGORIES, type DocumentCategory, type DocumentSummary, type UploadDocumentInput } from "./contracts"
import {
  findDocumentById,
  findDocumentByIdempotencyKey,
  listDocumentRecords,
  reserveDocument,
  updateDocumentCategory as updateCategoryRecord,
  updateDocumentDisplayFilename,
  updateDocumentScan,
  type DocumentRecord,
} from "./repository"
import { documentScanner, type ScanResult } from "./scanner"
import { documentStorage } from "./storage"

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"])

function summary(record: DocumentRecord): DocumentSummary {
  const { id, dealId, workspaceId, originalFilename, displayFilename, mimeType, byteLength, checksum, category, version, createdAt, processingState } = record
  return { id, dealId, workspaceId, originalFilename, displayFilename, mimeType, byteLength, checksum, category, version, createdAt, processingState }
}

function normalizedFilename(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").replace(/\s+/g, " ").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") throw new AppError(422, "invalid_filename", "Choose a valid filename.")
  return cleaned.slice(0, 180)
}

function validateMagic(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "application/pdf") return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
  if (mimeType === "image/png") return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  return false
}

function validateUpload(input: UploadDocumentInput): string {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) {
    throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key of at most 160 characters.")
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(415, "unsupported_document_type", "Upload a PDF, PNG, or JPEG document.")
  }
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new AppError(413, "document_size_invalid", `Documents must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`)
  }
  if (!validateMagic(input.mimeType, input.bytes)) {
    throw new AppError(422, "document_content_mismatch", "The file contents do not match the declared PDF or image type.")
  }
  return normalizedFilename(input.filename)
}

function scanState(result: ScanResult): DocumentRecord["processingState"] {
  if (result.status === "clean") return "clean"
  if (result.status === "infected") return "quarantined"
  if (result.status === "error") return "scan_failed"
  return "pending_scan"
}

async function applyScan(actor: DealActor, record: DocumentRecord, bytes: Uint8Array): Promise<DocumentRecord> {
  let result = await documentScanner().scan(bytes, record.originalFilename)
  if (result.status === "clean") {
    try { await documentStorage().promoteClean?.(record.storageKey, bytes) }
    catch { result = { status: "error", provider: "storage", evidence: { recoverable: true, reason: "clean_promotion_failed" } } }
  }
  const attemptedAt = nowIso()
  const updated = await updateDocumentScan(actor.workspaceId, record.id, scanState(result), result.provider, result.evidence, attemptedAt)
  await recordAuditEvent({
    context: actor,
    action: "document.scanned",
    resourceType: "document",
    resourceId: record.id,
    metadata: { state: updated.processingState, provider: result.provider, actualScannerEvidence: result.status === "clean" || result.status === "infected" },
    correlationId: actor.correlationId,
  })
  return updated
}

async function ensureStored(record: DocumentRecord, bytes: Uint8Array): Promise<void> {
  const storage = documentStorage()
  try {
    const existing = await storage.get(record.storageKey)
    const existingChecksum = createHash("sha256").update(existing).digest("hex")
    if (existingChecksum !== record.checksum) throw new AppError(409, "immutable_storage_conflict", "The reserved document storage contains different content.")
    return
  } catch (error) {
    if (error instanceof AppError) throw error
  }
  try {
    await storage.putImmutable(record.storageKey, bytes)
  } catch {
    const existing = await storage.get(record.storageKey)
    const existingChecksum = createHash("sha256").update(existing).digest("hex")
    if (existingChecksum !== record.checksum) throw new AppError(409, "immutable_storage_conflict", "The reserved document storage contains different content.")
  }
}

export async function storeDocument(actor: DealActor, input: UploadDocumentInput): Promise<DocumentSummary> {
  const deal = await getDealForDocument(actor, input.dealId)
  if (deal.workspaceId !== actor.workspaceId) throw new AppError(404, "deal_not_found", "The requested deal was not found.")
  const filename = validateUpload(input)
  const checksum = createHash("sha256").update(input.bytes).digest("hex")
  const replay = await findDocumentByIdempotencyKey(actor.workspaceId, input.idempotencyKey)
  if (replay) {
    if (replay.dealId !== input.dealId || replay.checksum !== checksum || replay.category !== input.category) {
      throw new AppError(409, "idempotency_conflict", "That idempotency key was already used for a different document.")
    }
    if (replay.processingState === "clean" || replay.processingState === "quarantined") return summary(replay)
    await ensureStored(replay, input.bytes)
    return summary(await applyScan(actor, replay, input.bytes))
  }

  const id = newId()
  const now = nowIso()
  const storageKey = `${actor.workspaceId}/${input.dealId}/${id}`
  const explicitPrevious = input.sourceReference?.startsWith("document-version:")
    ? input.sourceReference.slice("document-version:".length).trim()
    : undefined
  let reservation: { record: DocumentRecord; inserted: boolean }
  try {
    reservation = await reserveDocument({
    id,
    workspaceId: actor.workspaceId,
    dealId: input.dealId,
    idempotencyKey: input.idempotencyKey,
    originalFilename: filename,
    displayFilename: filename,
    mimeType: input.mimeType,
    byteLength: input.bytes.byteLength,
    checksum,
    category: input.category,
    storageKey,
    source: input.source.trim().slice(0, 80) || "unknown",
    sourceReference: input.sourceReference?.trim().slice(0, 300),
    processingState: "pending_scan",
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
    }, explicitPrevious)
  } catch (error) {
    if (error instanceof Error && error.message === "version_source_not_found") throw new AppError(404, "version_source_not_found", "The document selected for versioning was not found in this deal.")
    if (error instanceof Error && error.message === "version_source_stale") throw new AppError(409, "version_source_stale", "A newer version already exists. Refresh the vault and upload against the latest version.")
    throw error
  }
  const record = reservation.record
  if (record.dealId !== input.dealId || record.checksum !== checksum || record.category !== input.category) {
    throw new AppError(409, "idempotency_conflict", "That idempotency key was already used for a different document.")
  }
  try {
    await ensureStored(record, input.bytes)
  } catch (error) {
    await updateDocumentScan(actor.workspaceId, record.id, "scan_failed", "storage", { recoverable: true, reason: "write_or_verification_failed" }, nowIso())
    throw error
  }
  await recordAuditEvent({
    context: actor,
    action: "document.uploaded",
    resourceType: "document",
    resourceId: id,
    metadata: { dealId: input.dealId, category: input.category, version: record.version, lineageId: record.lineageId, byteLength: record.byteLength, checksum },
    correlationId: actor.correlationId,
  })
  return summary(await applyScan(actor, record, input.bytes))
}

export async function listDocuments(actor: DealActor, dealId: string): Promise<DocumentSummary[]> {
  await getDealForDocument(actor, dealId)
  return (await listDocumentRecords(actor.workspaceId, dealId)).map(summary)
}

export async function getDocument(actor: DealActor, id: string): Promise<DocumentRecord> {
  const record = await findDocumentById(actor.workspaceId, id)
  if (!record) throw new AppError(404, "document_not_found", "The requested document was not found.")
  const deal = await getDealForDocument(actor, record.dealId)
  if (deal.workspaceId !== actor.workspaceId) throw new AppError(404, "document_not_found", "The requested document was not found.")
  return record
}

export async function getDocumentContent(actor: DealActor, id: string): Promise<{ document: DocumentRecord; bytes: Uint8Array }> {
  const record = await getDocument(actor, id)
  if (record.processingState !== "clean") {
    throw new AppError(423, "document_not_clean", "This document is unavailable until a configured malware scanner marks it clean.")
  }
  return { document: record, bytes: await documentStorage().get(record.storageKey) }
}

export async function retryDocumentScan(actor: DealActor, id: string): Promise<DocumentSummary> {
  const record = await getDocument(actor, id)
  const bytes = await documentStorage().get(record.storageKey)
  return summary(await applyScan(actor, record, bytes))
}

function tokenSecret(): Buffer {
  const configured = process.env.MCA_DOCUMENT_TOKEN_SECRET
  if (configured && configured.length >= 32) return Buffer.from(configured)
  if (process.env.NODE_ENV === "production") throw new AppError(503, "download_tokens_unavailable", "Configure MCA_DOCUMENT_TOKEN_SECRET before issuing download links.")
  return createHash("sha256").update("mca-local-document-token-secret").digest()
}

function signToken(payload: string): string {
  return createHmac("sha256", tokenSecret()).update(payload).digest("base64url")
}

export async function createDocumentDownloadToken(actor: DealActor, id: string, now = Date.now()): Promise<{ token: string; expiresAt: string }> {
  const record = await getDocument(actor, id)
  if (record.processingState !== "clean") throw new AppError(423, "document_not_clean", "Only clean documents can be downloaded.")
  const expires = now + 5 * 60_000
  const payload = Buffer.from(JSON.stringify({ d: record.id, v: record.version, w: actor.workspaceId, e: expires })).toString("base64url")
  return { token: `${payload}.${signToken(payload)}`, expiresAt: new Date(expires).toISOString() }
}

export async function redeemDocumentDownloadToken(actor: DealActor, token: string, now = Date.now()): Promise<{ document: DocumentRecord; bytes: Uint8Array }> {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  const expected = Buffer.from(signToken(payload))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  let data: { d?: string; v?: number; w?: string; e?: number }
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof data } catch { throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.") }
  if (!data.d || data.w !== actor.workspaceId || !data.e || data.e < now) throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  const result = await getDocumentContent(actor, data.d)
  if (result.document.version !== data.v) throw new AppError(404, "download_link_invalid", "This download link no longer matches the document version.")
  return result
}

export async function renameDocument(actor: DealActor, id: string, displayFilename: string): Promise<DocumentSummary> {
  const record = await getDocument(actor, id)
  const next = normalizedFilename(displayFilename)
  const updated = await updateDocumentDisplayFilename(actor.workspaceId, record.id, next, nowIso())
  await recordAuditEvent({ context: actor, action: "document.renamed", resourceType: "document", resourceId: id, metadata: { filenameChanged: record.displayFilename !== next }, correlationId: actor.correlationId })
  return summary(updated)
}

export async function categorizeDocument(actor: DealActor, id: string, category: DocumentCategory): Promise<DocumentSummary> {
  if (!DOCUMENT_CATEGORIES.includes(category)) throw new AppError(422, "category_invalid", "Choose a valid document category.")
  const document = await getDocument(actor, id)
  if (document.category === category) return summary(document)
  const updated = await updateCategoryRecord(actor.workspaceId, document.id, document.dealId, category, nowIso())
  await recordAuditEvent({ context: actor, action: "document.category_changed", resourceType: "document", resourceId: id, metadata: { from: document.category, to: category, version: updated.version }, correlationId: actor.correlationId })
  return summary(updated)
}

function slug(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "Unknown-Bank"
}

export function suggestStatementFilename(input: {
  bankLabel?: string
  statementMonth?: string
  accountSuffix?: string
  documentId: string
}): string {
  const bank = slug(input.bankLabel ?? "Unknown Bank")
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(input.statementMonth ?? "") ? input.statementMonth : "Unknown-Month"
  const suffix = (input.accountSuffix ?? "").replace(/\D/g, "").slice(-4)
  const account = suffix ? `-Acct-${suffix}` : ""
  return `${bank}-${month}${account}-${input.documentId.slice(0, 8)}.pdf`
}

export function scannerConfiguration(): { configured: boolean; provider: string; action: string } {
  const scanner = documentScanner()
  return {
    configured: scanner.name !== "unconfigured",
    provider: scanner.name,
    action: scanner.name === "unconfigured" ? "Set MCA_DOCUMENT_SCANNER to clamdscan or clamscan, then retry pending uploads." : "Scanner is configured; pending and failed uploads can be retried.",
  }
}
