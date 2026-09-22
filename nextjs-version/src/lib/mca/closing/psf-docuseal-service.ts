import "server-only"

import { isDocumentReady } from "../documents/contracts"

import { AppError } from "../errors"
import { decryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import type { DocumentSummary } from "../documents/contracts"
import { listDocumentRecords } from "../documents/repository"
import { storeDocument } from "../documents/service"
import {
  fetchDocuSealArtifact,
  getVerifiedDocuSealCompletedSubmission,
  reconcileOrCreateDocuSealPsfSubmission,
  verifyDocuSealCompletedWebhook,
  type DocuSealProviderConfig,
  type DocuSealProviderDependencies,
  type DocuSealPsfSubmissionInput,
} from "./docuseal-provider"

type Row = Record<string, string | number | null>

export interface DocuSealPsfConnection extends DocuSealProviderConfig {
  workspaceId: string
}

export interface DocuSealPsfRecord extends DocuSealPsfSubmissionInput {
  createdAt: string
  state: "pending" | "delivered" | "failed" | "signed"
  externalRequestId?: string
  correlationId: string
}

export interface DocuSealAttemptReservation {
  id: string
  inserted: boolean
  state: "pending" | "sent" | "failed" | "blocked"
  externalId?: string
  errorCode?: string
}

export interface DocuSealPsfRepository {
  findRequest(workspaceId: string, requestId: string): Promise<DocuSealPsfRecord | undefined>
  findRequestBySubmission(workspaceId: string, submissionId: string): Promise<DocuSealPsfRecord | undefined>
  reserveAttempt(request: DocuSealPsfRecord): Promise<DocuSealAttemptReservation>
  markPending(request: DocuSealPsfRecord, reservationId: string, errorCode: string, errorMessage: string): Promise<void>
  markFailed(request: DocuSealPsfRecord, reservationId: string, errorCode: string, errorMessage: string): Promise<void>
  markDelivered(request: DocuSealPsfRecord, reservationId: string, submissionId: string): Promise<void>
  markCompletionPending(request: DocuSealPsfRecord, errorCode: string, errorMessage: string): Promise<void>
  markSigned(request: DocuSealPsfRecord, completedAt: string): Promise<boolean>
}

export interface DocuSealPsfServiceDependencies {
  repository?: DocuSealPsfRepository
  provider?: DocuSealProviderDependencies
  connectionJson?: string
  storeDocument?: (actor: DealActor, input: Parameters<typeof storeDocument>[1]) => Promise<DocumentSummary>
  listStoredEvidence?: (workspaceId: string, dealId: string) => Promise<Array<{ id: string; source: string; sourceReference?: string; processingState: string }>>
  audit?: typeof recordAuditEvent
}

export type DocuSealPsfDispatchResult =
  | { state: "delivered"; requestId: string; submissionId: string; submitterId?: string; reconciled: boolean }
  | { state: "pending_reconciliation"; requestId: string; errorCode: "docuseal_outcome_unknown" }
  | { state: "signed"; requestId: string; submissionId: string }

export interface DocuSealPsfCompletionResult {
  state: "signed" | "retained"
  requestId: string
  submissionId: string
  signedDocumentIds: string[]
  auditDocumentId?: string
  replayed: boolean
}

type EnvironmentConnection = Partial<Record<keyof DocuSealPsfConnection, unknown>>

function environmentConnections(raw: string | undefined): EnvironmentConnection[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true
      const candidate = (item as EnvironmentConnection).workspaceId
      return typeof candidate !== "string" || !candidate.trim()
    })) {
      throw new Error("invalid DocuSeal connection list")
    }
    return parsed as EnvironmentConnection[]
  } catch {
    throw new AppError(503, "docuseal_configuration_invalid", "MCA_DOCUSEAL_PSF_CONNECTIONS_JSON must be an array of workspace connections.")
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(503, "docuseal_configuration_invalid", `${name} is missing from the DocuSeal PSF connection.`)
  return value.trim()
}

