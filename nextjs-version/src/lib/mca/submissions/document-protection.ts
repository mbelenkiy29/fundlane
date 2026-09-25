import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { recordAuditEvent } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { getDocument, getDocumentContent } from "../documents/service"
import { AppError } from "../errors"
import { getFunder } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { OutgoingDocument } from "./contracts"
import { applyStamp, getStampSettings, stampTextForFunder, updateStampSettings } from "./stamps"
import {
  applyWatermark,
  getOutgoingDocumentBytes,
  getWatermarkSettings,
  updateWatermarkSettings,
  uploadWatermarkLogo,
} from "./watermarks"

const PREVIEW_TTL_MS = 5 * 60_000
const TOKEN_KIND = "docprot"

export type ProtectionLogoSource = "document" | "workspace" | "none"
export type ProtectionSkipReason = "disabled" | "not_pdf"
export type ProtectionStage = OutgoingDocument["stage"]

export interface DocumentProtectionSettings {
  enabled: boolean
  hasLogo: boolean
  logoSource: ProtectionLogoSource
  stampEnabled: boolean
  watermarkEnabled: boolean
  updatedAt: string | null
}

export interface DocumentProtectionSettingsView {
  settings: DocumentProtectionSettings
  canManage: boolean
}

export interface UpdateDocumentProtectionInput {
  enabled?: unknown
}

export interface ProtectedPreviewResult {
  skipped: boolean
  reason?: ProtectionSkipReason
  originalDocumentId: string
  originalChecksum: string
  funderId: string
  funderLegalName: string
  stampText: string
  stamped: boolean
  watermarked: boolean
  stage: ProtectionStage
  previewUrl?: string
  expiresAt?: string
}

type PreviewTokenPayload = {
  k: typeof TOKEN_KIND
  o: string
  d: string
  g: ProtectionStage
  c: string
  w: string
  e: number
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

function laterTimestamp(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function combineSettings(
  stamp: Awaited<ReturnType<typeof getStampSettings>>,
  watermark: Awaited<ReturnType<typeof getWatermarkSettings>>,
): DocumentProtectionSettingsView {
  return {
    settings: {
      enabled: stamp.settings.enabled,
      hasLogo: watermark.settings.hasLogo,
      logoSource: watermark.settings.logoSource,
      stampEnabled: stamp.settings.enabled,
      watermarkEnabled: watermark.settings.enabled,
      updatedAt: laterTimestamp(stamp.settings.updatedAt, watermark.settings.updatedAt),
    },
    canManage: stamp.canManage && watermark.canManage,
  }
}

export async function getDocumentProtectionSettings(actor: DealActor): Promise<DocumentProtectionSettingsView> {
  const [stamp, watermark] = await Promise.all([getStampSettings(actor), getWatermarkSettings(actor)])
  return combineSettings(stamp, watermark)
}

export async function updateDocumentProtectionSettings(
  actor: DealActor,
  input: UpdateDocumentProtectionInput,
): Promise<DocumentProtectionSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update document protection.")
  if (typeof input.enabled !== "boolean") invalid("enabled", "enabled must be true or false.")
  const current = await getWatermarkSettings(actor)
  const watermarkEnabled = input.enabled && current.settings.hasLogo
  await updateStampSettings(actor, { enabled: input.enabled })
  await updateWatermarkSettings(actor, { enabled: watermarkEnabled })
  const settings = await getDocumentProtectionSettings(actor)
  await recordAuditEvent({
    context: actor,
    action: "document_protection.settings_updated",
    resourceType: "document_protection",
    resourceId: actor.workspaceId,
    metadata: {
      enabled: settings.settings.enabled,
      watermarkEnabled: settings.settings.watermarkEnabled,
      hasLogo: settings.settings.hasLogo,
    },
    correlationId: actor.correlationId,
  })
  return settings
}

export async function uploadDocumentProtectionLogo(
  actor: DealActor,
  input: { documentId?: unknown; filename?: unknown; mimeType?: unknown; base64?: unknown },
): Promise<DocumentProtectionSettingsView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update document protection.")
  await uploadWatermarkLogo(actor, input)
  const current = await getDocumentProtectionSettings(actor)
  if (current.settings.enabled) {
    await updateWatermarkSettings(actor, { enabled: true })
  }
  return getDocumentProtectionSettings(actor)
}

