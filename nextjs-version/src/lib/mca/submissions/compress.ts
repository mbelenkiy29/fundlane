import "server-only"

import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { getDocument } from "../documents/service"
import { documentStorage } from "../documents/storage"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { OutgoingDocument } from "./contracts"
import { getOutgoingDocumentBytes as getPriorOutgoingBytes } from "./watermarks"

export const COMPRESS_STAGE = "compress" as const
export const DEFAULT_MAX_PAYLOAD_BYTES = 25_000_000
export const MAX_PAYLOAD_BYTES_LIMIT = 100_000_000

const MAX_EXCLUSIONS = 500
const FUNDER_ID_MAX = 80
const MAX_DOCUMENTS = 200

type SkipReason = "disabled" | "excluded" | "not_pdf"

export interface CompressSettings {
  automaticEmail: boolean
  maxPayloadBytes: number
  excludedFunderIds: string[]
  updatedAt: string | null
  updatedByUserId: string | null
}

export interface CompressSettingsView {
  settings: CompressSettings
  canManage: boolean
}

export interface UpdateCompressSettingsInput {
  automaticEmail?: boolean
  maxPayloadBytes?: number
  excludedFunderIds?: string[]
}

export interface DocumentSizeReport {
  originalDocumentId: string
  documentId: string
  stage: OutgoingDocument["stage"]
  inputStage: OutgoingDocument["stage"]
  inputBytes: number
  outputBytes: number
  encodedBytes: number
  pageCount: number
  keptPreCompress: boolean
  skipped?: SkipReason
}

export interface PackageSizeReport {
  maxPayloadBytes: number
  rawPayloadBytes: number
  encodedPayloadBytes: number
  blocked: boolean
  documents: DocumentSizeReport[]
}

export interface CompressPreviewResult {
  skipped: boolean
  reason?: SkipReason
  originalDocumentId: string
  originalChecksum: string
  funderId: string
  automaticEmail: boolean
  maxPayloadBytes: number
  derivative?: OutgoingDocument
  pages: number
  inputBytes: number
  outputBytes: number
  encodedBytes: number
  keptPreCompress: boolean
  blocked: boolean
  replayed: boolean
  report: PackageSizeReport
}

export interface CompressPackageResult {
  documents: OutgoingDocument[]
  report: PackageSizeReport
  replayed: boolean
}

export class PayloadTooLargeError extends AppError {
  readonly report: PackageSizeReport

  constructor(report: PackageSizeReport) {
    super(
      413,
      "payload_too_large",
      `The encoded email payload is ${report.encodedPayloadBytes.toLocaleString("en-US")} bytes, which exceeds the ${report.maxPayloadBytes.toLocaleString("en-US")}-byte destination limit.`,
      sizeFieldErrors(report),
    )
    this.report = report
    this.name = "PayloadTooLargeError"
  }
}

type CompressSettingsRow = {
  workspace_id: string
  automatic_email: number | string | boolean
  max_payload_bytes: number | string
  exclusions_json: string
  updated_at: string
  updated_by_user_id: string | null
}

type OriginalRow = {
  id: string
  workspace_id: string
  deal_id: string
  storage_key: string
  checksum: string
  byte_length: number | string
  mime_type: string
  processing_state: string
}

type DerivativeRow = {
  id: string
  workspace_id: string
  original_document_id: string
  funder_id: string
  job_id: string | null
  stage: string
  document_id: string
  original_checksum: string
  output_checksum: string
  template_version: number | string
  byte_length: number | string
  created_at: string
}

function db() {
  return getDatabase()
}

function denied(message = "You do not have permission to perform this action."): never {
  throw new AppError(403, "permission_denied", message)
}

function invalid(field: string, message: string): never {
  throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [message] })
}

function isAdmin(actor: DealActor): boolean {
  return Boolean(actor.role && canManageWorkspace(actor.role))
}