function parseConnection(value: EnvironmentConnection): DocuSealPsfConnection {
  const templateId = typeof value.templateId === "number" ? value.templateId : Number.NaN
  if (!Number.isSafeInteger(templateId) || templateId <= 0) throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal templateId must be a positive integer.")
  if (typeof value.sendEmail !== "boolean" || typeof value.requireEmail2fa !== "boolean") throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal sendEmail and requireEmail2fa must be explicit booleans.")
  if (!value.fieldBindings || typeof value.fieldBindings !== "object" || Array.isArray(value.fieldBindings)) throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal fieldBindings are missing.")
  if (!Array.isArray(value.artifactAllowedHosts) || value.artifactAllowedHosts.some((host) => typeof host !== "string")) throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal artifactAllowedHosts must contain exact host names.")
  return {
    workspaceId: requiredString(value.workspaceId, "workspaceId"),
    apiBaseUrl: requiredString(value.apiBaseUrl, "apiBaseUrl"),
    apiToken: requiredString(value.apiToken, "apiToken"),
    webhookSecret: requiredString(value.webhookSecret, "webhookSecret"),
    templateId,
    signerRole: requiredString(value.signerRole, "signerRole"),
    fieldBindings: value.fieldBindings as DocuSealProviderConfig["fieldBindings"],
    sendEmail: value.sendEmail,
    requireEmail2fa: value.requireEmail2fa,
    artifactAllowedHosts: value.artifactAllowedHosts as string[],
  }
}

export function getDocuSealPsfConnection(workspaceId: string, raw = process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON): DocuSealPsfConnection {
  const matches = environmentConnections(raw).filter((entry) => entry.workspaceId === workspaceId)
  if (matches.length !== 1) throw new AppError(503, matches.length ? "docuseal_configuration_ambiguous" : "docuseal_unconfigured", matches.length ? "Exactly one DocuSeal PSF connection is required for this workspace." : "DocuSeal PSF delivery is not configured for this workspace.")
  return parseConnection(matches[0])
}

export function docuSealPsfConnectionConfigured(workspaceId: string, raw = process.env.MCA_DOCUSEAL_PSF_CONNECTIONS_JSON): boolean {
  try { getDocuSealPsfConnection(workspaceId, raw); return true } catch { return false }
}

export async function selectPsfDeliveryProvider(workspaceId: string, requestId: string, options: { database?: DbExecutor; connectionJson?: string } = {}): Promise<"docuseal" | "webhook"> {
  const database = options.database ?? getDatabase()
  const rows = await database.prepare<{ kind: string }>("SELECT DISTINCT kind FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=? AND kind IN ('psf_docuseal','psf_request')").all(workspaceId, requestId)
  if (rows.length > 1) throw new AppError(409, "psf_provider_conflict", "This PSF request has delivery history for more than one provider.")
  if (rows[0]?.kind === "psf_docuseal") {
    getDocuSealPsfConnection(workspaceId, options.connectionJson)
    return "docuseal"
  }
  if (rows[0]?.kind === "psf_request") return "webhook"
  try {
    getDocuSealPsfConnection(workspaceId, options.connectionJson)
    return "docuseal"
  } catch (error) {
    if (error instanceof AppError && error.code === "docuseal_unconfigured") return "webhook"
    throw error
  }
}

function systemActor(request: Pick<DocuSealPsfRecord, "workspaceId" | "correlationId">): DealActor {
  return {
    workspaceId: request.workspaceId,
    userId: null,
    membershipId: null,
    role: "super_admin",
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    correlationId: request.correlationId,
  }
}

function requestFromRow(row: Row, workspaceId: string): DocuSealPsfRecord {
  return {
    requestId: String(row.id),
    createdAt: String(row.created_at),
    workspaceId,
    dealId: String(row.deal_id),
    offerRevisionId: String(row.offer_revision_id),
    payloadHash: String(row.payload_hash),
    signerName: decryptSensitive(String(row.contact_name_cipher), workspaceId),
    signerEmail: decryptSensitive(String(row.contact_email_cipher), workspaceId),
    amountCents: Number(row.amount_cents),
    bankName: decryptSensitive(String(row.bank_name_cipher), workspaceId),
    routingNumber: decryptSensitive(String(row.routing_number_cipher), workspaceId),
    accountNumber: decryptSensitive(String(row.account_number_cipher), workspaceId),
    businessName: decryptSensitive(String(row.business_name_cipher), workspaceId),
    contactName: decryptSensitive(String(row.contact_name_cipher), workspaceId),
    contactEmail: decryptSensitive(String(row.contact_email_cipher), workspaceId),
    state: String(row.state) as DocuSealPsfRecord["state"],
    ...(row.external_request_id ? { externalRequestId: String(row.external_request_id) } : {}),
    correlationId: String(row.correlation_id),
  }
}

