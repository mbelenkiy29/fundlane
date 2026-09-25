import "server-only"

import { assertTrustedMutation, requireMembershipAccess, requireWorkspaceAccess } from "../auth"
import { getDatabase, recordAuditEvent, withTransaction } from "../db"
import { actorForDeals } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { getDocument } from "../documents/service"
import { AppError } from "../errors"
import { getFunder } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { canManageWorkspace } from "../policy"
import type { OutgoingDocument } from "./contracts"
import {
  getStampSettings,
  previewStamp,
  stampTextForFunder,
  updateStampSettings,
  type StampPagePreview,
  type StampPreviewResult,
} from "./stamps"
import {
  applyWatermark,
  getOutgoingDocumentBytes,
  getWatermarkSettings,
  updateWatermarkSettings,
  uploadWatermarkLogo,
  type WatermarkSettings,
} from "./watermarks"

export type DocumentProtectionSkipReason = "disabled" | "excluded" | "not_pdf" | "not_statement"

export interface DocumentProtectionSettings {
  enabled: boolean
  stampEnabled: boolean
  watermarkEnabled: boolean
  hasLogo: boolean
  logoSource: WatermarkSettings["logoSource"]
  logoDocumentId: string | null
  stampTemplateVersion: number
  watermarkTemplateVersion: number
  updatedAt: string | null
  updatedByUserId: string | null
}

export interface DocumentProtectionView {
  settings: DocumentProtectionSettings
  canManage: boolean
}

export interface DocumentProtectionPreviewResult {
  skipped: boolean
  reason?: DocumentProtectionSkipReason
  originalDocumentId: string
  originalChecksum: string
  funderId: string
  funderLegalName?: string
  stampText?: string
  watermarkApplied: boolean
  derivative?: OutgoingDocument
  pages: StampPagePreview[]
  replayed: boolean
  downloadPath?: string
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

function skipMessage(reason: DocumentProtectionSkipReason): string {
  if (reason === "disabled") return "Document protection is turned off for this workspace."
  if (reason === "excluded") return "This destination is excluded from document protection."
  if (reason === "not_statement") return "Only outgoing bank statements are stamped and watermarked."
  return "This file is not a readable PDF statement."
}

function downloadPathFor(documentId: string, funderId: string): string {
  return `/api/mca/submissions/document-protection/preview/file?documentId=${encodeURIComponent(documentId)}&funderId=${encodeURIComponent(funderId)}`
}

function mapSettings(
  stamp: Awaited<ReturnType<typeof getStampSettings>>["settings"],
  watermark: WatermarkSettings,
): DocumentProtectionSettings {
  const stampUpdated = stamp.updatedAt ? Date.parse(stamp.updatedAt) : 0
  const watermarkUpdated = watermark.updatedAt ? Date.parse(watermark.updatedAt) : 0
  const latestIsStamp = stampUpdated >= watermarkUpdated
  return {
    enabled: stamp.enabled,
    stampEnabled: stamp.enabled,
    watermarkEnabled: watermark.enabled && watermark.hasLogo,
    hasLogo: watermark.hasLogo,
    logoSource: watermark.logoSource,
    logoDocumentId: watermark.logoDocumentId,
    stampTemplateVersion: stamp.templateVersion,
    watermarkTemplateVersion: watermark.templateVersion,
    updatedAt: latestIsStamp ? stamp.updatedAt : watermark.updatedAt,
    updatedByUserId: latestIsStamp ? stamp.updatedByUserId : watermark.updatedByUserId,
  }
}

export async function getDocumentProtectionSettings(actor: DealActor): Promise<DocumentProtectionView> {
  const [stamp, watermark] = await Promise.all([getStampSettings(actor), getWatermarkSettings(actor)])
  return {
    settings: mapSettings(stamp.settings, watermark.settings),
    canManage: isAdmin(actor),
  }
}

export async function updateDocumentProtectionSettings(actor: DealActor, input: { enabled?: unknown }): Promise<DocumentProtectionView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update document protection.")
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("enabled", "enabled must be true or false.")
  if (typeof input.enabled !== "boolean") invalid("enabled", "enabled must be true or false.")
  const view = await withTransaction(async () => {
    const current = await getWatermarkSettings(actor)
    await updateStampSettings(actor, { enabled: input.enabled })
    if (input.enabled && current.settings.hasLogo) {
      await updateWatermarkSettings(actor, { enabled: true })
    } else {
      await updateWatermarkSettings(actor, { enabled: false })
    }
    return getDocumentProtectionSettings(actor)
  })
  await recordAuditEvent({
    context: actor,
    action: "document_protection.settings_updated",
    resourceType: "document_protection_settings",
    resourceId: actor.workspaceId,
    metadata: {
      enabled: view.settings.enabled,
      watermarkEnabled: view.settings.watermarkEnabled,
      hasLogo: view.settings.hasLogo,
    },
    correlationId: actor.correlationId,
  })
  return view
}

export async function uploadShopLogo(actor: DealActor, input: {
  documentId?: unknown
  filename?: unknown
  mimeType?: unknown
  base64?: unknown
}): Promise<DocumentProtectionView> {
  if (!isAdmin(actor)) denied("Only workspace administrators can update document protection.")
  return withTransaction(async () => {
    const current = await getDocumentProtectionSettings(actor)
    await uploadWatermarkLogo(actor, input)
    if (current.settings.enabled) await updateWatermarkSettings(actor, { enabled: true })
    return getDocumentProtectionSettings(actor)
  })
}

