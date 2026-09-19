import "server-only"

import { isDocumentReady } from "../documents/contracts"

import { createHash } from "node:crypto"
import { crc32 } from "node:zlib"
import { PDFDocument, type PDFPage } from "pdf-lib"
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
import { getOutgoingDocumentBytes as getStampOrOriginalBytes } from "./stamps"

export const WATERMARK_STAGE = "watermark" as const
export const CONTENT_INSET = 48
export const WATERMARK_OPACITY = 0.16
export const WATERMARK_CORNER = "bottom-right" as const

const MAX_EXCLUSIONS = 500
const FUNDER_ID_MAX = 80
const MAX_LOGO_BYTES = 2 * 1024 * 1024
const MAX_LOGO_DIMENSION = 4096
const CORNER_WIDTH_RATIO = 0.25
const CORNER_HEIGHT_RATIO = 0.14
const MAX_LOGO_HEIGHT_PT = 72
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"])

type SkipReason = "disabled" | "excluded" | "not_pdf" | "no_logo"
type LogoSource = "document" | "workspace" | "none"
type ImageMime = "image/png" | "image/jpeg"

export interface WatermarkSettings {
  enabled: boolean
  logoDocumentId: string | null
  excludedFunderIds: string[]
  templateVersion: number
  updatedAt: string | null
  updatedByUserId: string | null
  workspaceLogoUrl: string | null
  hasLogo: boolean
  logoSource: LogoSource
}

export interface WatermarkSettingsView {
  settings: WatermarkSettings
  canManage: boolean
}

export interface UpdateWatermarkSettingsInput {
  enabled?: boolean
  excludedFunderIds?: string[]
  logoDocumentId?: string | null
}

export interface WatermarkPagePreview {
  page: number
  width: number
  height: number
  rotation: number
  watermarkX: number
  watermarkY: number
  watermarkWidth: number
  watermarkHeight: number
  opacity: number
  inset: number
  corner: typeof WATERMARK_CORNER
  fitted: boolean
}

export interface WatermarkPreviewResult {
  skipped: boolean
  reason?: SkipReason
  originalDocumentId: string
  originalChecksum: string
  funderId: string
  templateVersion: number
  logoSource: LogoSource
  derivative?: OutgoingDocument
  pages: WatermarkPagePreview[]
  replayed: boolean
}

type WatermarkSettingsRow = {
  workspace_id: string
  enabled: number | string | boolean
  logo_document_id: string | null
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
}