function defaultRepository(database: DbExecutor = getDatabase()): DocuSealPsfRepository {
  async function enabledRequest(where: string, workspaceId: string, identity: string): Promise<DocuSealPsfRecord | undefined> {
    const row = await database.prepare<Row>(`SELECT r.*,c.enabled AS config_enabled FROM mca_psf_requests r LEFT JOIN mca_psf_config c ON c.workspace_id=r.workspace_id WHERE r.workspace_id=? AND ${where}`).get(workspaceId, identity)
    if (!row) return undefined
    if (Number(row.config_enabled) !== 1) throw new AppError(503, "psf_delivery_disabled", "An administrator must enable PSF delivery for this workspace.")
    return requestFromRow(row, workspaceId)
  }
  return {
    findRequest: (workspaceId, requestId) => enabledRequest("r.id=?", workspaceId, requestId),
    async findRequestBySubmission(workspaceId, submissionId) {
      const rows = await database.prepare<Row>("SELECT r.*,c.enabled AS config_enabled FROM mca_psf_requests r LEFT JOIN mca_psf_config c ON c.workspace_id=r.workspace_id WHERE r.workspace_id=? AND r.external_request_id=? LIMIT 2").all(workspaceId, submissionId)
      if (rows.length > 1) throw new AppError(409, "docuseal_submission_ambiguous", "More than one PSF request is bound to this DocuSeal submission.")
      if (!rows[0]) return undefined
      if (Number(rows[0].config_enabled) !== 1) throw new AppError(503, "psf_delivery_disabled", "An administrator must enable PSF delivery for this workspace.")
      return requestFromRow(rows[0], workspaceId)
    },
    async reserveAttempt(request) {
      const id = newId(), timestamp = nowIso(), attemptKey = `docuseal:${request.requestId}`
      return withImmediateTransaction(async (transaction) => {
        await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`${request.workspaceId}:psf-provider:${request.requestId}`)
        const opposite = await transaction.prepare<Row>("SELECT id FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=? AND kind='psf_request' LIMIT 1").get(request.workspaceId, request.requestId)
        if (opposite) throw new AppError(409, "psf_provider_conflict", "This PSF request is already reserved for the webhook provider.")
        const inserted = await transaction.prepare<Row>(`INSERT INTO mca_closing_deliveries
          (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'webhook','pending',NULL,?,?,NULL,NULL,NULL,?,?)
          ON CONFLICT (workspace_id,kind,record_id,attempt_key) DO NOTHING RETURNING *`).get(id, request.workspaceId, request.dealId, "psf_docuseal", request.requestId, attemptKey, request.payloadHash, request.correlationId, timestamp, timestamp)
        const row = inserted ?? await transaction.prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND kind='psf_docuseal' AND record_id=? AND attempt_key=?").get(request.workspaceId, request.requestId, attemptKey)
        if (!row || String(row.deal_id) !== request.dealId || String(row.payload_hash) !== request.payloadHash) throw new AppError(409, "docuseal_reservation_conflict", "The durable DocuSeal delivery reservation does not match this PSF request.")
        return { id: String(row.id), inserted: Boolean(inserted), state: String(row.state) as DocuSealAttemptReservation["state"], ...(row.external_id ? { externalId: String(row.external_id) } : {}), ...(row.error_code ? { errorCode: String(row.error_code) } : {}) }
      })
    },
    async markPending(request, reservationId, errorCode, errorMessage) {
      const timestamp = nowIso()
      await withImmediateTransaction(async (transaction) => {
        await transaction.prepare("UPDATE mca_closing_deliveries SET state='pending',error_code=?,error_message=?,updated_at=? WHERE workspace_id=? AND id=? AND state<>'sent' AND external_id IS NULL").run(errorCode, errorMessage, timestamp, request.workspaceId, reservationId)
        await transaction.prepare("UPDATE mca_psf_requests SET state='pending',last_error_code=?,last_error_message=?,updated_at=? WHERE workspace_id=? AND id=? AND state IN ('pending','failed') AND external_request_id IS NULL").run(errorCode, errorMessage, timestamp, request.workspaceId, request.requestId)
      })
    },
    async markFailed(request, reservationId, errorCode, errorMessage) {
      const timestamp = nowIso()
      await withImmediateTransaction(async (transaction) => {
        await transaction.prepare("UPDATE mca_closing_deliveries SET state='failed',error_code=?,error_message=?,updated_at=? WHERE workspace_id=? AND id=? AND state<>'sent' AND external_id IS NULL").run(errorCode, errorMessage, timestamp, request.workspaceId, reservationId)
        await transaction.prepare("UPDATE mca_psf_requests SET state='failed',last_error_code=?,last_error_message=?,updated_at=? WHERE workspace_id=? AND id=? AND state IN ('pending','failed') AND external_request_id IS NULL").run(errorCode, errorMessage, timestamp, request.workspaceId, request.requestId)
      })
    },
    async markDelivered(request, reservationId, submissionId) {
      const timestamp = nowIso()
      await withImmediateTransaction(async (transaction) => {
        await transaction.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`${request.workspaceId}:docuseal:${submissionId}`)
        const conflict = await transaction.prepare<Row>("SELECT id FROM mca_psf_requests WHERE workspace_id=? AND external_request_id=? AND id<>? LIMIT 1").get(request.workspaceId, submissionId, request.requestId)
        if (conflict) throw new AppError(409, "docuseal_submission_conflict", "This DocuSeal submission is already bound to another PSF request.")
        await transaction.prepare("UPDATE mca_closing_deliveries SET state='sent',external_id=?,error_code=NULL,error_message=NULL,updated_at=? WHERE workspace_id=? AND id=?").run(submissionId, timestamp, request.workspaceId, reservationId)
        const updated = await transaction.prepare<Row>("UPDATE mca_psf_requests SET state='delivered',external_request_id=?,last_error_code=NULL,last_error_message=NULL,delivered_at=COALESCE(delivered_at,?),updated_at=? WHERE workspace_id=? AND id=? AND state<>'signed' AND (external_request_id IS NULL OR external_request_id=?) RETURNING id").get(submissionId, timestamp, timestamp, request.workspaceId, request.requestId, submissionId)
        if (!updated) throw new AppError(409, "docuseal_submission_conflict", "This PSF request is already bound to another provider submission.")
      })
    },
    async markCompletionPending(request, errorCode, errorMessage) {
      await database.prepare("UPDATE mca_psf_requests SET last_error_code=?,last_error_message=?,updated_at=? WHERE workspace_id=? AND id=? AND state='delivered'").run(errorCode, errorMessage, nowIso(), request.workspaceId, request.requestId)
    },
    async markSigned(request, completedAt) {
      const row = await database.prepare<Row>("UPDATE mca_psf_requests SET state='signed',signed_at=?,last_error_code=NULL,last_error_message=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='delivered' RETURNING id").get(completedAt, nowIso(), request.workspaceId, request.requestId)
      if (row) return true
      const current = await database.prepare<Row>("SELECT state FROM mca_psf_requests WHERE workspace_id=? AND id=?").get(request.workspaceId, request.requestId)
      if (current?.state === "signed") return false
      throw new AppError(409, "psf_state_conflict", "The PSF request state changed before signed evidence was stored.")
    },
  }
}