function asBooleanFlag(value: number | string | boolean): boolean {
  return Number(value) !== 0 && value !== false
}

function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function derivativeStorageKey(workspaceId: string, documentId: string): string {
  return `${workspaceId}/derivatives/compress/${documentId}`
}

/** RFC 4648 base64 length of an attachment. Encoded email payload is the sum of these sizes. */
export function encodedEmailBytes(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0
  return 4 * Math.ceil(byteLength / 3)
}

export function encodedEmailPayloadBytes(byteLengths: readonly number[]): number {
  return byteLengths.reduce((sum, length) => sum + encodedEmailBytes(length), 0)
}

function sizeFieldErrors(report: PackageSizeReport): Record<string, string[]> {
  return {
    maxPayloadBytes: [String(report.maxPayloadBytes)],
    encodedPayloadBytes: [String(report.encodedPayloadBytes)],
    rawPayloadBytes: [String(report.rawPayloadBytes)],
    documents: report.documents.map((item) => [
      item.originalDocumentId,
      `input=${item.inputBytes}`,
      `output=${item.outputBytes}`,
      `encoded=${item.encodedBytes}`,
      `pages=${item.pageCount}`,
      `keptPreCompress=${item.keptPreCompress ? "true" : "false"}`,
      item.skipped ? `skipped=${item.skipped}` : `stage=${item.stage}`,
    ].join(" ")),
  }
}

function defaultSettings(): CompressSettings {
  return {
    automaticEmail: false,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    excludedFunderIds: [],
    updatedAt: null,
    updatedByUserId: null,
  }
}

function mapSettings(row: CompressSettingsRow): CompressSettings {
  const excluded = parseJson<unknown>(row.exclusions_json, [])
  const maxPayloadBytes = Number(row.max_payload_bytes)
  return {
    automaticEmail: asBooleanFlag(row.automatic_email),
    maxPayloadBytes: Number.isInteger(maxPayloadBytes) && maxPayloadBytes > 0 ? maxPayloadBytes : DEFAULT_MAX_PAYLOAD_BYTES,
    excludedFunderIds: Array.isArray(excluded) ? excluded.filter((item): item is string => typeof item === "string") : [],
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  }
}

async function readSettingsRow(workspaceId: string): Promise<CompressSettingsRow | undefined> {
  return db().prepare<CompressSettingsRow>("SELECT * FROM mca_compress_settings WHERE workspace_id = ?").get(workspaceId)
}

async function settingsForWorkspace(workspaceId: string): Promise<CompressSettings> {
  const row = await readSettingsRow(workspaceId)
  return row ? mapSettings(row) : defaultSettings()
}

export async function getCompressSettings(actor: DealActor): Promise<CompressSettingsView> {
  return { settings: await settingsForWorkspace(actor.workspaceId), canManage: isAdmin(actor) }
}

function parseExcludedFunderIds(value: unknown): string[] {
  if (!Array.isArray(value)) invalid("excludedFunderIds", "Provide a JSON array of funder IDs.")
  if (value.length > MAX_EXCLUSIONS) invalid("excludedFunderIds", `Use at most ${MAX_EXCLUSIONS} exclusions.`)
  const ids: string[] = []
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) invalid("excludedFunderIds", `Exclusion ${index + 1} must be a funder ID.`)
    const id = item.trim()
    if (id.length > FUNDER_ID_MAX) invalid("excludedFunderIds", `Exclusion ${index + 1} is too long.`)
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function parseMaxPayloadBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) invalid("maxPayloadBytes", "maxPayloadBytes must be an integer.")
  if (value < 1 || value > MAX_PAYLOAD_BYTES_LIMIT) {
    invalid("maxPayloadBytes", `maxPayloadBytes must be between 1 and ${MAX_PAYLOAD_BYTES_LIMIT}.`)
  }
  return value
}

