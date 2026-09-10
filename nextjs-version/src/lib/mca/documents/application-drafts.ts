import "server-only"

import { createHash } from "node:crypto"
import { AppError } from "../errors"
import { newId, nowIso, recordAuditEvent } from "../db"
import { createDeal, getDeal, getDealForDocument, updateDealRecord } from "../deals/service"
import type { DealActor, DealDetail, DealOwnerInput, DealRecord, DealWriteInput } from "../deals/schema"
import type { DocumentProcessingState } from "./contracts"
import { extractApplication } from "./extraction"
import { documentScanner, type ScanResult } from "./scanner"
import { documentStorage } from "./storage"
import { MAX_DOCUMENT_BYTES, storeDocument } from "./service"
import {
  confirmApplicationDraftRecord,
  claimApplicationConfirmation,
  completeApplicationConfirmation,
  failApplicationConfirmation,
  findApplicationDraft,
  findApplicationDraftByKey,
  insertApplicationDraft,
  updateApplicationDraftExtraction,
  updateApplicationDraftScan,
  type ApplicationDraftRecord,
} from "./repository"

export interface ApplicationDraftReview {
  id: string; filename: string; processingState: DocumentProcessingState; extractionVersion: number; fields: DealWriteInput
  approvedFields: DealWriteInput; evidence: Record<string, { confidence: number; page?: number; text?: string; unknown?: boolean }>
  warnings: string[]; lowConfidenceFields: string[]; provider?: string; state: "uploaded" | "review" | "confirmed"; confirmedDealId?: string
}

function view(record: ApplicationDraftRecord): ApplicationDraftReview {
  const evidence = record.evidence as ApplicationDraftReview["evidence"]
  return { id: record.id, filename: record.filename, processingState: record.processingState, extractionVersion: record.extractionVersion,
    fields: record.fields as DealWriteInput, approvedFields: record.approvedFields as DealWriteInput, evidence, warnings: record.warnings,
    lowConfidenceFields: Object.entries(evidence).filter(([, item]) => item.unknown || item.confidence < 0.8).map(([field]) => field),
    provider: record.extractionProvider, state: record.state, confirmedDealId: record.confirmedDealId }
}

function cleanFilename(value: string): string {
  const filename = value.normalize("NFKC").replace(/[\\/\0\r\n]/g, "_").replace(/\s+/g, " ").trim().slice(0, 180)
  if (!filename) throw new AppError(422, "invalid_filename", "Choose a valid filename.")
  return filename
}

function validatePdf(filename: string, mimeType: string, bytes: Uint8Array): string {
  if (mimeType !== "application/pdf") throw new AppError(415, "unsupported_document_type", "Application scans must be PDF files.")
  if (!bytes.byteLength || bytes.byteLength > MAX_DOCUMENT_BYTES) throw new AppError(413, "document_size_invalid", `Documents must be between 1 byte and ${MAX_DOCUMENT_BYTES} bytes.`)
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new AppError(422, "document_content_mismatch", "The file is not a valid PDF upload.")
  return cleanFilename(filename)
}

function scanState(result: ScanResult): DocumentProcessingState {
  return result.status === "clean" ? "clean" : result.status === "infected" ? "quarantined" : result.status === "error" ? "scan_failed" : "pending_scan"
}

function safeOwner(owner: DealOwnerInput): DealOwnerInput {
  const digits = owner.identityLast4?.replace(/\D/g, "")
  return { ...owner, identityLast4: digits?.length === 4 ? digits : undefined }
}
function safeFields(fields: DealWriteInput): DealWriteInput { return { ...fields, ...(fields.owners ? { owners: fields.owners.map(safeOwner) } : {}) } }

export async function getApplicationDraft(actor: DealActor, id: string): Promise<ApplicationDraftRecord> {
  const record = await findApplicationDraft(actor.workspaceId, id)
  if (!record) throw new AppError(404, "application_draft_not_found", "The requested application draft was not found.")
  return record
}

async function scanDraft(actor: DealActor, record: ApplicationDraftRecord, bytes: Uint8Array): Promise<ApplicationDraftRecord> {
  const result = await documentScanner().scan(bytes, record.filename)
  const updated = await updateApplicationDraftScan(actor.workspaceId, record.id, scanState(result), result.provider, result.evidence, nowIso())
  await recordAuditEvent({ context: actor, action: "application_draft.scanned", resourceType: "application_draft", resourceId: record.id, metadata: { state: updated.processingState, provider: result.provider, actualScannerEvidence: result.status === "clean" || result.status === "infected" }, correlationId: actor.correlationId })
  return updated
}

