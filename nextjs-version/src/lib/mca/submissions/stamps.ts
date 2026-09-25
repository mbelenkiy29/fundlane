import "server-only"

import { isDocumentReady } from "../documents/contracts"

import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { getDocument, getDocumentContent } from "../documents/service"
import { documentStorage } from "../documents/storage"
import { AppError } from "../errors"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { OutgoingDocument } from "./contracts"

export const STAMP_STAGE = "stamp" as const
export const STAMP_TEXT_PREFIX = "Submitted to "

const SAFE_MARGIN = 36
const MIN_MARGIN = 12
const STAMP_FONT_SIZE = 9
const STAMP_LINE_HEIGHT = 11
const STAMP_PADDING = 4
const MAX_EXCLUSIONS = 500
const FUNDER_ID_MAX = 80

type SkipReason = "disabled" | "excluded" | "not_pdf" | "not_statement"

export interface StampSettings {
  enabled: boolean
  excludedFunderIds: string[]
  templateVersion: number
  updatedAt: string | null
  updatedByUserId: string | null
}

export interface StampSettingsView {
  settings: StampSettings
  canManage: boolean
}

export interface UpdateStampSettingsInput {
  enabled?: boolean
  excludedFunderIds?: string[]
}

export interface StampPagePreview {
  page: number
  width: number
  height: number
  rotation: number
  stampX: number
  stampY: number
  stampWidth: number
  stampHeight: number
  fitted: boolean
}

export interface StampPreviewResult {
  skipped: boolean
  reason?: SkipReason
  originalDocumentId: string
  originalChecksum: string
  funderId: string
  funderLegalName?: string
  stampText?: string
  templateVersion: number
  derivative?: OutgoingDocument
  pages: StampPagePreview[]
  replayed: boolean
}

type StampSettingsRow = {
  workspace_id: string
  enabled: number | string | boolean
  exclusions_json: string
  template_version: number | string
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
  category: string
}

type FunderNameRow = {
  id: string
  workspace_id: string
  legal_name: string
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

function defaultSettings(): StampSettings {
  return {
    enabled: false,
    excludedFunderIds: [],
    templateVersion: 1,
    updatedAt: null,
    updatedByUserId: null,
  }
}

function mapSettings(row: StampSettingsRow): StampSettings {
  const excluded = parseJson<unknown>(row.exclusions_json, [])
  return {
    enabled: asBooleanFlag(row.enabled),
    excludedFunderIds: Array.isArray(excluded) ? excluded.filter((item): item is string => typeof item === "string") : [],
    templateVersion: Number(row.template_version) || 1,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
  }
}

export function stampTextForFunder(legalName: string): string {
  const name = winAnsiSafe(legalName).slice(0, 200) || "funder"
  return `${STAMP_TEXT_PREFIX}${name}`
}

function winAnsiSafe(value: string): string {
  let output = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x20 && code <= 0x7e) output += character
    else if (code >= 0xa0 && code <= 0xff) output += character
    else output += "?"
  }
  return output.replace(/\s+/g, " ").trim()
}

function wrapText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
    if (line) lines.push(line)
    if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue }
    let chunk = ""
    for (const character of word) {
      if (font.widthOfTextAtSize(chunk + character, size) > maxWidth && chunk) { lines.push(chunk); chunk = character }
      else chunk += character
    }
    line = chunk
  }
  if (line) lines.push(line)
  return lines.length ? lines : [value]
}

function checksumOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function derivativeStorageKey(workspaceId: string, documentId: string): string {
  return `${workspaceId}/derivatives/stamp/${documentId}`
}

function toOutgoing(row: DerivativeRow): OutgoingDocument {
  return {
    documentId: row.document_id,
    originalDocumentId: row.original_document_id,
    checksum: row.output_checksum,
    byteLength: Number(row.byte_length),
    stage: STAMP_STAGE,
  }
}

async function readSettingsRow(workspaceId: string): Promise<StampSettingsRow | undefined> {
  return db().prepare<StampSettingsRow>("SELECT * FROM mca_stamp_settings WHERE workspace_id = ?").get(workspaceId)
}