function repository(dependencies: DocuSealPsfServiceDependencies): DocuSealPsfRepository {
  return dependencies.repository ?? defaultRepository()
}

function errorDetails(error: unknown): { code: string; message: string } {
  return error instanceof AppError ? { code: error.code, message: error.message } : { code: "docuseal_provider_failed", message: "DocuSeal processing failed." }
}

export async function deliverPsfRequestWithDocuSeal(actor: DealActor, requestId: string, dependencies: DocuSealPsfServiceDependencies = {}): Promise<DocuSealPsfDispatchResult> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const repo = repository(dependencies)
  const request = await repo.findRequest(actor.workspaceId, requestId)
  if (!request) throw new AppError(404, "psf_request_not_found", "The PSF request was not found.")
  await (await import("../outbound-approval")).assertOutboundDispatch(actor.workspaceId, request.createdAt)
  if (request.state === "signed") {
    if (!request.externalRequestId) throw new AppError(409, "psf_state_conflict", "The signed PSF request has no provider identity.")
    return { state: "signed", requestId, submissionId: request.externalRequestId }
  }
  const config = getDocuSealPsfConnection(actor.workspaceId, dependencies.connectionJson)
  const reservation = await repo.reserveAttempt(request)
  if (!reservation.inserted && reservation.state === "sent" && reservation.externalId) {
    await repo.markDelivered(request, reservation.id, reservation.externalId)
    return { state: "delivered", requestId, submissionId: reservation.externalId, reconciled: true }
  }
  if (request.externalRequestId && request.externalRequestId !== reservation.externalId) throw new AppError(409, "docuseal_provider_conflict", "This PSF request is already bound to a different delivery provider identity.")
  try {
    const identity = await reconcileOrCreateDocuSealPsfSubmission(config, request, reservation.inserted ? "never_attempted" : "reconcile_only", {
      ...dependencies.provider,
      beforeRequest: async () => {
        await dependencies.provider?.beforeRequest?.()
        await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
        await (await import("../outbound-approval")).assertOutboundDispatch(actor.workspaceId, request.createdAt)
      },
    })
    if (!identity) {
      await repo.markPending(request, reservation.id, "docuseal_outcome_unknown", "DocuSeal has not exposed a submission for the reserved request. Reconciliation will not create another submission.")
      return { state: "pending_reconciliation", requestId, errorCode: "docuseal_outcome_unknown" }
    }
    await repo.markDelivered(request, reservation.id, identity.submissionId)
    await (dependencies.audit ?? recordAuditEvent)({ context: actor, action: "closing.psf_docuseal_delivered", resourceType: "psf_request", resourceId: requestId, metadata: { submissionId: identity.submissionId, reconciled: identity.source === "reconciled", payloadHash: request.payloadHash }, correlationId: request.correlationId })
    return { state: "delivered", requestId, submissionId: identity.submissionId, submitterId: identity.submitterId, reconciled: identity.source === "reconciled" }
  } catch (error) {
    const detail = errorDetails(error)
    if (detail.code === "docuseal_outcome_unknown") {
      await repo.markPending(request, reservation.id, detail.code, detail.message)
      return { state: "pending_reconciliation", requestId, errorCode: "docuseal_outcome_unknown" }
    }
    await repo.markFailed(request, reservation.id, detail.code, detail.message)
    throw error
  }
}