function parseDocumentIds(input: { documentId?: unknown; documentIds?: unknown }): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (value: unknown, field: string) => {
    if (typeof value !== "string" || !value.trim()) invalid(field, "Choose a document to compress.")
    const id = value.trim()
    if (id.length > 80) invalid(field, "documentId is too long.")
    if (seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  if (input.documentIds !== undefined) {
    if (!Array.isArray(input.documentIds) || input.documentIds.length < 1) invalid("documentIds", "Provide at least one document ID.")
    if (input.documentIds.length > MAX_DOCUMENTS) invalid("documentIds", `Use at most ${MAX_DOCUMENTS} documents.`)
    input.documentIds.forEach((item, index) => add(item, `documentIds.${index}`))
  }
  if (input.documentId !== undefined) add(input.documentId, "documentId")
  if (!ids.length) invalid("documentId", "Choose a document to compress.")
  return ids
}

export async function updateCompressSettings(actor: DealActor, input: UpdateCompressSettingsInput): Promise<CompressSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update compression settings.")
  if (input.automaticEmail === undefined && input.maxPayloadBytes === undefined && input.excludedFunderIds === undefined) {
    invalid("automaticEmail", "Provide automaticEmail, maxPayloadBytes, or excludedFunderIds.")
  }
  if (input.automaticEmail !== undefined && typeof input.automaticEmail !== "boolean") {
    invalid("automaticEmail", "automaticEmail must be true or false.")
  }
  const current = await settingsForWorkspace(actor.workspaceId)
  const automaticEmail = input.automaticEmail ?? current.automaticEmail
  const maxPayloadBytes = input.maxPayloadBytes !== undefined ? parseMaxPayloadBytes(input.maxPayloadBytes) : current.maxPayloadBytes
  const excludedFunderIds = input.excludedFunderIds !== undefined ? parseExcludedFunderIds(input.excludedFunderIds) : current.excludedFunderIds
  const now = nowIso()
  const row = await db().prepare<CompressSettingsRow>(`INSERT INTO mca_compress_settings
      (workspace_id, automatic_email, max_payload_bytes, exclusions_json, updated_at, updated_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET
        automatic_email = EXCLUDED.automatic_email,
        max_payload_bytes = EXCLUDED.max_payload_bytes,
        exclusions_json = EXCLUDED.exclusions_json,
        updated_at = EXCLUDED.updated_at,
        updated_by_user_id = EXCLUDED.updated_by_user_id
      RETURNING *`).get(
    actor.workspaceId,
    automaticEmail ? 1 : 0,
    maxPayloadBytes,
    JSON.stringify(excludedFunderIds),
    now,
    actor.userId,
  )
  const settings = row ? mapSettings(row) : { ...current, automaticEmail, maxPayloadBytes, excludedFunderIds, updatedAt: now, updatedByUserId: actor.userId }
  await recordAuditEvent({
    context: actor,
    action: "submission_compress.settings_updated",
    resourceType: "compress_settings",
    resourceId: actor.workspaceId,
    metadata: {
      automaticEmail: settings.automaticEmail,
      maxPayloadBytes: settings.maxPayloadBytes,
      excludedCount: settings.excludedFunderIds.length,
    },
    correlationId: actor.correlationId,
  })
  return { settings, canManage: true }
}