function asStampSkip(preview: StampPreviewResult): DocumentProtectionSkipReason | undefined {
  if (!preview.skipped || !preview.reason) return undefined
  if (preview.reason === "disabled" || preview.reason === "excluded" || preview.reason === "not_pdf") {
    return preview.reason
  }
  return undefined
}

async function findProtectedDerivative(workspaceId: string, originalDocumentId: string, funderId: string): Promise<OutgoingDocument | undefined> {
  const row = await getDatabase().prepare<{
    document_id: string
    original_document_id: string
    output_checksum: string
    byte_length: number | string
    stage: string
  }>(`SELECT document_id, original_document_id, output_checksum, byte_length, stage
      FROM mca_outgoing_derivatives
      WHERE workspace_id = ? AND original_document_id = ? AND funder_id = ?
        AND stage IN ('watermark', 'stamp')
      ORDER BY CASE stage WHEN 'watermark' THEN 2 ELSE 1 END DESC, created_at DESC
      LIMIT 1`).get(workspaceId, originalDocumentId, funderId)
  if (!row || (row.stage !== "watermark" && row.stage !== "stamp")) return undefined
  return {
    documentId: row.document_id,
    originalDocumentId: row.original_document_id,
    checksum: row.output_checksum,
    byteLength: Number(row.byte_length),
    stage: row.stage,
  }
}

export async function previewDocumentProtection(actor: DealActor, input: {
  documentId?: unknown
  funderId?: unknown
}): Promise<DocumentProtectionPreviewResult> {
  const documentId = typeof input.documentId === "string" ? input.documentId.trim() : ""
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!documentId) invalid("documentId", "Choose a document to preview.")
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const record = await getDocument(actor, documentId)
  if (record.category !== "statement") {
    return {
      skipped: true,
      reason: "not_statement",
      originalDocumentId: record.id,
      originalChecksum: record.checksum,
      funderId,
      watermarkApplied: false,
      pages: [],
      replayed: false,
    }
  }
  const stamp = await previewStamp(actor, input)
  const reason = asStampSkip(stamp)
  if (reason) {
    return {
      skipped: true,
      reason,
      originalDocumentId: stamp.originalDocumentId,
      originalChecksum: stamp.originalChecksum,
      funderId: stamp.funderId,
      funderLegalName: stamp.funderLegalName,
      stampText: stamp.stampText ?? (stamp.funderLegalName ? stampTextForFunder(stamp.funderLegalName) : undefined),
      watermarkApplied: false,
      pages: [],
      replayed: false,
    }
  }
  if (!stamp.derivative) {
    throw new AppError(409, "document_protection_preview_failed", "A protected copy could not be prepared.")
  }
  let derivative = stamp.derivative
  try {
    const watermarked = await applyWatermark([stamp.derivative], stamp.funderId)
    derivative = watermarked[0] ?? stamp.derivative
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "watermark_logo_required") throw error
  }
  return {
    skipped: false,
    originalDocumentId: stamp.originalDocumentId,
    originalChecksum: stamp.originalChecksum,
    funderId: stamp.funderId,
    funderLegalName: stamp.funderLegalName,
    stampText: stamp.stampText,
    watermarkApplied: derivative.stage === "watermark",
    derivative,
    pages: stamp.pages,
    replayed: stamp.replayed,
    downloadPath: downloadPathFor(stamp.originalDocumentId, stamp.funderId),
  }
}

export async function getProtectedPreviewFile(actor: DealActor, input: {
  documentId?: unknown
  funderId?: unknown
}): Promise<{ filename: string; bytes: Uint8Array; preview: DocumentProtectionPreviewResult }> {
  const documentId = typeof input.documentId === "string" ? input.documentId.trim() : ""
  const funderId = typeof input.funderId === "string" ? input.funderId.trim() : ""
  if (!documentId) invalid("documentId", "Choose a document to preview.")
  if (!funderId) invalid("funderId", "Choose a destination funder.")
  const record = await getDocument(actor, documentId)
  const funder = await getFunder(actor, funderId)
  if (record.category !== "statement") {
    throw new AppError(409, "document_protection_preview_unavailable", skipMessage("not_statement"))
  }
  const derivative = await findProtectedDerivative(actor.workspaceId, record.id, funder.id)
  if (!derivative) {
    throw new AppError(409, "document_protection_preview_unavailable", "Generate a protected preview before opening the stamped copy.")
  }
  const bytes = await getOutgoingDocumentBytes(derivative)
  const slug = funder.legalName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "funder"
  return {
    filename: `statement-submitted-to-${slug}.pdf`,
    bytes,
    preview: {
      skipped: false,
      originalDocumentId: record.id,
      originalChecksum: record.checksum,
      funderId: funder.id,
      funderLegalName: funder.legalName,
      stampText: stampTextForFunder(funder.legalName),
      watermarkApplied: derivative.stage === "watermark",
      derivative,
      pages: [],
      replayed: true,
      downloadPath: downloadPathFor(record.id, funder.id),
    },
  }
}

export async function requireDocumentProtectionAdmin(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireMembershipAccess(request, ["admin", "super_admin"])
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDocumentProtectionRead(request: Request): Promise<DealActor> {
  const auth = await requireMembershipAccess(request)
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}

export async function requireDocumentProtectionPreview(request: Request): Promise<DealActor> {
  const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
