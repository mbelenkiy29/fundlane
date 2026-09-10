import "server-only"

import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import { createDeal, getDeal, getDealForDocument, updateDealRecord } from "../deals/service"
import type { DealActor, DealDetail, DealOwnerInput, DealRecord, DealWriteInput } from "../deals/schema"
import { extractApplication } from "./extraction"
import { getDocument, getDocumentContent, storeDocument } from "./service"
import {
  claimApplicationConfirmation,
  completeApplicationConfirmation,
  failApplicationConfirmation,
  findExtraction,
  insertExtraction,
  latestExtraction,
  updateExtractionApproval,
  type ExtractionRecord,
} from "./repository"

export interface ApplicationScanReview {
  id: string
  documentId: string
  documentVersion: number
  extractionVersion: number
  fields: DealWriteInput
  evidence: Record<string, { confidence: number; page?: number; text?: string; unknown?: boolean }>
  approvedFields: DealWriteInput
  warnings: string[]
  lowConfidenceFields: string[]
  provider: string
  state: "review" | "confirmed"
  confirmedDealId?: string
}

function asReview(record: ExtractionRecord): ApplicationScanReview {
  const evidence = record.evidence as ApplicationScanReview["evidence"]
  return {
    id: record.id, documentId: record.documentId, documentVersion: record.documentVersion, extractionVersion: record.extractionVersion,
    fields: record.fields as DealWriteInput, evidence, approvedFields: record.approvedFields as DealWriteInput,
    warnings: record.warnings, lowConfidenceFields: Object.entries(evidence).filter(([, item]) => item.unknown || item.confidence < 0.8).map(([field]) => field),
    provider: record.provider, state: record.state, confirmedDealId: record.confirmedDealId,
  }
}

function safeOwner(owner: DealOwnerInput): DealOwnerInput {
  const identityLast4 = owner.identityLast4?.replace(/\D/g, "")
  return { ...owner, identityLast4: identityLast4?.length === 4 ? identityLast4 : undefined }
}

function safeFields(fields: DealWriteInput): DealWriteInput {
  return { ...fields, ...(fields.owners ? { owners: fields.owners.map(safeOwner) } : {}) }
}

export async function scanApplicationDocument(actor: DealActor, documentId: string): Promise<ApplicationScanReview> {
  const { document, bytes } = await getDocumentContent(actor, documentId)
  if (document.category !== "application") throw new AppError(422, "document_category_invalid", "Choose a document categorized as an application.")
  const prior = await latestExtraction(actor.workspaceId, document.id)
  const extraction = await extractApplication(actor, { filename: document.originalFilename, mimeType: document.mimeType, bytes, sourceReference: `${document.id}:v${document.version}` })
  const approvedFields = (prior?.approvedFields ?? {}) as DealWriteInput
  const fields = safeFields({ ...extraction.fields, ...approvedFields })
  const now = nowIso()
  const record = await insertExtraction({
    id: newId(), workspaceId: actor.workspaceId, documentId: document.id, documentVersion: document.version,
    extractionVersion: (prior?.extractionVersion ?? 0) + 1, fields: fields as unknown as Record<string, unknown>, evidence: extraction.evidence,
    approvedFields: approvedFields as unknown as Record<string, unknown>, warnings: extraction.warnings, provider: extraction.provider, providerRequestId: extraction.requestId,
    state: "review", createdBy: actor.userId, createdAt: now, updatedAt: now,
  })
  await recordAuditEvent({ context: actor, action: "application.extracted", resourceType: "document", resourceId: document.id, metadata: { extractionId: record.id, extractionVersion: record.extractionVersion, provider: record.provider, warningCount: record.warnings.length }, correlationId: actor.correlationId })
  return asReview(record)
}