export async function createApplicationDraft(actor: DealActor, input: { idempotencyKey: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<ApplicationDraftReview> {
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key.")
  const filename = validatePdf(input.filename, input.mimeType, input.bytes)
  const checksum = createHash("sha256").update(input.bytes).digest("hex")
  const replay = await findApplicationDraftByKey(actor.workspaceId, input.idempotencyKey)
  if (replay) {
    if (replay.checksum !== checksum) throw new AppError(409, "idempotency_conflict", "That idempotency key was used for another application file.")
    return view(replay)
  }
  const id = newId(), now = nowIso(), storageKey = `${actor.workspaceId}/application-drafts/${id}`
  await documentStorage().putImmutable(storageKey, input.bytes)
  const record = await insertApplicationDraft({ id, workspaceId: actor.workspaceId, idempotencyKey: input.idempotencyKey, filename, mimeType: input.mimeType,
    byteLength: input.bytes.byteLength, checksum, storageKey, processingState: "pending_scan", extractionVersion: 0, fields: {}, evidence: {},
    approvedFields: {}, warnings: [], state: "uploaded", createdBy: actor.userId, createdAt: now, updatedAt: now })
  await recordAuditEvent({ context: actor, action: "application_draft.uploaded", resourceType: "application_draft", resourceId: id, metadata: { byteLength: record.byteLength, checksum }, correlationId: actor.correlationId })
  return view(await scanDraft(actor, record, input.bytes))
}

export async function retryApplicationDraftScan(actor: DealActor, id: string): Promise<ApplicationDraftReview> {
  const record = await getApplicationDraft(actor, id)
  return view(await scanDraft(actor, record, await documentStorage().get(record.storageKey)))
}

export async function extractApplicationDraft(actor: DealActor, id: string, approvedFields: DealWriteInput = {}): Promise<ApplicationDraftReview> {
  const record = await getApplicationDraft(actor, id)
  if (record.processingState !== "clean") throw new AppError(423, "document_not_clean", "The application cannot be extracted until malware scanning succeeds.")
  if (record.state === "confirmed") throw new AppError(409, "application_draft_confirmed", "This application draft is already confirmed.")
  const bytes = await documentStorage().get(record.storageKey)
  const extraction = await extractApplication(actor, { filename: record.filename, mimeType: record.mimeType, bytes, sourceReference: `${record.id}:v${record.extractionVersion + 1}` })
  const approved = safeFields({ ...(record.approvedFields as DealWriteInput), ...approvedFields })
  const fields = safeFields({ ...extraction.fields, ...approved })
  const updated = await updateApplicationDraftExtraction(actor.workspaceId, record.id, { extractionVersion: record.extractionVersion + 1,
    fields: fields as unknown as Record<string, unknown>, evidence: extraction.evidence, approvedFields: approved as unknown as Record<string, unknown>,
    warnings: extraction.warnings, provider: extraction.provider, requestId: extraction.requestId, updatedAt: nowIso() })
  await recordAuditEvent({ context: actor, action: "application_draft.extracted", resourceType: "application_draft", resourceId: record.id, metadata: { extractionVersion: updated.extractionVersion, provider: updated.extractionProvider, warningCount: updated.warnings.length }, correlationId: actor.correlationId })
  return view(updated)
}

function conflicts(current: DealRecord, proposed: DealWriteInput): string[] {
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

export async function previewDraftMerge(actor: DealActor, id: string, targetDealId: string, manualFields: DealWriteInput = {}): Promise<{ conflicts: string[]; targetVersion: number; proposed: DealWriteInput }> {
  const record = await getApplicationDraft(actor, id)
  if (!record.extractionVersion) throw new AppError(422, "extraction_required", "Extract and review the application first.")
  const target = await getDealForDocument(actor, targetDealId)
  const proposed = safeFields({ ...(record.fields as DealWriteInput), ...(record.approvedFields as DealWriteInput), ...manualFields })
  return { conflicts: conflicts(target, proposed), targetVersion: target.version, proposed }
}

export async function confirmApplicationDraft(actor: DealActor, input: { draftId: string; confirmationId: string; mode: "create" | "merge"; targetDealId?: string; expectedVersion?: number; acceptedConflictFields?: string[]; manualFields?: DealWriteInput }): Promise<{ deal: DealDetail; created: boolean; sourceDocumentId: string; extractionVersion: number; replayed: boolean }> {
  if (!input.confirmationId?.trim() || input.confirmationId.length > 160) throw new AppError(422, "confirmation_id_invalid", "Provide an immutable confirmation ID.")
  const record = await getApplicationDraft(actor, input.draftId)
  if (record.processingState !== "clean" || !record.extractionVersion) throw new AppError(422, "extraction_required", "Scan, extract, and review the application before confirmation.")
  const claimedAt = nowIso()
  const attemptToken = newId()
  let claimed
  try {
    claimed = await claimApplicationConfirmation({ id: newId(), workspaceId: actor.workspaceId, sourceType: "draft", sourceId: record.id,
      confirmationId: input.confirmationId, attemptToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), state: "claimed", createdAt: claimedAt, updatedAt: claimedAt })
  } catch {
    throw new AppError(409, "confirmation_conflict", "This draft or confirmation ID is already assigned to another confirmation.")
  }
  if (!claimed.acquired) {
    if (claimed.claim.state === "complete" && claimed.claim.dealId && claimed.claim.sourceDocumentId) {
      return { deal: await getDeal(actor, claimed.claim.dealId), created: false, sourceDocumentId: claimed.claim.sourceDocumentId, extractionVersion: record.extractionVersion, replayed: true }
    }
    throw new AppError(409, "confirmation_in_progress", "This confirmation is already in progress. Retry with the same confirmation ID.")
  }
  const approved = safeFields({ ...(record.approvedFields as DealWriteInput), ...(input.manualFields ?? {}) })
  const proposed = safeFields({ ...(record.fields as DealWriteInput), ...approved, fieldSource: "application_scan" })
  let deal: DealDetail, created: boolean
  try {
  if (input.mode === "create") {
    const result = await createDeal(actor, { ...proposed, idempotencyKey: `application-draft:${input.confirmationId}` })
    deal = result.deal; created = result.created
  } else {
    if (!input.targetDealId || input.expectedVersion === undefined) throw new AppError(422, "merge_target_required", "Choose a target deal and current version.")
    const target = await getDealForDocument(actor, input.targetDealId)
    const unreviewed = conflicts(target, proposed).filter((field) => !(input.acceptedConflictFields ?? []).includes(field))
    if (unreviewed.length) throw new AppError(409, "merge_conflicts_unreviewed", "Review every conflicting field before merging.", { conflicts: unreviewed })
    deal = target.version === input.expectedVersion + 1 && proposedAlreadyApplied(target, proposed)
      ? await getDeal(actor, target.id)
      : await updateDealRecord(actor, target.id, { ...proposed, expectedVersion: input.expectedVersion }); created = false
  }
  const bytes = await documentStorage().get(record.storageKey)
  const sourceDocument = await storeDocument(actor, { dealId: deal.id, idempotencyKey: `application-draft-source:${input.confirmationId}`, filename: record.filename, mimeType: record.mimeType, bytes, category: "application", source: "application_scan", sourceReference: `${record.id}:v${record.extractionVersion}` })
  await confirmApplicationDraftRecord(actor.workspaceId, record.id, { approvedFields: approved as unknown as Record<string, unknown>, confirmationId: input.confirmationId, dealId: deal.id, updatedAt: nowIso() })
  await completeApplicationConfirmation(actor.workspaceId, claimed.claim.id, attemptToken, deal.id, sourceDocument.id, nowIso())
  await recordAuditEvent({ context: actor, action: input.mode === "create" ? "application_draft.deal_created" : "application_draft.deal_merged", resourceType: "deal", resourceId: deal.id, metadata: { draftId: record.id, extractionVersion: record.extractionVersion, sourceDocumentId: sourceDocument.id }, correlationId: actor.correlationId })
  return { deal, created, sourceDocumentId: sourceDocument.id, extractionVersion: record.extractionVersion, replayed: false }
  } catch (error) {
    await failApplicationConfirmation(actor.workspaceId, claimed.claim.id, attemptToken, error instanceof Error ? error.message : "confirmation_failed", nowIso())
    throw error
  }
}