function artifactKey(requestId: string, submissionId: string, kind: "signed" | "audit", index = 0): string {
  return `docuseal:${requestId}:${submissionId}:${kind}:${index}`
}

async function persistArtifact(input: {
  request: DocuSealPsfRecord
  submissionId: string
  key: string
  filename: string
  source: "docuseal_signed_psf" | "docuseal_audit_log"
  sourceReference: string
  url: string
}, config: DocuSealPsfConnection, dependencies: DocuSealPsfServiceDependencies): Promise<DocumentSummary> {
  // Always authenticate and fetch the current provider artifact. storeDocument then
  // verifies any idempotent replay against the immutable deal/category/checksum.
  const artifact = await fetchDocuSealArtifact(config, input.url, dependencies.provider)
  const document = await (dependencies.storeDocument ?? storeDocument)(systemActor(input.request), {
    dealId: input.request.dealId,
    idempotencyKey: input.key,
    filename: input.filename,
    mimeType: artifact.mimeType,
    bytes: artifact.bytes,
    category: "closing_document",
    source: input.source,
    sourceReference: input.sourceReference,
  })
  if (document.checksum !== artifact.checksum) throw new AppError(409, "docuseal_artifact_checksum_mismatch", "Stored DocuSeal evidence does not match the downloaded artifact.")
  if (!isDocumentReady(document.processingState)) throw new AppError(423, "docuseal_artifact_not_clean", "DocuSeal signature evidence must finish uploading before the request can be signed.")
  return document
}