export async function requireCompressAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireCompressPreview(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireCompressManual(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

async function loadOriginal(documentId: string): Promise<OriginalRow | undefined> {
  return db().prepare<OriginalRow>(
    "SELECT id, workspace_id, deal_id, storage_key, checksum, byte_length, mime_type, processing_state FROM mca_documents WHERE id = ?",
  ).get(documentId)
}

async function loadFunderWorkspace(funderId: string): Promise<{ id: string; workspace_id: string } | undefined> {
  return db().prepare<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM mca_funders WHERE id = ?").get(funderId)
}

async function findDerivative(originalDocumentId: string, funderId: string, templateVersion: number): Promise<DerivativeRow | undefined> {
  return db().prepare<DerivativeRow>(
    "SELECT * FROM mca_outgoing_derivatives WHERE original_document_id = ? AND funder_id = ? AND stage = ? AND template_version = ?",
  ).get(originalDocumentId, funderId, COMPRESS_STAGE, templateVersion)
}

async function findDerivativeByDocumentId(documentId: string): Promise<DerivativeRow | undefined> {
  return db().prepare<DerivativeRow>("SELECT * FROM mca_outgoing_derivatives WHERE document_id = ? AND stage = ?").get(documentId, COMPRESS_STAGE)
}

async function insertDerivative(row: DerivativeRow): Promise<DerivativeRow> {
  const inserted = await db().prepare<DerivativeRow>(`INSERT INTO mca_outgoing_derivatives
      (id, workspace_id, original_document_id, funder_id, job_id, stage, document_id, original_checksum, output_checksum, template_version, byte_length, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (original_document_id, funder_id, stage, template_version) DO NOTHING
      RETURNING *`).get(
    row.id, row.workspace_id, row.original_document_id, row.funder_id, row.job_id, row.stage, row.document_id,
    row.original_checksum, row.output_checksum, row.template_version, row.byte_length, row.created_at,
  )
  if (inserted) return inserted
  const existing = await findDerivative(row.original_document_id, row.funder_id, Number(row.template_version))
  if (!existing) throw new AppError(500, "compress_persist_failed", "The compressed derivative could not be recorded.")
  return existing
}

async function storeDerivativeBytes(key: string, bytes: Uint8Array, expectedChecksum: string): Promise<void> {
  const storage = documentStorage()
  try {
    const existing = await storage.get(key)
    if (checksumOf(existing) !== expectedChecksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved compress storage contains different content.")
    }
    return
  } catch (error) {
    if (error instanceof AppError) throw error
  }
  try {
    await storage.putImmutable(key, bytes)
  } catch {
    const existing = await storage.get(key)
    if (checksumOf(existing) !== expectedChecksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved compress storage contains different content.")
    }
  }
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
}

function skipReason(settings: CompressSettings, funderId: string, pdf: boolean, mode: "automatic" | "manual"): SkipReason | undefined {
  if (mode === "automatic" && !settings.automaticEmail) return "disabled"
  if (settings.excludedFunderIds.includes(funderId)) return "excluded"
  if (!pdf) return "not_pdf"
  return undefined
}

function toOutgoing(row: DerivativeRow): OutgoingDocument {
  return {
    documentId: row.document_id,
    originalDocumentId: row.original_document_id,
    checksum: row.output_checksum,
    byteLength: Number(row.byte_length),
    stage: COMPRESS_STAGE,
  }
}

/** Bind compress cache identity to the incoming (stamp/watermark/original) checksum. */
function templateVersionFor(checksum: string): number {
  const slice = checksum.replace(/[^0-9a-f]/gi, "").slice(0, 7)
  const parsed = Number.parseInt(slice || "1", 16)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) return 1
  return parsed
}

function stampPdf(pdf: PDFDocument): void {
  pdf.setProducer("MCA PDF Compress")
  pdf.setCreator("MCA PDF Compress")
  pdf.setModificationDate(new Date(0))
  pdf.setCreationDate(new Date(0))
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    throw new AppError(422, "compress_source_invalid", "The original document is not a readable PDF.")
  }
  if (pdf.isEncrypted) throw new AppError(422, "compress_source_invalid", "Encrypted PDFs cannot be compressed.")
  if (!pdf.getPageCount()) throw new AppError(422, "compress_source_invalid", "The original PDF has no pages to compress.")
  return pdf
}

async function countPages(bytes: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()
  } catch {
    return 0
  }
}