export async function saveApplicationReview(actor: DealActor, extractionId: string, approvedFields: DealWriteInput): Promise<ApplicationScanReview> {
  const record = await findExtraction(actor.workspaceId, extractionId)
  if (!record) throw new AppError(404, "extraction_not_found", "The requested extraction was not found.")
  await getDocument(actor, record.documentId)
  if (record.state === "confirmed") throw new AppError(409, "extraction_confirmed", "This extraction is already confirmed.")
  const approved = safeFields({ ...(record.approvedFields as DealWriteInput), ...approvedFields })
  const updated = await updateExtractionApproval(actor.workspaceId, record.id, approved as unknown as Record<string, unknown>, "review", nowIso())
  await recordAuditEvent({ context: actor, action: "application.review_saved", resourceType: "document", resourceId: record.documentId, metadata: { extractionId: record.id, fields: Object.keys(approvedFields) }, correlationId: actor.correlationId })
  return asReview({ ...updated, fields: { ...updated.fields, ...approved } })
}

function changedConflicts(current: DealRecord, proposed: DealWriteInput): string[] {
  const keys = ["legalName", "dbaName", "ein", "entityType", "address", "contactName", "contactEmail", "contactPhone", "startDate", "industry", "naicsCode", "monthlyRevenue", "ficoScore", "fundingPurpose", "requestedAmount", "owners"] as const
  return keys.filter((key) => proposed[key] !== undefined && current[key] !== undefined && JSON.stringify(proposed[key]) !== JSON.stringify(current[key]))
}

function proposedAlreadyApplied(current: DealRecord, proposed: DealWriteInput): boolean {
  return Object.entries(proposed).every(([key, value]) => {
    if (value === undefined || key === "fieldSource") return true
    const currentValue = current[key as keyof DealRecord]
    if (key !== "owners") return JSON.stringify(currentValue) === JSON.stringify(value)
    const withoutIds = (owners: unknown) => Array.isArray(owners) ? owners.map((owner) => { const copy = { ...(owner as Record<string, unknown>) }; delete copy.id; return copy }) : owners
    return JSON.stringify(withoutIds(currentValue)) === JSON.stringify(withoutIds(value))
  })
}

export async function reviewApplicationMerge(actor: DealActor, extractionId: string, targetDealId: string, manualFields: DealWriteInput = {}): Promise<{ proposed: DealWriteInput; conflicts: string[]; targetVersion: number }> {
  const record = await findExtraction(actor.workspaceId, extractionId)
  if (!record) throw new AppError(404, "extraction_not_found", "The requested extraction was not found.")
  await getDocument(actor, record.documentId)
  const target = await getDealForDocument(actor, targetDealId)
  const proposed = safeFields({ ...(record.fields as DealWriteInput), ...(record.approvedFields as DealWriteInput), ...manualFields })
  return { proposed, conflicts: changedConflicts(target, proposed), targetVersion: target.version }
}

