import "server-only"

import { getDatabase, parseJson, withImmediateTransaction, type DbExecutor } from "../db"
import type { DocumentCategory, DocumentProcessingState, DocumentSummary } from "./contracts"

export interface DocumentRecord extends DocumentSummary {
  idempotencyKey: string
  lineageId: string
  previousDocumentId?: string
  storageKey: string
  source: string
  sourceReference?: string
  scanProvider?: string
  scanEvidence?: Record<string, unknown>
  scanAttemptedAt?: string
  createdBy: string | null
  updatedAt: string
}

type DocumentRow = {
  id: string; workspace_id: string; deal_id: string; idempotency_key: string
  original_filename: string; display_filename: string; mime_type: string; byte_length: number
  checksum: string; category: string; lineage_id: string | null; version: number; previous_document_id: string | null
  storage_key: string; source: string; source_reference: string | null; processing_state: string
  scan_provider: string | null; scan_evidence: string | null; scan_attempted_at: string | null
  created_by: string | null; created_at: string; updated_at: string
}

function db(): DbExecutor { return getDatabase() }

function fromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    idempotencyKey: row.idempotency_key,
    originalFilename: row.original_filename,
    displayFilename: row.display_filename,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    checksum: row.checksum,
    category: row.category as DocumentCategory,
    lineageId: row.lineage_id ?? row.id,
    version: row.version,
    previousDocumentId: row.previous_document_id ?? undefined,
    storageKey: row.storage_key,
    source: row.source,
    sourceReference: row.source_reference ?? undefined,
    processingState: row.processing_state as DocumentProcessingState,
    scanProvider: row.scan_provider ?? undefined,
    scanEvidence: parseJson(row.scan_evidence, undefined),
    scanAttemptedAt: row.scan_attempted_at ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function findDocumentById(workspaceId: string, id: string): Promise<DocumentRecord | undefined> {
  const row = await db().prepare<DocumentRow>("SELECT * FROM mca_documents WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? fromRow(row) : undefined
}

export async function findDocumentByIdempotencyKey(workspaceId: string, key: string): Promise<DocumentRecord | undefined> {
  const row = await db().prepare<DocumentRow>("SELECT * FROM mca_documents WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, key)
  return row ? fromRow(row) : undefined
}

export async function listDocumentRecords(workspaceId: string, dealId: string, forSubmission = false): Promise<DocumentRecord[]> {
  const filter = forSubmission ? `AND d.source <> 'funder_criteria_scan'
    AND NOT EXISTS (SELECT 1 FROM mca_funder_criteria_scans AS scan WHERE scan.workspace_id = d.workspace_id AND scan.document_id = d.id)` : ""
  const rows = await db().prepare<DocumentRow>(`SELECT d.* FROM mca_documents AS d WHERE d.workspace_id = ? AND d.deal_id = ? ${filter} ORDER BY d.created_at DESC`).all(workspaceId, dealId)
  return rows.map(fromRow)
}

export async function insertDocument(record: DocumentRecord): Promise<DocumentRecord> {
  await db().prepare(`INSERT INTO mca_documents
    (id, workspace_id, deal_id, idempotency_key, original_filename, display_filename, mime_type, byte_length, checksum, category, lineage_id, version,
     previous_document_id, storage_key, source, source_reference, processing_state, scan_provider, scan_evidence, scan_attempted_at,
     created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.workspaceId, record.dealId, record.idempotencyKey, record.originalFilename, record.displayFilename,
      record.mimeType, record.byteLength, record.checksum, record.category, record.lineageId, record.version, record.previousDocumentId ?? null,
      record.storageKey, record.source, record.sourceReference ?? null, record.processingState, record.scanProvider ?? null,
      record.scanEvidence ? JSON.stringify(record.scanEvidence) : null, record.scanAttemptedAt ?? null, record.createdBy,
      record.createdAt, record.updatedAt,
    )
  return record
}

export async function reserveDocument(
  base: Omit<DocumentRecord, "lineageId" | "version" | "previousDocumentId">,
  previousDocumentId?: string,
): Promise<{ record: DocumentRecord; inserted: boolean }> {
  return withImmediateTransaction(async (database) => {
    const replay = await database.prepare<DocumentRow>("SELECT * FROM mca_documents WHERE workspace_id = ? AND idempotency_key = ?")
      .get(base.workspaceId, base.idempotencyKey)
    if (replay) return { record: fromRow(replay), inserted: false }
    let lineageId = base.id
    let version = 1
    if (previousDocumentId) {
      const previous = await database.prepare<DocumentRow>("SELECT * FROM mca_documents WHERE workspace_id = ? AND deal_id = ? AND id = ? FOR UPDATE")
        .get(base.workspaceId, base.dealId, previousDocumentId)
      if (!previous) throw new Error("version_source_not_found")
      lineageId = previous.lineage_id ?? previous.id
      const latest = await database.prepare<{ id: string; version: number }>("SELECT id, version FROM mca_documents WHERE workspace_id = ? AND lineage_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE")
        .get(base.workspaceId, lineageId)
      if (!latest) throw new Error("version_source_not_found")
      if (latest.id !== previous.id) throw new Error("version_source_stale")
      version = latest.version + 1
    }
    const record: DocumentRecord = { ...base, lineageId, version, previousDocumentId }
    const inserted = await database.prepare<{ id: string }>(`INSERT INTO mca_documents
      (id, workspace_id, deal_id, idempotency_key, original_filename, display_filename, mime_type, byte_length, checksum, category, lineage_id, version,
       previous_document_id, storage_key, source, source_reference, processing_state, scan_provider, scan_evidence, scan_attempted_at,
       created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING id`).get(
      record.id, record.workspaceId, record.dealId, record.idempotencyKey, record.originalFilename, record.displayFilename,
      record.mimeType, record.byteLength, record.checksum, record.category, record.lineageId, record.version, record.previousDocumentId ?? null,
      record.storageKey, record.source, record.sourceReference ?? null, record.processingState, record.scanProvider ?? null,
      record.scanEvidence ? JSON.stringify(record.scanEvidence) : null, record.scanAttemptedAt ?? null, record.createdBy, record.createdAt, record.updatedAt,
    )
    if (inserted) return { record, inserted: true }
    const concurrentReplay = await database.prepare<DocumentRow>("SELECT * FROM mca_documents WHERE workspace_id = ? AND idempotency_key = ?")
      .get(base.workspaceId, base.idempotencyKey)
    if (!concurrentReplay) throw new Error("document_idempotency_conflict")
    return { record: fromRow(concurrentReplay), inserted: false }
  })
}

export async function updateDocumentScan(
  workspaceId: string,
  id: string,
  state: DocumentProcessingState,
  provider: string,
  evidence: Record<string, unknown>,
  attemptedAt: string,
): Promise<DocumentRecord> {
  await db().prepare(`UPDATE mca_documents SET processing_state = ?, scan_provider = ?, scan_evidence = ?, scan_attempted_at = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(state, provider, JSON.stringify(evidence), attemptedAt, attemptedAt, workspaceId, id)
  return (await findDocumentById(workspaceId, id))!
}

export async function updateDocumentDisplayFilename(workspaceId: string, id: string, displayFilename: string, updatedAt: string): Promise<DocumentRecord> {
  await db().prepare("UPDATE mca_documents SET display_filename = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(displayFilename, updatedAt, workspaceId, id)
  return (await findDocumentById(workspaceId, id))!
}

export async function updateDocumentCategory(workspaceId: string, id: string, dealId: string, category: DocumentCategory, updatedAt: string): Promise<DocumentRecord> {
  await db().prepare("UPDATE mca_documents SET category = ?, updated_at = ? WHERE workspace_id = ? AND deal_id = ? AND id = ?")
    .run(category, updatedAt, workspaceId, dealId, id)
  return (await findDocumentById(workspaceId, id))!
}

export interface ExtractionRecord {
  id: string
  workspaceId: string
  documentId: string
  documentVersion: number
  extractionVersion: number
  fields: Record<string, unknown>
  evidence: Record<string, unknown>
  approvedFields: Record<string, unknown>
  warnings: string[]
  provider: string
  providerRequestId?: string
  state: "review" | "confirmed"
  confirmedDealId?: string
  confirmationId?: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

type ExtractionRow = {
  id: string; workspace_id: string; document_id: string; document_version: number; extraction_version: number
  fields: string; evidence: string; approved_fields: string; warnings: string; provider: string; provider_request_id: string | null
  state: "review" | "confirmed"; confirmed_deal_id: string | null; confirmation_id: string | null
  created_by: string | null; created_at: string; updated_at: string
}

function extractionFromRow(row: ExtractionRow): ExtractionRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, documentVersion: row.document_version,
    extractionVersion: row.extraction_version, fields: parseJson(row.fields, {}), evidence: parseJson(row.evidence, {}),
    approvedFields: parseJson(row.approved_fields, {}), warnings: parseJson(row.warnings, []), provider: row.provider,
    providerRequestId: row.provider_request_id ?? undefined, state: row.state, confirmedDealId: row.confirmed_deal_id ?? undefined,
    confirmationId: row.confirmation_id ?? undefined, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export async function latestExtraction(workspaceId: string, documentId: string): Promise<ExtractionRecord | undefined> {
  const row = await db().prepare<ExtractionRow>(`SELECT * FROM mca_application_extractions WHERE workspace_id = ? AND document_id = ?
    ORDER BY extraction_version DESC LIMIT 1`).get(workspaceId, documentId)
  return row ? extractionFromRow(row) : undefined
}

export async function findExtraction(workspaceId: string, id: string): Promise<ExtractionRecord | undefined> {
  const row = await db().prepare<ExtractionRow>("SELECT * FROM mca_application_extractions WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? extractionFromRow(row) : undefined
}

export async function findExtractionByConfirmation(workspaceId: string, confirmationId: string): Promise<ExtractionRecord | undefined> {
  const row = await db().prepare<ExtractionRow>("SELECT * FROM mca_application_extractions WHERE workspace_id = ? AND confirmation_id = ?").get(workspaceId, confirmationId)
  return row ? extractionFromRow(row) : undefined
}

export async function insertExtraction(record: ExtractionRecord): Promise<ExtractionRecord> {
  await db().prepare(`INSERT INTO mca_application_extractions
    (id, workspace_id, document_id, document_version, extraction_version, fields, evidence, approved_fields, warnings, provider,
     provider_request_id, state, confirmed_deal_id, confirmation_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.workspaceId, record.documentId, record.documentVersion, record.extractionVersion,
      JSON.stringify(record.fields), JSON.stringify(record.evidence), JSON.stringify(record.approvedFields), JSON.stringify(record.warnings),
      record.provider, record.providerRequestId ?? null, record.state, record.confirmedDealId ?? null, record.confirmationId ?? null,
      record.createdBy, record.createdAt, record.updatedAt,
    )
  return record
}

export async function updateExtractionApproval(
  workspaceId: string,
  id: string,
  approvedFields: Record<string, unknown>,
  state: "review" | "confirmed",
  updatedAt: string,
  confirmation?: { id: string; dealId: string },
): Promise<ExtractionRecord> {
  await db().prepare(`UPDATE mca_application_extractions SET approved_fields = ?, state = ?, confirmation_id = ?, confirmed_deal_id = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
      JSON.stringify(approvedFields), state, confirmation?.id ?? null, confirmation?.dealId ?? null, updatedAt, workspaceId, id,
    )
  return (await findExtraction(workspaceId, id))!
}

export interface ApplicationConfirmationClaim {
  id: string
  workspaceId: string
  sourceType: "document" | "draft"
  sourceId: string
  confirmationId: string
  attemptToken: string
  leaseExpiresAt: string
  state: "claimed" | "complete" | "failed"
  dealId?: string
  sourceDocumentId?: string
  error?: string
  createdAt: string
  updatedAt: string
}

type ConfirmationClaimRow = {
  id: string; workspace_id: string; source_type: "document" | "draft"; source_id: string; confirmation_id: string; attempt_token: string | null; lease_expires_at: string | null
  state: "claimed" | "complete" | "failed"; deal_id: string | null; source_document_id: string | null; error: string | null
  created_at: string; updated_at: string
}

function confirmationClaimFromRow(row: ConfirmationClaimRow): ApplicationConfirmationClaim {
  return { id: row.id, workspaceId: row.workspace_id, sourceType: row.source_type, sourceId: row.source_id,
    confirmationId: row.confirmation_id, attemptToken: row.attempt_token ?? "legacy", leaseExpiresAt: row.lease_expires_at ?? row.updated_at,
    state: row.state, dealId: row.deal_id ?? undefined,
    sourceDocumentId: row.source_document_id ?? undefined, error: row.error ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at }
}

export async function claimApplicationConfirmation(input: ApplicationConfirmationClaim): Promise<{ claim: ApplicationConfirmationClaim; acquired: boolean }> {
  return withImmediateTransaction(async (database) => {
    const bySource = await database.prepare<ConfirmationClaimRow>("SELECT * FROM mca_application_confirmation_claims WHERE workspace_id = ? AND source_type = ? AND source_id = ? FOR UPDATE")
      .get(input.workspaceId, input.sourceType, input.sourceId)
    if (bySource) {
      const claim = confirmationClaimFromRow(bySource)
      if (claim.confirmationId !== input.confirmationId) throw new Error("confirmation_source_conflict")
      if (claim.state === "failed" || (claim.state === "claimed" && claim.leaseExpiresAt <= input.updatedAt)) {
        const updated = await database.prepare("UPDATE mca_application_confirmation_claims SET state = 'claimed', attempt_token = ?, lease_expires_at = ?, error = NULL, updated_at = ? WHERE id = ? AND attempt_token IS NOT DISTINCT FROM ?")
          .run(input.attemptToken, input.leaseExpiresAt, input.updatedAt, claim.id, rowAttemptToken(bySource))
        if (Number(updated.changes) === 1) return { claim: { ...claim, state: "claimed", attemptToken: input.attemptToken, leaseExpiresAt: input.leaseExpiresAt, error: undefined, updatedAt: input.updatedAt }, acquired: true }
      }
      return { claim, acquired: false }
    }
    const byConfirmation = await database.prepare<{ id: string }>("SELECT id FROM mca_application_confirmation_claims WHERE workspace_id = ? AND confirmation_id = ? FOR UPDATE")
      .get(input.workspaceId, input.confirmationId)
    if (byConfirmation) throw new Error("confirmation_id_conflict")
    const inserted = await database.prepare<{ id: string }>(`INSERT INTO mca_application_confirmation_claims
      (id,workspace_id,source_type,source_id,confirmation_id,attempt_token,lease_expires_at,state,deal_id,source_document_id,error,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`).get(input.id, input.workspaceId, input.sourceType, input.sourceId,
      input.confirmationId, input.attemptToken, input.leaseExpiresAt, input.state, input.dealId ?? null, input.sourceDocumentId ?? null, input.error ?? null,
      input.createdAt, input.updatedAt)
    if (!inserted) {
      const conflict = await database.prepare<ConfirmationClaimRow>("SELECT * FROM mca_application_confirmation_claims WHERE workspace_id=? AND source_type=? AND source_id=?").get(input.workspaceId, input.sourceType, input.sourceId)
      if (conflict) {
        const claim = confirmationClaimFromRow(conflict)
        if (claim.confirmationId !== input.confirmationId) throw new Error("confirmation_source_conflict")
        return { claim, acquired: false }
      }
      throw new Error("confirmation_id_conflict")
    }
    return { claim: input, acquired: true }
  })
}

function rowAttemptToken(row: ConfirmationClaimRow): string | null { return row.attempt_token }

export async function completeApplicationConfirmation(workspaceId: string, claimId: string, attemptToken: string, dealId: string, sourceDocumentId: string, updatedAt: string): Promise<ApplicationConfirmationClaim> {
  const row = await db().prepare<ConfirmationClaimRow>("UPDATE mca_application_confirmation_claims SET state = 'complete', deal_id = ?, source_document_id = ?, error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND state = 'claimed' AND attempt_token = ? RETURNING *")
    .get(dealId, sourceDocumentId, updatedAt, workspaceId, claimId, attemptToken)
  if (!row) throw new Error("confirmation_claim_lost")
  return confirmationClaimFromRow(row)
}

export async function failApplicationConfirmation(workspaceId: string, claimId: string, attemptToken: string, error: string, updatedAt: string): Promise<void> {
  await db().prepare("UPDATE mca_application_confirmation_claims SET state = 'failed', error = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND state = 'claimed' AND attempt_token = ?")
    .run(error.slice(0, 200), updatedAt, workspaceId, claimId, attemptToken)
}

export interface PdfAuthorizationRecord {
  id: string; workspaceId: string; dealId: string; authorizedBy: string | null; merchantName: string
  authorizationReference: string; recordedAt: string; revokedAt?: string
}

export async function insertPdfAuthorization(record: PdfAuthorizationRecord): Promise<void> {
  await db().prepare(`INSERT INTO mca_pdf_authorizations
    (id, workspace_id, deal_id, authorized_by, merchant_name, authorization_reference, recorded_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.workspaceId, record.dealId, record.authorizedBy, record.merchantName, record.authorizationReference, record.recordedAt, record.revokedAt ?? null)
}

export async function latestPdfAuthorization(workspaceId: string, dealId: string): Promise<PdfAuthorizationRecord | undefined> {
  return db().prepare<PdfAuthorizationRecord>(`SELECT id, workspace_id AS "workspaceId", deal_id AS "dealId", authorized_by AS "authorizedBy",
    merchant_name AS "merchantName", authorization_reference AS "authorizationReference", recorded_at AS "recordedAt",
    revoked_at AS "revokedAt" FROM mca_pdf_authorizations WHERE workspace_id = ? AND deal_id = ? AND revoked_at IS NULL
    ORDER BY recorded_at DESC LIMIT 1`).get(workspaceId, dealId)
}

export interface PdfGenerationRecord {
  id: string; workspaceId: string; dealId: string; idempotencyKey: string; documentId: string; dealVersion: number
  contactMode: "real" | "omitted" | "redacted"; signedOnBehalf: boolean; authorizationId?: string
  generatedBy: string | null; correlationId: string; createdAt: string
}

export async function findPdfGenerationByKey(workspaceId: string, idempotencyKey: string): Promise<PdfGenerationRecord | undefined> {
  const row = await db().prepare<(Omit<PdfGenerationRecord, "signedOnBehalf"> & { signedOnBehalf: number })>(`SELECT id, workspace_id AS "workspaceId", deal_id AS "dealId", idempotency_key AS "idempotencyKey",
    document_id AS "documentId", deal_version AS "dealVersion", contact_mode AS "contactMode", signed_on_behalf AS "signedOnBehalf",
    authorization_id AS "authorizationId", generated_by AS "generatedBy", correlation_id AS "correlationId", created_at AS "createdAt"
    FROM mca_pdf_generations WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, idempotencyKey)
  return row ? { ...row, signedOnBehalf: Boolean(row.signedOnBehalf) } : undefined
}

export async function insertPdfGeneration(record: PdfGenerationRecord): Promise<void> {
  await db().prepare(`INSERT INTO mca_pdf_generations
    (id, workspace_id, deal_id, idempotency_key, document_id, deal_version, contact_mode, signed_on_behalf,
     authorization_id, generated_by, correlation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.workspaceId, record.dealId, record.idempotencyKey, record.documentId, record.dealVersion, record.contactMode,
      record.signedOnBehalf ? 1 : 0, record.authorizationId ?? null, record.generatedBy, record.correlationId, record.createdAt,
    )
}

export interface ApplicationDraftRecord {
  id: string; workspaceId: string; idempotencyKey: string; filename: string; mimeType: string; byteLength: number; checksum: string
  storageKey: string; processingState: DocumentProcessingState; scanProvider?: string; scanEvidence?: Record<string, unknown>
  extractionVersion: number; fields: Record<string, unknown>; evidence: Record<string, unknown>; approvedFields: Record<string, unknown>
  warnings: string[]; extractionProvider?: string; providerRequestId?: string; state: "uploaded" | "review" | "confirmed"
  confirmedDealId?: string; confirmationId?: string; createdBy: string | null; createdAt: string; updatedAt: string
}

type ApplicationDraftRow = {
  id: string; workspace_id: string; idempotency_key: string; filename: string; mime_type: string; byte_length: number; checksum: string
  storage_key: string; processing_state: DocumentProcessingState; scan_provider: string | null; scan_evidence: string | null
  extraction_version: number; fields: string; evidence: string; approved_fields: string; warnings: string
  extraction_provider: string | null; provider_request_id: string | null; state: "uploaded" | "review" | "confirmed"
  confirmed_deal_id: string | null; confirmation_id: string | null; created_by: string | null; created_at: string; updated_at: string
}

function draftFromRow(row: ApplicationDraftRow): ApplicationDraftRecord {
  return {
    id: row.id, workspaceId: row.workspace_id, idempotencyKey: row.idempotency_key, filename: row.filename, mimeType: row.mime_type,
    byteLength: row.byte_length, checksum: row.checksum, storageKey: row.storage_key, processingState: row.processing_state,
    scanProvider: row.scan_provider ?? undefined, scanEvidence: parseJson(row.scan_evidence, undefined), extractionVersion: row.extraction_version,
    fields: parseJson(row.fields, {}), evidence: parseJson(row.evidence, {}), approvedFields: parseJson(row.approved_fields, {}), warnings: parseJson(row.warnings, []),
    extractionProvider: row.extraction_provider ?? undefined, providerRequestId: row.provider_request_id ?? undefined, state: row.state,
    confirmedDealId: row.confirmed_deal_id ?? undefined, confirmationId: row.confirmation_id ?? undefined,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export async function findApplicationDraft(workspaceId: string, id: string): Promise<ApplicationDraftRecord | undefined> {
  const row = await db().prepare<ApplicationDraftRow>("SELECT * FROM mca_application_scan_drafts WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? draftFromRow(row) : undefined
}

export async function findApplicationDraftByKey(workspaceId: string, key: string): Promise<ApplicationDraftRecord | undefined> {
  const row = await db().prepare<ApplicationDraftRow>("SELECT * FROM mca_application_scan_drafts WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, key)
  return row ? draftFromRow(row) : undefined
}

export async function findApplicationDraftByConfirmation(workspaceId: string, confirmationId: string): Promise<ApplicationDraftRecord | undefined> {
  const row = await db().prepare<ApplicationDraftRow>("SELECT * FROM mca_application_scan_drafts WHERE workspace_id = ? AND confirmation_id = ?").get(workspaceId, confirmationId)
  return row ? draftFromRow(row) : undefined
}

export async function insertApplicationDraft(record: ApplicationDraftRecord): Promise<ApplicationDraftRecord> {
  await db().prepare(`INSERT INTO mca_application_scan_drafts
    (id,workspace_id,idempotency_key,filename,mime_type,byte_length,checksum,storage_key,processing_state,scan_provider,scan_evidence,
     extraction_version,fields,evidence,approved_fields,warnings,extraction_provider,provider_request_id,state,confirmed_deal_id,confirmation_id,
     created_by,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.workspaceId, record.idempotencyKey, record.filename, record.mimeType, record.byteLength, record.checksum, record.storageKey,
      record.processingState, record.scanProvider ?? null, record.scanEvidence ? JSON.stringify(record.scanEvidence) : null, record.extractionVersion,
      JSON.stringify(record.fields), JSON.stringify(record.evidence), JSON.stringify(record.approvedFields), JSON.stringify(record.warnings),
      record.extractionProvider ?? null, record.providerRequestId ?? null, record.state, record.confirmedDealId ?? null,
      record.confirmationId ?? null, record.createdBy, record.createdAt, record.updatedAt,
    )
  return record
}

export async function updateApplicationDraftScan(workspaceId: string, id: string, processingState: DocumentProcessingState, provider: string, evidence: Record<string, unknown>, updatedAt: string): Promise<ApplicationDraftRecord> {
  await db().prepare("UPDATE mca_application_scan_drafts SET processing_state = ?, scan_provider = ?, scan_evidence = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(processingState, provider, JSON.stringify(evidence), updatedAt, workspaceId, id)
  return (await findApplicationDraft(workspaceId, id))!
}

export async function updateApplicationDraftExtraction(workspaceId: string, id: string, input: { extractionVersion: number; fields: Record<string, unknown>; evidence: Record<string, unknown>; approvedFields: Record<string, unknown>; warnings: string[]; provider: string; requestId?: string; updatedAt: string }): Promise<ApplicationDraftRecord> {
  await db().prepare(`UPDATE mca_application_scan_drafts SET extraction_version = ?, fields = ?, evidence = ?, approved_fields = ?, warnings = ?,
    extraction_provider = ?, provider_request_id = ?, state = 'review', updated_at = ? WHERE workspace_id = ? AND id = ?`).run(
      input.extractionVersion, JSON.stringify(input.fields), JSON.stringify(input.evidence), JSON.stringify(input.approvedFields), JSON.stringify(input.warnings),
      input.provider, input.requestId ?? null, input.updatedAt, workspaceId, id,
    )
  return (await findApplicationDraft(workspaceId, id))!
}

export async function confirmApplicationDraftRecord(workspaceId: string, id: string, input: { approvedFields: Record<string, unknown>; confirmationId: string; dealId: string; updatedAt: string }): Promise<ApplicationDraftRecord> {
  await db().prepare(`UPDATE mca_application_scan_drafts SET approved_fields = ?, confirmation_id = ?, confirmed_deal_id = ?, state = 'confirmed', updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(JSON.stringify(input.approvedFields), input.confirmationId, input.dealId, input.updatedAt, workspaceId, id)
  return (await findApplicationDraft(workspaceId, id))!
}