async function compressPdf(bytes: Uint8Array): Promise<{ bytes: Uint8Array; pageCount: number; keptPreCompress: boolean }> {
  const source = await loadPdf(bytes)
  const pageCount = source.getPageCount()
  const candidates: Uint8Array[] = []

  try {
    const resave = await PDFDocument.load(bytes, { updateMetadata: false })
    stampPdf(resave)
    candidates.push(new Uint8Array(await resave.save({ useObjectStreams: true })))
  } catch {
    /* keep other candidates */
  }

  try {
    const fresh = await PDFDocument.create()
    const copied = await fresh.copyPages(source, source.getPageIndices())
    copied.forEach((page) => fresh.addPage(page))
    stampPdf(fresh)
    candidates.push(new Uint8Array(await fresh.save({ useObjectStreams: true })))
  } catch {
    /* keep source when rebuild fails */
  }

  let best = bytes
  for (const candidate of candidates) {
    if (candidate.byteLength >= best.byteLength) continue
    if (await countPages(candidate) !== pageCount) continue
    best = candidate
  }
  return { bytes: best, pageCount, keptPreCompress: best === bytes || best.byteLength >= bytes.byteLength }
}

function buildReport(maxPayloadBytes: number, documents: DocumentSizeReport[]): PackageSizeReport {
  const rawPayloadBytes = documents.reduce((sum, item) => sum + item.outputBytes, 0)
  const encodedPayloadBytes = encodedEmailPayloadBytes(documents.map((item) => item.outputBytes))
  return {
    maxPayloadBytes,
    rawPayloadBytes,
    encodedPayloadBytes,
    blocked: encodedPayloadBytes > maxPayloadBytes,
    documents,
  }
}

function assertFits(report: PackageSizeReport): void {
  if (report.blocked) throw new PayloadTooLargeError(report)
}

async function persistCompress(input: {
  original: OriginalRow
  source: OutgoingDocument
  sourceBytes: Uint8Array
  funderId: string
  actor?: DealActor
}): Promise<{ document: OutgoingDocument; replayed: boolean; bytes: Uint8Array; pageCount: number; keptPreCompress: boolean }> {
  const templateVersion = templateVersionFor(input.source.checksum)
  const cached = await findDerivative(input.original.id, input.funderId, templateVersion)
  if (cached) {
    if (cached.original_checksum !== input.original.checksum) {
      throw new AppError(409, "compress_identity_conflict", "The cached compression does not match the immutable original.")
    }
    const bytes = await documentStorage().get(derivativeStorageKey(cached.workspace_id, cached.document_id))
    if (checksumOf(bytes) !== cached.output_checksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved compress storage contains different content.")
    }
    const pageCount = await countPages(bytes)
    return { document: toOutgoing(cached), replayed: true, bytes, pageCount, keptPreCompress: false }
  }

  const compressed = await compressPdf(input.sourceBytes)
  if (compressed.keptPreCompress) {
    return { document: input.source, replayed: false, bytes: input.sourceBytes, pageCount: compressed.pageCount, keptPreCompress: true }
  }

  const outputChecksum = checksumOf(compressed.bytes)
  const id = newId()
  await storeDerivativeBytes(derivativeStorageKey(input.original.workspace_id, id), compressed.bytes, outputChecksum)
  const row = await insertDerivative({
    id,
    workspace_id: input.original.workspace_id,
    original_document_id: input.original.id,
    funder_id: input.funderId,
    job_id: null,
    stage: COMPRESS_STAGE,
    document_id: id,
    original_checksum: input.original.checksum,
    output_checksum: outputChecksum,
    template_version: templateVersion,
    byte_length: compressed.bytes.byteLength,
    created_at: nowIso(),
  })
  if (row.document_id !== id) {
    const winner = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    return { document: toOutgoing(row), replayed: true, bytes: winner, pageCount: compressed.pageCount, keptPreCompress: false }
  }
  const context = input.actor ?? { workspaceId: input.original.workspace_id, userId: null, source: "system" as const }
  await recordAuditEvent({
    context,
    action: "submission_compress.generated",
    resourceType: "document",
    resourceId: input.original.id,
    metadata: {
      funderId: input.funderId,
      derivativeId: row.document_id,
      outputChecksum: row.output_checksum,
      pageCount: compressed.pageCount,
      inputBytes: input.sourceBytes.byteLength,
      outputBytes: compressed.bytes.byteLength,
      encodedBytes: encodedEmailBytes(compressed.bytes.byteLength),
      inputStage: input.source.stage,
    },
    correlationId: input.actor?.correlationId,
  })
  return { document: toOutgoing(row), replayed: false, bytes: compressed.bytes, pageCount: compressed.pageCount, keptPreCompress: false }
}