export async function getStampSettings(actor: DealActor): Promise<StampSettingsView> {
  const row = await readSettingsRow(actor.workspaceId)
  return {
    settings: row ? mapSettings(row) : defaultSettings(),
    canManage: isAdmin(actor),
  }
}

async function settingsForWorkspace(workspaceId: string): Promise<StampSettings> {
  const row = await readSettingsRow(workspaceId)
  return row ? mapSettings(row) : defaultSettings()
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

export async function updateStampSettings(actor: DealActor, input: UpdateStampSettingsInput): Promise<StampSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update destination stamp settings.")
  if (input.enabled === undefined && input.excludedFunderIds === undefined) {
    invalid("enabled", "Provide enabled or excludedFunderIds.")
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    invalid("enabled", "enabled must be true or false.")
  }
  const current = await settingsForWorkspace(actor.workspaceId)
  const enabled = input.enabled ?? current.enabled
  const excludedFunderIds = input.excludedFunderIds !== undefined ? parseExcludedFunderIds(input.excludedFunderIds) : current.excludedFunderIds
  const now = nowIso()
  const row = await db().prepare<StampSettingsRow>(`INSERT INTO mca_stamp_settings
      (workspace_id, enabled, exclusions_json, template_version, updated_at, updated_by_user_id)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        exclusions_json = EXCLUDED.exclusions_json,
        template_version = mca_stamp_settings.template_version + 1,
        updated_at = EXCLUDED.updated_at,
        updated_by_user_id = EXCLUDED.updated_by_user_id
      RETURNING *`).get(
    actor.workspaceId,
    enabled ? 1 : 0,
    JSON.stringify(excludedFunderIds),
    now,
    actor.userId,
  )
  const settings = row ? mapSettings(row) : { ...current, enabled, excludedFunderIds, updatedAt: now, updatedByUserId: actor.userId }
  await recordAuditEvent({
    context: actor,
    action: "submission_stamp.settings_updated",
    resourceType: "stamp_settings",
    resourceId: actor.workspaceId,
    metadata: { enabled: settings.enabled, excludedCount: settings.excludedFunderIds.length, templateVersion: settings.templateVersion },
    correlationId: actor.correlationId,
  })
  return { settings, canManage: true }
}