type LogoDocumentRow = {
  id: string
  workspace_id: string
  storage_key: string
  checksum: string
  mime_type: string
  processing_state: string
  byte_length: number | string
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

type WorkspaceLogoRow = {
  id: string
  logo_url: string | null
}

interface PreparedLogo {
  bytes: Uint8Array
  mime: ImageMime
  width: number
  height: number
  source: Exclude<LogoSource, "none">
}

interface PageWatermarkLayout {
  x: number
  y: number
  width: number
  height: number
  opacity: number
  inset: number
  fitted: boolean
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
  return `${workspaceId}/derivatives/watermark/${documentId}`
}

function logoStorageKey(workspaceId: string, logoId: string): string {
  return `${workspaceId}/derivatives/watermark-logo/${logoId}`
}

function publicWorkspaceLogoUrl(url: string | null | undefined): string | null {
  if (!url || url.trim().toLowerCase().startsWith("data:")) return null
  return url
}

function defaultSettings(workspaceLogoUrl: string | null = null): WatermarkSettings {
  const logoSource: LogoSource = dataUriLogo(workspaceLogoUrl) ? "workspace" : "none"
  return {
    enabled: false,
    logoDocumentId: null,
    excludedFunderIds: [],
    templateVersion: 1,
    updatedAt: null,
    updatedByUserId: null,
    workspaceLogoUrl: publicWorkspaceLogoUrl(workspaceLogoUrl),
    hasLogo: logoSource !== "none",
    logoSource,
  }
}

function mapSettings(row: WatermarkSettingsRow, workspaceLogoUrl: string | null): WatermarkSettings {
  const excluded = parseJson<unknown>(row.exclusions_json, [])
  const logoDocumentId = row.logo_document_id?.trim() || null
  const logoSource: LogoSource = logoDocumentId ? "document" : dataUriLogo(workspaceLogoUrl) ? "workspace" : "none"
  return {
    enabled: asBooleanFlag(row.enabled),
    logoDocumentId,
    excludedFunderIds: Array.isArray(excluded) ? excluded.filter((item): item is string => typeof item === "string") : [],
    templateVersion: Number(row.template_version) || 1,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id,
    workspaceLogoUrl: publicWorkspaceLogoUrl(workspaceLogoUrl),
    hasLogo: logoSource !== "none",
    logoSource,
  }
}

async function workspaceLogoUrl(workspaceId: string): Promise<string | null> {
  const row = await db().prepare<WorkspaceLogoRow>("SELECT id, logo_url FROM workspaces WHERE id = ?").get(workspaceId)
  return row?.logo_url ?? null
}

async function readSettingsRow(workspaceId: string): Promise<WatermarkSettingsRow | undefined> {
  return db().prepare<WatermarkSettingsRow>("SELECT * FROM mca_watermark_settings WHERE workspace_id = ?").get(workspaceId)
}

async function settingsForWorkspace(workspaceId: string): Promise<WatermarkSettings> {
  const [row, logoUrl] = await Promise.all([readSettingsRow(workspaceId), workspaceLogoUrl(workspaceId)])
  return row ? mapSettings(row, logoUrl) : defaultSettings(logoUrl)
}

export async function getWatermarkSettings(actor: DealActor): Promise<WatermarkSettingsView> {
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

function parseLogoDocumentId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== "string" || !value.trim()) invalid("logoDocumentId", "Provide a document ID or null to clear the logo.")
  const id = value.trim()
  if (id.length > 80) invalid("logoDocumentId", "logoDocumentId is too long.")
  return id
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function imageMime(bytes: Uint8Array): ImageMime | undefined {
  if (isPng(bytes)) return "image/png"
  if (isJpeg(bytes)) return "image/jpeg"
  return undefined
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24 | (bytes[offset + 1] ?? 0) << 16 | (bytes[offset + 2] ?? 0) << 8 | (bytes[offset + 3] ?? 0)) >>> 0
}

function pngDimensions(ihdr: Uint8Array): { width: number; height: number } {
  if (ihdr.length < 8) invalid("logo", "The PNG logo is missing an IHDR chunk.")
  return { width: readU32(ihdr, 0), height: readU32(ihdr, 4) }
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0x00 || marker === 0xff) {
      offset += 1
      continue
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (length < 2 || offset + 2 + length > bytes.length) break
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0), width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0) }
    }
    offset += 2 + length
  }
  invalid("logo", "The JPEG logo does not contain image dimensions.")
}

function assertImageSize(width: number, height: number, field = "logo"): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    invalid(field, "The logo image dimensions are invalid.")
  }
  if (width > MAX_LOGO_DIMENSION || height > MAX_LOGO_DIMENSION) {
    invalid(field, `Use a logo at most ${MAX_LOGO_DIMENSION}px on each side.`)
  }
}

function sanitizePng(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  if (!isPng(bytes)) invalid("logo", "The logo is not a readable PNG.")
  const kept: Array<{ type: string; data: Buffer }> = []
  let offset = 8
  let width = 0
  let height = 0
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset)
    if (offset + 12 + length > bytes.length) invalid("logo", "The PNG logo is truncated.")
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("ascii")
    const data = Buffer.from(bytes.subarray(offset + 8, offset + 8 + length))
    const expectedCrc = readU32(bytes, offset + 8 + length)
    const actualCrc = crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0
    if (expectedCrc !== actualCrc) invalid("logo", "The PNG logo failed checksum validation.")
    if (type === "IHDR") {
      const size = pngDimensions(data)
      width = size.width
      height = size.height
    }
    if (PNG_KEEP.has(type)) kept.push({ type, data })
    offset += 12 + length
    if (type === "IEND") break
  }
  if (!kept.length || kept[0]?.type !== "IHDR" || kept.at(-1)?.type !== "IEND" || !kept.some((chunk) => chunk.type === "IDAT")) {
    invalid("logo", "The PNG logo is missing required chunks.")
  }
  assertImageSize(width, height)
  const parts: Buffer[] = [PNG_SIGNATURE]
  for (const chunk of kept) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(chunk.data.length)
    const type = Buffer.from(chunk.type, "ascii")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([type, chunk.data])) >>> 0)
    parts.push(len, type, chunk.data, crc)
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), width, height }
}