async function transformDocuments(input: {
  documents: OutgoingDocument[]
  funderId: string
  mode: "automatic" | "manual"
  actor?: DealActor
  workspaceId?: string
}): Promise<{ documents: OutgoingDocument[]; report: PackageSizeReport; replayed: boolean }> {
  if (!input.documents.length) {
    const settings = input.workspaceId ? await settingsForWorkspace(input.workspaceId) : defaultSettings()
    const report = buildReport(settings.maxPayloadBytes, [])
    assertFits(report)
    return { documents: input.documents, report, replayed: false }
  }
  const firstOriginal = await loadOriginal(input.documents[0].originalDocumentId)
  if (!firstOriginal) {
    throw new AppError(404, "document_not_found", "The requested document was not found.")
  }
  const workspaceId = input.workspaceId ?? firstOriginal.workspace_id
  const settings = await settingsForWorkspace(workspaceId)
  const next: OutgoingDocument[] = []
  const rows: DocumentSizeReport[] = []
  let replayed = true
  for (const document of input.documents) {
    const original = await loadOriginal(document.originalDocumentId)
    if (!original || original.workspace_id !== workspaceId) {
      throw new AppError(404, "document_not_found", "The requested document was not found.")
    }
    const sourceBytes = document.stage === COMPRESS_STAGE
      ? await getOutgoingDocumentBytes(document)
      : await getPriorOutgoingBytes(document)
    const pdf = isPdf(sourceBytes)
    const reason = skipReason(settings, input.funderId, pdf, input.mode)
    if (reason || document.stage === COMPRESS_STAGE) {
      const pageCount = pdf ? await countPages(sourceBytes) : 0
      next.push(document)
      rows.push({
        originalDocumentId: original.id,
        documentId: document.documentId,
        stage: document.stage,
        inputStage: document.stage,
        inputBytes: sourceBytes.byteLength,
        outputBytes: sourceBytes.byteLength,
        encodedBytes: encodedEmailBytes(sourceBytes.byteLength),
        pageCount,
        keptPreCompress: true,
        skipped: reason,
      })
      continue
    }
    const compressed = await persistCompress({
      original,
      source: document,
      sourceBytes,
      funderId: input.funderId,
      actor: input.actor,
    })
    if (!compressed.replayed) replayed = false
    next.push(compressed.document)
    rows.push({
      originalDocumentId: original.id,
      documentId: compressed.document.documentId,
      stage: compressed.document.stage,
      inputStage: document.stage,
      inputBytes: sourceBytes.byteLength,
      outputBytes: compressed.bytes.byteLength,
      encodedBytes: encodedEmailBytes(compressed.bytes.byteLength),
      pageCount: compressed.pageCount,
      keptPreCompress: compressed.keptPreCompress,
    })
  }
  const report = buildReport(settings.maxPayloadBytes, rows)
  assertFits(report)
  return { documents: next, report, replayed: replayed && Boolean(next.length) }
}

/** Size-gated PDF compression. Called by conductor-owned package.ts after stamps and watermarks. */
export async function applyCompression(documents: OutgoingDocument[], funderId: string): Promise<OutgoingDocument[]> {
  const result = await transformDocuments({ documents, funderId, mode: "automatic" })
  return result.documents
}