export async function requireStampAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireStampPreview(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

async function loadOriginal(documentId: string): Promise<OriginalRow | undefined> {
  return db().prepare<OriginalRow>(
    "SELECT id, workspace_id, deal_id, storage_key, checksum, byte_length, mime_type, processing_state, category FROM mca_documents WHERE id = ?",
  ).get(documentId)
}

async function loadFunder(funderId: string): Promise<FunderNameRow | undefined> {
  return db().prepare<FunderNameRow>("SELECT id, workspace_id, legal_name FROM mca_funders WHERE id = ?").get(funderId)
}

async function findDerivative(originalDocumentId: string, funderId: string, templateVersion: number): Promise<DerivativeRow | undefined> {
  return db().prepare<DerivativeRow>(
    "SELECT * FROM mca_outgoing_derivatives WHERE original_document_id = ? AND funder_id = ? AND stage = ? AND template_version = ?",
  ).get(originalDocumentId, funderId, STAMP_STAGE, templateVersion)
}

async function findDerivativeByDocumentId(documentId: string): Promise<DerivativeRow | undefined> {
  return db().prepare<DerivativeRow>("SELECT * FROM mca_outgoing_derivatives WHERE document_id = ?").get(documentId)
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
  if (!existing) throw new AppError(500, "stamp_persist_failed", "The stamped derivative could not be recorded.")
  return existing
}

async function storeDerivativeBytes(key: string, bytes: Uint8Array, expectedChecksum: string): Promise<void> {
  const storage = documentStorage()
  try {
    const existing = await storage.get(key)
    if (checksumOf(existing) !== expectedChecksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved stamp storage contains different content.")
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
      throw new AppError(409, "immutable_storage_conflict", "The reserved stamp storage contains different content.")
    }
  }
}

interface PageStampLayout {
  x: number
  y: number
  size: number
  lines: string[]
  width: number
  height: number
  fitted: boolean
}

function layoutStamp(page: PDFPage, font: PDFFont, text: string): PageStampLayout {
  const { width, height } = page.getSize()
  let margin = Math.min(SAFE_MARGIN, Math.max(MIN_MARGIN, Math.min(width, height) / 8))
  let size = STAMP_FONT_SIZE
  let fitted = true
  const maxWidth = Math.max(24, width - margin * 2)
  let lines = wrapText(text, font, size, maxWidth)
  if (lines.length > 2) {
    size = 7
    lines = wrapText(text, font, size, maxWidth).slice(0, 2)
    fitted = wrapText(text, font, size, maxWidth).length <= 2
  }
  const lineHeight = size === STAMP_FONT_SIZE ? STAMP_LINE_HEIGHT : 9
  const blockWidth = Math.max(...lines.map((line) => font.widthOfTextAtSize(line, size)))
  const blockHeight = lines.length * lineHeight
  if (margin + blockHeight + STAMP_PADDING > height) {
    margin = MIN_MARGIN
    fitted = height >= MIN_MARGIN + blockHeight
  }
  return {
    x: margin,
    y: margin,
    size,
    lines,
    width: blockWidth,
    height: blockHeight,
    fitted,
  }
}

function drawStamp(page: PDFPage, font: PDFFont, layout: PageStampLayout): void {
  const lineHeight = layout.size === STAMP_FONT_SIZE ? STAMP_LINE_HEIGHT : 9
  page.drawRectangle({
    x: layout.x - STAMP_PADDING,
    y: layout.y - STAMP_PADDING,
    width: layout.width + STAMP_PADDING * 2,
    height: layout.height + STAMP_PADDING * 2,
    color: rgb(1, 1, 1),
    opacity: 0.88,
    borderColor: rgb(0.16, 0.22, 0.32),
    borderWidth: 0.4,
  })
  layout.lines.forEach((line, index) => {
    page.drawText(line, {
      x: layout.x,
      y: layout.y + (layout.lines.length - 1 - index) * lineHeight,
      size: layout.size,
      font,
      color: rgb(0.12, 0.18, 0.32),
    })
  })
}

async function renderStampedPdf(bytes: Uint8Array, stampText: string): Promise<{ bytes: Uint8Array; pages: StampPagePreview[] }> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    throw new AppError(422, "stamp_source_invalid", "The original document is not a readable PDF.")
  }
  if (pdf.isEncrypted) throw new AppError(422, "stamp_source_invalid", "Encrypted PDFs cannot be stamped.")
  const pages = pdf.getPages()
  if (!pages.length) throw new AppError(422, "stamp_source_invalid", "The original PDF has no pages to stamp.")
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  const previews: StampPagePreview[] = []
  pages.forEach((page, index) => {
    const layout = layoutStamp(page, font, stampText)
    drawStamp(page, font, layout)
    const size = page.getSize()
    previews.push({
      page: index + 1,
      width: size.width,
      height: size.height,
      rotation: page.getRotation().angle,
      stampX: layout.x,
      stampY: layout.y,
      stampWidth: layout.width,
      stampHeight: layout.height,
      fitted: layout.fitted,
    })
  })
  pdf.setProducer("MCA Destination Stamp")
  pdf.setCreator("MCA Destination Stamp")
  pdf.setModificationDate(new Date(0))
  return { bytes: new Uint8Array(await pdf.save({ useObjectStreams: false })), pages: previews }
}

function isPdf(mimeType: string, bytes: Uint8Array): boolean {
  return mimeType === "application/pdf" && bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
}

function isBankStatement(category: string): boolean {
  return category.trim().toLowerCase() === "statement"
}

function skipReason(settings: StampSettings, funderId: string, pdf: boolean, category: string): SkipReason | undefined {
  if (!settings.enabled) return "disabled"
  if (settings.excludedFunderIds.includes(funderId)) return "excluded"
  if (!isBankStatement(category)) return "not_statement"
  if (!pdf) return "not_pdf"
  return undefined
}