function prepareImageBytes(bytes: Uint8Array, declaredMime?: string): { bytes: Uint8Array; mime: ImageMime; width: number; height: number } {
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_LOGO_BYTES) {
    invalid("logo", `Logo files must be between 8 bytes and ${MAX_LOGO_BYTES} bytes.`)
  }
  const mime = imageMime(bytes)
  if (!mime) invalid("logo", "Upload a PNG or JPEG broker logo.")
  if (declaredMime && declaredMime !== mime && !(declaredMime === "image/jpg" && mime === "image/jpeg")) {
    invalid("logo", "The file contents do not match the declared PNG or JPEG type.")
  }
  if (mime === "image/png") {
    const sanitized = sanitizePng(bytes)
    return { bytes: sanitized.bytes, mime, width: sanitized.width, height: sanitized.height }
  }
  const size = jpegDimensions(bytes)
  assertImageSize(size.width, size.height)
  return { bytes: new Uint8Array(bytes), mime, width: size.width, height: size.height }
}

function dataUriLogo(url: string | null | undefined): { bytes: Uint8Array; mime: ImageMime } | undefined {
  if (!url) return undefined
  const match = /^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim())
  if (!match) return undefined
  const mime: ImageMime = match[1].toLowerCase().includes("png") ? "image/png" : "image/jpeg"
  const bytes = new Uint8Array(Buffer.from(match[2].replace(/\s+/g, ""), "base64"))
  if (!bytes.byteLength) return undefined
  return { bytes, mime }
}

async function loadLogoDocument(workspaceId: string, logoId: string): Promise<LogoDocumentRow | undefined> {
  return db().prepare<LogoDocumentRow>(
    "SELECT id, workspace_id, storage_key, checksum, mime_type, processing_state, byte_length FROM mca_documents WHERE id = ? AND workspace_id = ?",
  ).get(logoId, workspaceId)
}

async function storageGet(key: string): Promise<Uint8Array | undefined> {
  try {
    return await documentStorage().get(key)
  } catch {
    return undefined
  }
}

async function assertLogoAvailable(workspaceId: string, logoId: string): Promise<void> {
  const document = await loadLogoDocument(workspaceId, logoId)
  if (document) {
    if (!isDocumentReady(document.processing_state)) {
      throw new AppError(423, "document_not_clean", "This document is unavailable. Complete its upload before using it.")
    }
    if (document.mime_type !== "image/png" && document.mime_type !== "image/jpeg") {
      invalid("logoDocumentId", "Choose a PNG or JPEG document as the broker logo.")
    }
    return
  }
  const stored = await storageGet(logoStorageKey(workspaceId, logoId))
  if (!stored || !imageMime(stored)) invalid("logoDocumentId", "The requested logo was not found.")
}

async function resolveLogo(workspaceId: string, settings: WatermarkSettings): Promise<PreparedLogo | undefined> {
  if (settings.logoDocumentId) {
    const document = await loadLogoDocument(workspaceId, settings.logoDocumentId)
    if (document) {
      if (!isDocumentReady(document.processing_state)) {
        throw new AppError(423, "document_not_clean", "This document is unavailable. Complete its upload before using it.")
      }
      const stored = await documentStorage().get(document.storage_key)
      if (checksumOf(stored) !== document.checksum) {
        throw new AppError(409, "immutable_storage_conflict", "The reserved document storage contains different content.")
      }
      const prepared = prepareImageBytes(stored, document.mime_type)
      return { ...prepared, source: "document" }
    }
    const stored = await storageGet(logoStorageKey(workspaceId, settings.logoDocumentId))
    if (!stored) throw new AppError(404, "document_not_found", "The requested logo was not found.")
    const prepared = prepareImageBytes(stored)
    return { ...prepared, source: "document" }
  }
  const dataUri = dataUriLogo(await workspaceLogoUrl(workspaceId))
  if (!dataUri) return undefined
  const prepared = prepareImageBytes(dataUri.bytes, dataUri.mime)
  return { ...prepared, source: "workspace" }
}