export async function previewCompression(actor: DealActor, input: {
  documentId?: unknown
  documentIds?: unknown
  funderId?: unknown
}): Promise<CompressPreviewResult> {
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const documentIds = parseDocumentIds(input)
  const funder = await loadFunderWorkspace(funderId)
  if (!funder || funder.workspace_id !== actor.workspaceId) {
    throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  }
  const records = []
  for (const documentId of documentIds) {
    records.push(await getDocument(actor, documentId))
  }
  const settings = await settingsForWorkspace(actor.workspaceId)
  const sources: OutgoingDocument[] = records.map((record) => ({
    documentId: record.id,
    originalDocumentId: record.id,
    checksum: record.checksum,
    byteLength: record.byteLength,
    stage: "original" as const,
  }))
  const transformed = await transformDocuments({
    documents: sources,
    funderId,
    mode: "automatic",
    actor,
    workspaceId: actor.workspaceId,
  })
  const first = transformed.report.documents[0]
  const firstRecord = records[0]
  const firstOutgoing = transformed.documents[0]
  const skipped = Boolean(first?.skipped)
  return {
    skipped,
    reason: first?.skipped,
    originalDocumentId: firstRecord.id,
    originalChecksum: firstRecord.checksum,
    funderId,
    automaticEmail: settings.automaticEmail,
    maxPayloadBytes: settings.maxPayloadBytes,
    derivative: firstOutgoing && firstOutgoing.stage === COMPRESS_STAGE ? firstOutgoing : undefined,
    pages: first?.pageCount ?? 0,
    inputBytes: first?.inputBytes ?? 0,
    outputBytes: first?.outputBytes ?? 0,
    encodedBytes: first?.encodedBytes ?? 0,
    keptPreCompress: first?.keptPreCompress ?? true,
    blocked: transformed.report.blocked,
    replayed: transformed.replayed,
    report: transformed.report,
  }
}

export async function compressSubmissionPackage(actor: DealActor, input: {
  documentId?: unknown
  documentIds?: unknown
  funderId?: unknown
}): Promise<CompressPackageResult> {
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const documentIds = parseDocumentIds(input)
  const funder = await loadFunderWorkspace(funderId)
  if (!funder || funder.workspace_id !== actor.workspaceId) {
    throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  }
  const sources: OutgoingDocument[] = []
  for (const documentId of documentIds) {
    const record = await getDocument(actor, documentId)
    sources.push({
      documentId: record.id,
      originalDocumentId: record.id,
      checksum: record.checksum,
      byteLength: record.byteLength,
      stage: "original",
    })
  }
  return transformDocuments({
    documents: sources,
    funderId,
    mode: "manual",
    actor,
    workspaceId: actor.workspaceId,
  })
}

export async function getOutgoingDocumentBytes(document: OutgoingDocument): Promise<Uint8Array> {
  const criteriaSheet = await getDatabase().prepare<{ blocked: number }>(
    `SELECT 1 AS blocked FROM mca_documents AS d WHERE d.id = ? AND
      (d.source = 'funder_criteria_scan' OR EXISTS
        (SELECT 1 FROM mca_funder_criteria_scans AS scan WHERE scan.workspace_id = d.workspace_id AND scan.document_id = d.id))`,
  ).get(document.originalDocumentId)
  if (criteriaSheet) throw new AppError(409, "criteria_sheet_not_submittable", "Lender criteria sheets cannot be sent with deal submissions.")
  if (document.stage === COMPRESS_STAGE) {
    const row = await findDerivativeByDocumentId(document.documentId)
    if (!row) throw new AppError(404, "document_not_found", "The requested compress derivative was not found.")
    const bytes = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    if (checksumOf(bytes) !== row.output_checksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved compress storage contains different content.")
    }
    return bytes
  }
  return getPriorOutgoingBytes(document)
}