async function originalBytes(row: OriginalRow, expectedChecksum?: string): Promise<Uint8Array> {
  if (!isDocumentReady(row.processing_state)) {
    throw new AppError(423, "document_not_clean", "This document is unavailable. Complete its upload before using it.")
  }
  const bytes = await documentStorage().get(row.storage_key)
  const stored = checksumOf(bytes)
  if (stored !== row.checksum) throw new AppError(409, "immutable_storage_conflict", "The reserved document storage contains different content.")
  if (expectedChecksum && expectedChecksum !== row.checksum) {
    throw new AppError(409, "original_checksum_mismatch", "The frozen original checksum does not match the stored document.")
  }
  return bytes
}

async function inspectStampPages(bytes: Uint8Array, stampText: string): Promise<StampPagePreview[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  const font = await pdf.embedFont(StandardFonts.HelveticaBold)
  return pdf.getPages().map((page, index) => {
    const layout = layoutStamp(page, font, stampText)
    const size = page.getSize()
    return {
      page: index + 1,
      width: size.width,
      height: size.height,
      rotation: page.getRotation().angle,
      stampX: layout.x,
      stampY: layout.y,
      stampWidth: layout.width,
      stampHeight: layout.height,
      fitted: layout.fitted,
    }
  })
}

async function persistStamp(input: {
  original: OriginalRow
  funderId: string
  stampText: string
  settings: StampSettings
  expectedChecksum?: string
  actor?: DealActor
}): Promise<{ document: OutgoingDocument; replayed: boolean; bytes: Uint8Array; pages: StampPagePreview[] }> {
  if (input.expectedChecksum && input.expectedChecksum !== input.original.checksum) {
    throw new AppError(409, "original_checksum_mismatch", "The frozen original checksum does not match the stored document.")
  }
  const cached = await findDerivative(input.original.id, input.funderId, input.settings.templateVersion)
  if (cached) {
    if (cached.original_checksum !== input.original.checksum) {
      throw new AppError(409, "stamp_identity_conflict", "The cached stamp does not match the immutable original.")
    }
    const bytes = await documentStorage().get(derivativeStorageKey(cached.workspace_id, cached.document_id))
    return { document: toOutgoing(cached), replayed: true, bytes, pages: [] }
  }

  const source = await originalBytes(input.original, input.expectedChecksum)
  const rendered = await renderStampedPdf(source, input.stampText)
  const outputChecksum = checksumOf(rendered.bytes)
  const id = newId()
  await storeDerivativeBytes(derivativeStorageKey(input.original.workspace_id, id), rendered.bytes, outputChecksum)
  const row = await insertDerivative({
    id,
    workspace_id: input.original.workspace_id,
    original_document_id: input.original.id,
    funder_id: input.funderId,
    job_id: null,
    stage: STAMP_STAGE,
    document_id: id,
    original_checksum: input.original.checksum,
    output_checksum: outputChecksum,
    template_version: input.settings.templateVersion,
    byte_length: rendered.bytes.byteLength,
    created_at: nowIso(),
  })
  if (row.document_id !== id) {
    const winner = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    return { document: toOutgoing(row), replayed: true, bytes: winner, pages: rendered.pages }
  }
  const context = input.actor ?? { workspaceId: input.original.workspace_id, userId: null, source: "system" as const }
  await recordAuditEvent({
    context,
    action: "submission_stamp.generated",
    resourceType: "document",
    resourceId: input.original.id,
    metadata: {
      funderId: input.funderId,
      derivativeId: row.document_id,
      templateVersion: Number(row.template_version),
      outputChecksum: row.output_checksum,
      pageCount: rendered.pages.length,
    },
    correlationId: input.actor?.correlationId,
  })
  return { document: toOutgoing(row), replayed: false, bytes: rendered.bytes, pages: rendered.pages }
}

function asOriginalOutgoing(row: OriginalRow): OutgoingDocument {
  return {
    documentId: row.id,
    originalDocumentId: row.id,
    checksum: row.checksum,
    byteLength: Number(row.byte_length),
    stage: "original",
  }
}