async function persistSettingsRow(actor: DealActor, input: {
  enabled: boolean
  excludedFunderIds: string[]
  logoDocumentId: string | null
}): Promise<WatermarkSettings> {
  const now = nowIso()
  const row = await db().prepare<WatermarkSettingsRow>(`INSERT INTO mca_watermark_settings
      (workspace_id, enabled, logo_document_id, exclusions_json, template_version, updated_at, updated_by_user_id)
      VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT (workspace_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        logo_document_id = EXCLUDED.logo_document_id,
        exclusions_json = EXCLUDED.exclusions_json,
        template_version = mca_watermark_settings.template_version + 1,
        updated_at = EXCLUDED.updated_at,
        updated_by_user_id = EXCLUDED.updated_by_user_id
      RETURNING *`).get(
    actor.workspaceId,
    input.enabled ? 1 : 0,
    input.logoDocumentId,
    JSON.stringify(input.excludedFunderIds),
    now,
    actor.userId,
  )
  const logoUrl = await workspaceLogoUrl(actor.workspaceId)
  return row ? mapSettings(row, logoUrl) : { ...defaultSettings(logoUrl), ...input, updatedAt: now, updatedByUserId: actor.userId, hasLogo: Boolean(input.logoDocumentId) || defaultSettings(logoUrl).hasLogo, logoSource: input.logoDocumentId ? "document" : defaultSettings(logoUrl).logoSource }
}

export async function updateWatermarkSettings(actor: DealActor, input: UpdateWatermarkSettingsInput): Promise<WatermarkSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update watermark settings.")
  if (input.enabled === undefined && input.excludedFunderIds === undefined && input.logoDocumentId === undefined) {
    invalid("enabled", "Provide enabled, excludedFunderIds, or logoDocumentId.")
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    invalid("enabled", "enabled must be true or false.")
  }
  const current = await settingsForWorkspace(actor.workspaceId)
  const enabled = input.enabled ?? current.enabled
  const excludedFunderIds = input.excludedFunderIds !== undefined ? parseExcludedFunderIds(input.excludedFunderIds) : current.excludedFunderIds
  const logoDocumentId = input.logoDocumentId !== undefined ? parseLogoDocumentId(input.logoDocumentId) : current.logoDocumentId
  if (logoDocumentId) await assertLogoAvailable(actor.workspaceId, logoDocumentId)
  const settings = await persistSettingsRow(actor, { enabled, excludedFunderIds, logoDocumentId })
  await recordAuditEvent({
    context: actor,
    action: "submission_watermark.settings_updated",
    resourceType: "watermark_settings",
    resourceId: actor.workspaceId,
    metadata: {
      enabled: settings.enabled,
      excludedCount: settings.excludedFunderIds.length,
      templateVersion: settings.templateVersion,
      logoDocumentId: settings.logoDocumentId,
      logoSource: settings.logoSource,
    },
    correlationId: actor.correlationId,
  })
  return { settings, canManage: true }
}

export async function uploadWatermarkLogo(actor: DealActor, input: {
  documentId?: unknown
  filename?: unknown
  mimeType?: unknown
  base64?: unknown
}): Promise<WatermarkSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update watermark settings.")
  const current = await settingsForWorkspace(actor.workspaceId)
  let logoDocumentId: string
  if (typeof input.documentId === "string" && input.documentId.trim()) {
    if (input.base64 !== undefined) invalid("documentId", "Provide either documentId or logo file bytes, not both.")
    logoDocumentId = parseLogoDocumentId(input.documentId) ?? invalid("documentId", "Provide a document ID.")
    await assertLogoAvailable(actor.workspaceId, logoDocumentId)
  } else if (typeof input.base64 === "string" && input.base64.trim()) {
    const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : ""
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/jpg") {
      invalid("mimeType", "Upload a PNG or JPEG broker logo.")
    }
    const filename = typeof input.filename === "string" ? input.filename.trim() : ""
    if (!filename) invalid("filename", "Provide a logo filename.")
    let decoded: Buffer
    try {
      decoded = Buffer.from(input.base64.replace(/\s+/g, ""), "base64")
    } catch {
      invalid("base64", "Logo bytes must be valid base64.")
    }
    if (!decoded.byteLength) invalid("base64", "Logo bytes must be valid base64.")
    const prepared = prepareImageBytes(new Uint8Array(decoded), mimeType === "image/jpg" ? "image/jpeg" : mimeType)
    logoDocumentId = newId()
    await documentStorage().putImmutable(logoStorageKey(actor.workspaceId, logoDocumentId), prepared.bytes)
  } else {
    invalid("documentId", "Provide a document ID or PNG/JPEG logo bytes.")
  }
  const settings = await persistSettingsRow(actor, {
    enabled: current.enabled,
    excludedFunderIds: current.excludedFunderIds,
    logoDocumentId,
  })
  await recordAuditEvent({
    context: actor,
    action: "submission_watermark.logo_updated",
    resourceType: "watermark_settings",
    resourceId: actor.workspaceId,
    metadata: { logoDocumentId, templateVersion: settings.templateVersion },
    correlationId: actor.correlationId,
  })
  return { settings, canManage: true }
}