async function storedEvidence(request: DocuSealPsfRecord, submissionId: string, dependencies: DocuSealPsfServiceDependencies): Promise<{ signedDocumentIds: string[]; auditDocumentId?: string }> {
  const records = dependencies.listStoredEvidence
    ? await dependencies.listStoredEvidence(request.workspaceId, request.dealId)
    : await listDocumentRecords(request.workspaceId, request.dealId)
  const prefix = `docuseal:${submissionId}:`, clean = records.filter((record) => isDocumentReady(record.processingState) && record.sourceReference?.startsWith(prefix))
  const signedDocumentIds = clean.filter((record) => record.source === "docuseal_signed_psf" && /^signed:\d+$/.test(record.sourceReference!.slice(prefix.length))).map((record) => record.id)
  const audit = clean.find((record) => record.source === "docuseal_audit_log" && record.sourceReference === `${prefix}audit`)
  return { signedDocumentIds, ...(audit ? { auditDocumentId: audit.id } : {}) }
}

export async function recordDocuSealPsfWebhook(workspaceId: string, rawBody: string | Uint8Array, signatureHeader: string | null, dependencies: DocuSealPsfServiceDependencies = {}): Promise<DocuSealPsfCompletionResult> {
  const config = getDocuSealPsfConnection(workspaceId, dependencies.connectionJson)
  const webhook = verifyDocuSealCompletedWebhook(rawBody, signatureHeader, config.webhookSecret)
  const repo = repository(dependencies)
  const request = await repo.findRequestBySubmission(workspaceId, webhook.submissionId)
  if (!request) throw new AppError(404, "psf_request_not_found", "No enabled PSF request matches this DocuSeal submission.")
  if (request.state === "signed") return { state: "signed", requestId: request.requestId, submissionId: webhook.submissionId, ...(await storedEvidence(request, webhook.submissionId, dependencies)), replayed: true }
  if (request.state !== "delivered" || request.externalRequestId !== webhook.submissionId) throw new AppError(409, "psf_state_conflict", "The DocuSeal completion does not match a delivered PSF request.")
  if (await (await import("../paused-receipts")).retainReceiptIfPaused({ workspaceId, kind: "docuseal_completion", resourceId: request.requestId, payload: webhook })) {
    await repo.markCompletionPending(request, "company_paused", "Authenticated signing receipt retained. Restore company access and refresh provider evidence.")
    return { state: "retained", requestId: request.requestId, submissionId: webhook.submissionId, signedDocumentIds: [], replayed: false }
  }
  const completion = await getVerifiedDocuSealCompletedSubmission(config, { submissionId: webhook.submissionId, requestId: request.requestId, signerEmail: request.signerEmail, signerRole: config.signerRole }, dependencies.provider)
  await repo.markCompletionPending(request, "completed_pending_artifact", "DocuSeal completed signing; signed documents and the audit log are being verified and stored.")
  const signedDocumentIds: string[] = []
  let auditDocumentId: string | undefined
  try {
    for (const [index, reference] of completion.documents.entries()) {
      const stored = await persistArtifact({ request, submissionId: webhook.submissionId, key: artifactKey(request.requestId, webhook.submissionId, "signed", index), filename: reference.name, source: "docuseal_signed_psf", sourceReference: `docuseal:${webhook.submissionId}:signed:${index}`, url: reference.url }, config, dependencies)
      signedDocumentIds.push(stored.id)
    }
    const audit = await persistArtifact({ request, submissionId: webhook.submissionId, key: artifactKey(request.requestId, webhook.submissionId, "audit"), filename: completion.auditLog.name, source: "docuseal_audit_log", sourceReference: `docuseal:${webhook.submissionId}:audit`, url: completion.auditLog.url }, config, dependencies)
    auditDocumentId = audit.id
  } catch (error) {
    const detail = errorDetails(error)
    await repo.markCompletionPending(request, detail.code, detail.message)
    throw error
  }
  const changed = await repo.markSigned(request, completion.completedAt)
  await (dependencies.audit ?? recordAuditEvent)({ context: systemActor(request), action: "closing.psf_docuseal_signed", resourceType: "psf_request", resourceId: request.requestId, metadata: { submissionId: webhook.submissionId, signedDocumentIds, auditDocumentId, evidenceScanState: "clean", payloadHash: request.payloadHash }, correlationId: request.correlationId })
  return { state: "signed", requestId: request.requestId, submissionId: webhook.submissionId, signedDocumentIds, auditDocumentId, replayed: !changed }
}