export async function confirmApplicationScan(actor: DealActor, input: {
  extractionId: string
  confirmationId: string
  mode: "create" | "merge"
  targetDealId?: string
  expectedVersion?: number
  acceptedConflictFields?: string[]
  manualFields?: DealWriteInput
}): Promise<{ deal: DealDetail; created: boolean; sourceDocumentId: string; extractionVersion: number; replayed: boolean }> {
  if (!input.confirmationId?.trim() || input.confirmationId.length > 160) throw new AppError(422, "confirmation_id_invalid", "Provide an immutable confirmation ID.")
  const record = await findExtraction(actor.workspaceId, input.extractionId)
  if (!record) throw new AppError(404, "extraction_not_found", "The requested extraction was not found.")
  const claimedAt = nowIso()
  const attemptToken = newId()
  let claimed
  try {
    claimed = await claimApplicationConfirmation({ id: newId(), workspaceId: actor.workspaceId, sourceType: "document", sourceId: record.id,
      confirmationId: input.confirmationId, attemptToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), state: "claimed", createdAt: claimedAt, updatedAt: claimedAt })
  } catch {
    throw new AppError(409, "confirmation_conflict", "This extraction or confirmation ID is already assigned to another confirmation.")
  }
  if (!claimed.acquired) {
    if (claimed.claim.state === "complete" && claimed.claim.dealId && claimed.claim.sourceDocumentId) {
      return { deal: await getDeal(actor, claimed.claim.dealId), created: false, sourceDocumentId: claimed.claim.sourceDocumentId, extractionVersion: record.extractionVersion, replayed: true }
    }
    throw new AppError(409, "confirmation_in_progress", "This confirmation is already in progress. Retry with the same confirmation ID.")
  }
  const manual = safeFields(input.manualFields ?? {})
  const approved = safeFields({ ...(record.approvedFields as DealWriteInput), ...manual })
  const proposed = safeFields({ ...(record.fields as DealWriteInput), ...approved, fieldSource: "application_scan" })
  let deal: DealDetail
  let created: boolean
  try {
  const { document: sourceDocument, bytes: sourceBytes } = await getDocumentContent(actor, record.documentId)
  if (sourceDocument.category !== "application" || sourceDocument.version !== record.documentVersion) {
    throw new AppError(409, "extraction_source_changed", "The source application changed after extraction. Extract the current clean application again.")
  }
  let preservedDocumentId = sourceDocument.id
  if (input.mode === "create") {
    const result = await createDeal(actor, { ...proposed, idempotencyKey: `application-scan:${input.confirmationId}` })
    deal = result.deal
    created = result.created
    if (sourceDocument.dealId !== deal.id) {
      const copied = await storeDocument(actor, { dealId: deal.id, idempotencyKey: `application-source:${input.confirmationId}`, filename: sourceDocument.originalFilename, mimeType: sourceDocument.mimeType, bytes: sourceBytes, category: "application", source: "application_scan", sourceReference: `${sourceDocument.id}:v${sourceDocument.version}` })
      preservedDocumentId = copied.id
    }
  } else {
    if (!input.targetDealId || input.expectedVersion === undefined) throw new AppError(422, "merge_target_required", "Choose a target deal and its current version.")
    const target = await getDealForDocument(actor, input.targetDealId)
    const conflicts = changedConflicts(target, proposed)
    const accepted = new Set(input.acceptedConflictFields ?? [])
    const unreviewed = conflicts.filter((field) => !accepted.has(field))
    if (unreviewed.length) throw new AppError(409, "merge_conflicts_unreviewed", "Review every conflicting field before merging.", { conflicts: unreviewed })
    deal = target.version === input.expectedVersion + 1 && proposedAlreadyApplied(target, proposed)
      ? await getDeal(actor, target.id)
      : await updateDealRecord(actor, target.id, { ...proposed, expectedVersion: input.expectedVersion })
    created = false
    if (sourceDocument.dealId !== deal.id) {
      const copied = await storeDocument(actor, { dealId: deal.id, idempotencyKey: `application-source:${input.confirmationId}`, filename: sourceDocument.originalFilename, mimeType: sourceDocument.mimeType, bytes: sourceBytes, category: "application", source: "application_scan_merge", sourceReference: `${sourceDocument.id}:v${sourceDocument.version}` })
      preservedDocumentId = copied.id
    }
  }
  await updateExtractionApproval(actor.workspaceId, record.id, approved as unknown as Record<string, unknown>, "confirmed", nowIso(), { id: input.confirmationId, dealId: deal.id })
  await completeApplicationConfirmation(actor.workspaceId, claimed.claim.id, attemptToken, deal.id, preservedDocumentId, nowIso())
  await recordAuditEvent({ context: actor, action: input.mode === "create" ? "application.deal_created" : "application.deal_merged", resourceType: "deal", resourceId: deal.id, metadata: { extractionId: record.id, extractionVersion: record.extractionVersion, sourceDocumentId: preservedDocumentId }, correlationId: actor.correlationId })
  return { deal, created, sourceDocumentId: preservedDocumentId, extractionVersion: record.extractionVersion, replayed: false }
  } catch (error) {
    await failApplicationConfirmation(actor.workspaceId, claimed.claim.id, attemptToken, error instanceof Error ? error.message : "confirmation_failed", nowIso())
    throw error
  }
}