export async function requireWatermarkAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireWatermarkPreview(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
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
  ).get(originalDocumentId, funderId, WATERMARK_STAGE, templateVersion)
}

async function findDerivativeByDocumentId(documentId: string): Promise<DerivativeRow | undefined> {
  return db().prepare<DerivativeRow>("SELECT * FROM mca_outgoing_derivatives WHERE document_id = ? AND stage = ?").get(documentId, WATERMARK_STAGE)
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
  if (!existing) throw new AppError(500, "watermark_persist_failed", "The watermarked derivative could not be recorded.")
  return existing
}

async function storeDerivativeBytes(key: string, bytes: Uint8Array, expectedChecksum: string): Promise<void> {
  const storage = documentStorage()
  try {
    const existing = await storage.get(key)
    if (checksumOf(existing) !== expectedChecksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved watermark storage contains different content.")
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
      throw new AppError(409, "immutable_storage_conflict", "The reserved watermark storage contains different content.")
    }
  }
}

function layoutWatermark(pageWidth: number, pageHeight: number, imageWidth: number, imageHeight: number): PageWatermarkLayout {
  const shortest = Math.min(pageWidth, pageHeight)
  const inset = shortest < CONTENT_INSET * 2 + 8 ? Math.max(4, Math.floor(shortest / 8)) : CONTENT_INSET
  const maxWidth = Math.max(8, Math.min(pageWidth - inset * 2, pageWidth * CORNER_WIDTH_RATIO))
  const maxHeight = Math.max(8, Math.min(pageHeight - inset * 2, pageHeight * CORNER_HEIGHT_RATIO, MAX_LOGO_HEIGHT_PT))
  const scale = Math.min(maxWidth / Math.max(imageWidth, 1), maxHeight / Math.max(imageHeight, 1), 1)
  const width = imageWidth * scale
  const height = imageHeight * scale
  const x = pageWidth - inset - width
  const y = inset
  const fitted = inset >= CONTENT_INSET
    && x >= inset
    && x + width <= pageWidth - inset
    && y >= inset
    && y + height <= pageHeight - inset
  return { x, y, width, height, opacity: WATERMARK_OPACITY, inset, fitted }
}

function pagePreview(page: PDFPage, index: number, imageWidth: number, imageHeight: number): WatermarkPagePreview {
  const size = page.getSize()
  const layout = layoutWatermark(size.width, size.height, imageWidth, imageHeight)
  return {
    page: index + 1,
    width: size.width,
    height: size.height,
    rotation: page.getRotation().angle,
    watermarkX: layout.x,
    watermarkY: layout.y,
    watermarkWidth: layout.width,
    watermarkHeight: layout.height,
    opacity: layout.opacity,
    inset: layout.inset,
    corner: WATERMARK_CORNER,
    fitted: layout.fitted,
  }
}