/** Destination-specific PDF stamps from immutable originals. Called by conductor-owned package.ts. */
export async function applyStamp(documents: OutgoingDocument[], funderId: string): Promise<OutgoingDocument[]> {
  if (!documents.length) return documents
  const funder = funderId ? await loadFunder(funderId) : undefined
  const firstOriginal = await loadOriginal(documents[0].originalDocumentId)
  const workspaceId = funder?.workspace_id ?? firstOriginal?.workspace_id
  if (!workspaceId) return documents
  const settings = await settingsForWorkspace(workspaceId)
  if (!settings.enabled || settings.excludedFunderIds.includes(funderId)) return documents
  if (!funder || funder.workspace_id !== workspaceId) {
    throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  }
  const stampText = stampTextForFunder(funder.legal_name)
  const next: OutgoingDocument[] = []
  for (const document of documents) {
    const original = await loadOriginal(document.originalDocumentId)
    if (!original || original.workspace_id !== workspaceId) {
      throw new AppError(404, "document_not_found", "The requested document was not found.")
    }
    if (!isBankStatement(original.category)) {
      next.push(asOriginalOutgoing(original))
      continue
    }
    const bytes = await originalBytes(original, document.checksum || undefined)
    if (!isPdf(original.mime_type, bytes)) {
      next.push(asOriginalOutgoing(original))
      continue
    }
    const stamped = await persistStamp({
      original,
      funderId,
      stampText,
      settings,
      expectedChecksum: document.checksum || undefined,
    })
    next.push(stamped.document)
  }
  return next
}

export async function previewStamp(actor: DealActor, input: { documentId?: unknown; funderId?: unknown }): Promise<StampPreviewResult> {
  const documentId = typeof input.documentId === "string" ? input.documentId.trim() : ""
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!documentId) invalid("documentId", "Choose a document to preview.")
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const record = await getDocument(actor, documentId)
  const settings = await settingsForWorkspace(actor.workspaceId)
  const funder = await loadFunder(funderId)
  if (!funder || funder.workspace_id !== actor.workspaceId) {
    throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  }
  const content = await getDocumentContent(actor, documentId)
  const pdf = isPdf(record.mimeType, content.bytes)
  const reason = skipReason(settings, funderId, pdf, record.category)
  if (reason) {
    return {
      skipped: true,
      reason,
      originalDocumentId: record.id,
      originalChecksum: record.checksum,
      funderId,
      funderLegalName: funder.legal_name,
      stampText: stampTextForFunder(funder.legal_name),
      templateVersion: settings.templateVersion,
      pages: [],
      replayed: false,
    }
  }
  const stamped = await persistStamp({
    original: {
      id: record.id,
      workspace_id: record.workspaceId,
      deal_id: record.dealId,
      storage_key: record.storageKey,
      checksum: record.checksum,
      byte_length: record.byteLength,
      mime_type: record.mimeType,
      processing_state: record.processingState,
      category: record.category,
    },
    funderId,
    stampText: stampTextForFunder(funder.legal_name),
    settings,
    expectedChecksum: record.checksum,
    actor,
  })
  const stampText = stampTextForFunder(funder.legal_name)
  const pages = stamped.pages.length ? stamped.pages : await inspectStampPages(content.bytes, stampText)
  return {
    skipped: false,
    originalDocumentId: record.id,
    originalChecksum: record.checksum,
    funderId,
    funderLegalName: funder.legal_name,
    stampText: stampTextForFunder(funder.legal_name),
    templateVersion: settings.templateVersion,
    derivative: stamped.document,
    pages,
    replayed: stamped.replayed,
  }
}

export async function getOutgoingDocumentBytes(document: OutgoingDocument): Promise<Uint8Array> {
  if (document.stage === STAMP_STAGE) {
    const row = await findDerivativeByDocumentId(document.documentId)
    if (!row) throw new AppError(404, "document_not_found", "The requested stamp derivative was not found.")
    const bytes = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    if (checksumOf(bytes) !== row.output_checksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved stamp storage contains different content.")
    }
    return bytes
  }
  const original = await loadOriginal(document.originalDocumentId)
  if (!original) throw new AppError(404, "document_not_found", "The requested document was not found.")
  return originalBytes(original, document.checksum || undefined)
}