export async function requireDocumentProtectionAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDocumentProtectionPreview(request: Request): Promise<DealActor> {
  assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDocumentProtectionDownload(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

function asOriginal(record: { id: string; checksum: string; byteLength: number }): OutgoingDocument {
  return {
    documentId: record.id,
    originalDocumentId: record.id,
    checksum: record.checksum,
    byteLength: record.byteLength,
    stage: "original",
  }
}

function isPdf(mimeType: string, bytes: Uint8Array): boolean {
  return mimeType === "application/pdf" || (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-")
}

function tokenSecret(): Buffer {
  const configured = process.env.MCA_DOCUMENT_TOKEN_SECRET
  if (configured && configured.length >= 32) return Buffer.from(configured)
  if (process.env.NODE_ENV === "production") {
    throw new AppError(503, "download_tokens_unavailable", "Configure MCA_DOCUMENT_TOKEN_SECRET before issuing download links.")
  }
  return createHash("sha256").update("mca-local-document-token-secret").digest()
}

function signToken(payload: string): string {
  return createHmac("sha256", tokenSecret()).update(payload).digest("base64url")
}

function issuePreviewToken(input: Omit<PreviewTokenPayload, "k" | "e">, now: number): { token: string; expiresAt: string } {
  const expires = now + PREVIEW_TTL_MS
  const payload = Buffer.from(JSON.stringify({ k: TOKEN_KIND, ...input, e: expires } satisfies PreviewTokenPayload)).toString("base64url")
  return { token: `${payload}.${signToken(payload)}`, expiresAt: new Date(expires).toISOString() }
}

function parsePreviewToken(token: string, actor: DealActor, now: number): PreviewTokenPayload {
  const [payload, signature] = token.split(".")
  if (!payload || !signature || token.split(".").length !== 2) {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
  const expected = Buffer.from(signToken(payload))
  const supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
  let data: PreviewTokenPayload
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewTokenPayload
  } catch {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
  if (
    data.k !== TOKEN_KIND
    || typeof data.o !== "string"
    || typeof data.d !== "string"
    || typeof data.g !== "string"
    || typeof data.c !== "string"
    || data.w !== actor.workspaceId
    || typeof data.e !== "number"
    || data.e < now
  ) {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
  return data
}

function previewPath(token: string): string {
  return `/api/mca/submissions/document-protection/preview/${encodeURIComponent(token)}`
}

export async function previewProtectedDocument(
  actor: DealActor,
  input: { documentId?: unknown; funderId?: unknown },
  now = Date.now(),
): Promise<ProtectedPreviewResult> {
  const documentId = typeof input.documentId === "string" ? input.documentId.trim() : ""
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!documentId) invalid("documentId", "Choose a document to preview.")
  if (!funderId) invalid("funderId", "Choose a destination funder.")

  const [record, content, funder, settings] = await Promise.all([
    getDocument(actor, documentId),
    getDocumentContent(actor, documentId),
    getFunder(actor, funderId),
    getDocumentProtectionSettings(actor),
  ])
  const stampText = stampTextForFunder(funder.legalName)
  const base = {
    originalDocumentId: record.id,
    originalChecksum: record.checksum,
    funderId,
    funderLegalName: funder.legalName,
    stampText,
    stamped: false,
    watermarked: false,
    stage: "original" as const,
  }

  if (!settings.settings.enabled) {
    return { skipped: true, reason: "disabled", ...base }
  }
  if (!isPdf(record.mimeType, content.bytes)) {
    return { skipped: true, reason: "not_pdf", ...base }
  }

  const stamped = await applyStamp([asOriginal(record)], funderId)
  const outgoing = (await applyWatermark(stamped, funderId))[0]
  if (!outgoing) {
    throw new AppError(500, "document_protection_preview_failed", "The protected preview could not be created.")
  }
  const issued = issuePreviewToken({
    o: record.id,
    d: outgoing.documentId,
    g: outgoing.stage,
    c: outgoing.checksum,
    w: actor.workspaceId,
  }, now)
  await recordAuditEvent({
    context: actor,
    action: "document_protection.previewed",
    resourceType: "document",
    resourceId: record.id,
    metadata: {
      funderId,
      stage: outgoing.stage,
      stamped: outgoing.stage !== "original",
      watermarked: outgoing.stage === "watermark",
    },
    correlationId: actor.correlationId,
  })
  return {
    skipped: false,
    ...base,
    stamped: outgoing.stage !== "original",
    watermarked: outgoing.stage === "watermark",
    stage: outgoing.stage,
    previewUrl: previewPath(issued.token),
    expiresAt: issued.expiresAt,
  }
}

export function safePreviewFilename(filename: string): string {
  const cleaned = filename.normalize("NFKC").replace(/["\\\r\n]/g, "_").replace(/\s+/g, " ").trim()
  return (cleaned || "statement.pdf").slice(0, 180)
}

export async function redeemProtectedPreview(
  actor: DealActor,
  token: string,
  now = Date.now(),
): Promise<{ filename: string; bytes: Uint8Array }> {
  const payload = parsePreviewToken(token, actor, now)
  const record = await getDocument(actor, payload.o)
  const bytes = await getOutgoingDocumentBytes({
    documentId: payload.d,
    originalDocumentId: payload.o,
    checksum: payload.c,
    byteLength: 0,
    stage: payload.g,
  })
  const checksum = createHash("sha256").update(bytes).digest("hex")
  if (checksum !== payload.c) {
    throw new AppError(404, "download_link_invalid", "This download link is invalid or expired.")
  }
  return { filename: safePreviewFilename(record.displayFilename), bytes }
}