async function renderWatermarkedPdf(bytes: Uint8Array, logo: PreparedLogo): Promise<{ bytes: Uint8Array; pages: WatermarkPagePreview[] }> {
  let pdf: PDFDocument
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    throw new AppError(422, "watermark_source_invalid", "The original document is not a readable PDF.")
  }
  if (pdf.isEncrypted) throw new AppError(422, "watermark_source_invalid", "Encrypted PDFs cannot be watermarked.")
  const pages = pdf.getPages()
  if (!pages.length) throw new AppError(422, "watermark_source_invalid", "The original PDF has no pages to watermark.")
  const image = logo.mime === "image/png" ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes)
  const previews: WatermarkPagePreview[] = []
  pages.forEach((page, index) => {
    const layout = layoutWatermark(page.getSize().width, page.getSize().height, image.width, image.height)
    page.drawImage(image, {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.height,
      opacity: layout.opacity,
    })
    previews.push(pagePreview(page, index, image.width, image.height))
  })
  pdf.setProducer("MCA Broker Watermark")
  pdf.setCreator("MCA Broker Watermark")
  pdf.setModificationDate(new Date(0))
  return { bytes: new Uint8Array(await pdf.save({ useObjectStreams: false })), pages: previews }
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-"
}

function skipReason(settings: WatermarkSettings, funderId: string, pdf: boolean, hasLogo: boolean): SkipReason | undefined {
  if (!settings.enabled) return "disabled"
  if (settings.excludedFunderIds.includes(funderId)) return "excluded"
  if (!hasLogo) return "no_logo"
  if (!pdf) return "not_pdf"
  return undefined
}

function toOutgoing(row: DerivativeRow): OutgoingDocument {
  return {
    documentId: row.document_id,
    originalDocumentId: row.original_document_id,
    checksum: row.output_checksum,
    byteLength: Number(row.byte_length),
    stage: WATERMARK_STAGE,
  }
}

async function sourceBytesFor(document: OutgoingDocument): Promise<Uint8Array> {
  if (document.stage === WATERMARK_STAGE) {
    const row = await findDerivativeByDocumentId(document.documentId)
    if (!row) throw new AppError(404, "document_not_found", "The requested watermark derivative was not found.")
    const bytes = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    if (checksumOf(bytes) !== row.output_checksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved watermark storage contains different content.")
    }
    return bytes
  }
  return getStampOrOriginalBytes(document)
}

async function inspectWatermarkPages(bytes: Uint8Array, logo: PreparedLogo): Promise<WatermarkPagePreview[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return pdf.getPages().map((page, index) => pagePreview(page, index, logo.width, logo.height))
}

async function persistWatermark(input: {
  original: OriginalRow
  source: OutgoingDocument
  funderId: string
  settings: WatermarkSettings
  logo: PreparedLogo
  actor?: DealActor
}): Promise<{ document: OutgoingDocument; replayed: boolean; bytes: Uint8Array; pages: WatermarkPagePreview[] }> {
  const cached = await findDerivative(input.original.id, input.funderId, input.settings.templateVersion)
  if (cached) {
    if (cached.original_checksum !== input.original.checksum) {
      throw new AppError(409, "watermark_identity_conflict", "The cached watermark does not match the immutable original.")
    }
    const bytes = await documentStorage().get(derivativeStorageKey(cached.workspace_id, cached.document_id))
    return { document: toOutgoing(cached), replayed: true, bytes, pages: [] }
  }

  const source = await sourceBytesFor(input.source)
  const rendered = await renderWatermarkedPdf(source, input.logo)
  const outputChecksum = checksumOf(rendered.bytes)
  const id = newId()
  await storeDerivativeBytes(derivativeStorageKey(input.original.workspace_id, id), rendered.bytes, outputChecksum)
  const row = await insertDerivative({
    id,
    workspace_id: input.original.workspace_id,
    original_document_id: input.original.id,
    funder_id: input.funderId,
    job_id: null,
    stage: WATERMARK_STAGE,
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
    action: "submission_watermark.generated",
    resourceType: "document",
    resourceId: input.original.id,
    metadata: {
      funderId: input.funderId,
      derivativeId: row.document_id,
      templateVersion: Number(row.template_version),
      outputChecksum: row.output_checksum,
      pageCount: rendered.pages.length,
      logoSource: input.logo.source,
    },
    correlationId: input.actor?.correlationId,
  })
  return { document: toOutgoing(row), replayed: false, bytes: rendered.bytes, pages: rendered.pages }
}

/** Broker-logo PDF watermarks. Called by conductor-owned package.ts after stamps. */
export async function applyWatermark(documents: OutgoingDocument[], funderId: string): Promise<OutgoingDocument[]> {
  if (!documents.length) return documents
  const firstOriginal = await loadOriginal(documents[0].originalDocumentId)
  if (!firstOriginal) return documents
  const workspaceId = firstOriginal.workspace_id
  const settings = await settingsForWorkspace(workspaceId)
  if (!settings.enabled || settings.excludedFunderIds.includes(funderId)) return documents
  const logo = await resolveLogo(workspaceId, settings)
  if (!logo) {
    throw new AppError(409, "watermark_logo_required", "Upload a broker logo before sending watermarked packages.")
  }
  const next: OutgoingDocument[] = []
  for (const document of documents) {
    const original = await loadOriginal(document.originalDocumentId)
    if (!original || original.workspace_id !== workspaceId) {
      throw new AppError(404, "document_not_found", "The requested document was not found.")
    }
    const source = await sourceBytesFor(document)
    if (!isPdf(source)) {
      next.push(document)
      continue
    }
    const watermarked = await persistWatermark({ original, source: document, funderId, settings, logo })
    next.push(watermarked.document)
  }
  return next
}

export async function previewWatermark(actor: DealActor, input: { documentId?: unknown; funderId?: unknown }): Promise<WatermarkPreviewResult> {
  const documentId = typeof input.documentId === "string" ? input.documentId.trim() : ""
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!documentId) invalid("documentId", "Choose a document to preview.")
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const record = await getDocument(actor, documentId)
  const settings = await settingsForWorkspace(actor.workspaceId)
  const funder = await loadFunderWorkspace(funderId)
  if (!funder || funder.workspace_id !== actor.workspaceId) {
    throw new AppError(404, "funder_not_found", "The requested funder was not found.")
  }
  const content = await getDocumentContent(actor, documentId)
  const pdf = isPdf(content.bytes)
  const logo = await resolveLogo(actor.workspaceId, settings)
  const reason = skipReason(settings, funderId, pdf, Boolean(logo))
  if (reason) {
    return {
      skipped: true,
      reason,
      originalDocumentId: record.id,
      originalChecksum: record.checksum,
      funderId,
      templateVersion: settings.templateVersion,
      logoSource: settings.logoSource,
      pages: [],
      replayed: false,
    }
  }
  if (!logo) {
    return {
      skipped: true,
      reason: "no_logo",
      originalDocumentId: record.id,
      originalChecksum: record.checksum,
      funderId,
      templateVersion: settings.templateVersion,
      logoSource: settings.logoSource,
      pages: [],
      replayed: false,
    }
  }
  const original: OriginalRow = {
    id: record.id,
    workspace_id: record.workspaceId,
    deal_id: record.dealId,
    storage_key: record.storageKey,
    checksum: record.checksum,
    byte_length: record.byteLength,
    mime_type: record.mimeType,
    processing_state: record.processingState,
  }
  const source: OutgoingDocument = {
    documentId: record.id,
    originalDocumentId: record.id,
    checksum: record.checksum,
    byteLength: record.byteLength,
    stage: "original",
  }
  const watermarked = await persistWatermark({ original, source, funderId, settings, logo, actor })
  const pages = watermarked.pages.length ? watermarked.pages : await inspectWatermarkPages(content.bytes, logo)
  return {
    skipped: false,
    originalDocumentId: record.id,
    originalChecksum: record.checksum,
    funderId,
    templateVersion: settings.templateVersion,
    logoSource: logo.source,
    derivative: watermarked.document,
    pages,
    replayed: watermarked.replayed,
  }
}

export async function getOutgoingDocumentBytes(document: OutgoingDocument): Promise<Uint8Array> {
  if (document.stage === WATERMARK_STAGE) {
    const row = await findDerivativeByDocumentId(document.documentId)
    if (!row) throw new AppError(404, "document_not_found", "The requested watermark derivative was not found.")
    const bytes = await documentStorage().get(derivativeStorageKey(row.workspace_id, row.document_id))
    if (checksumOf(bytes) !== row.output_checksum) {
      throw new AppError(409, "immutable_storage_conflict", "The reserved watermark storage contains different content.")
    }
    return bytes
  }
  return getStampOrOriginalBytes(document)
}
