import "server-only"
import { assertOutboundDispatch, withOutboundApproval } from "../outbound-approval"

import { isDocumentReady } from "../documents/contracts"

import { createHmac, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { AppError } from "../errors"
import { createOpaqueToken, decryptSensitive, encryptSensitive, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { permittedAssignmentIds } from "../deals/access-policy"
import { DOCUMENT_CATEGORIES, type DocumentCategory } from "../documents/contracts"
import { getDocument, getDocumentContent, listSubmissionDocuments, retryDocumentScan, storeDocument } from "../documents/service"
import { documentRuntimeEnabled } from "../jobs/document-runtime"
import { assertSenderUsable } from "../senders/service"
import { getSmsConsent, listSmsAccounts, normalizeSmsRecipient, resolveSmsRoute } from "../sms/service"
import type { TwilioSmsTransport } from "../sms/twilio"
import { assertOfferRevisionEligibleForClosing, assertOfferRevisionValidity, getOfferRevisionForClosing, listOfferRevisionsForClosing } from "../offers/service"
import { isOfferRevisionOpenForMerchantPreview, type OfferRevisionForClosing } from "../offers/contracts"
import { pickHighestMerchantOffer } from "../offers/rank"
import { psfProviderReady } from "../integrations/connection-status"
import { closingTransport, contentHash, deliveryCorrelationId, postmarkConnectionConfigured } from "./delivery"
import type { ClosingTransport, ClosingTransportRequest } from "./delivery"
import { createMerchantOfferSmsTransport } from "./offer-sms"
import { deliverPsfRequestWithDocuSeal, docuSealPsfConnectionConfigured, recordDocuSealPsfWebhook as processDocuSealPsfWebhook, selectPsfDeliveryProvider } from "./psf-docuseal-service"
import { assertUsAbaRoutingNumber } from "./aba"
import { bindFunderEmail, bindMerchantEmail, bindMerchantSms, maskClosingEmail, maskClosingSms, recordRecipientOverrideAudit } from "./recipients"
import { verifiedClosingFlowEnabled } from "./verified-flow"
import type { ClosingDelivery, ClosingRequestPreview, ClosingSnapshot, ContractWorkflow, MerchantUploadLink, OfferMessagePreview, OfferRevisionBinding, PsfRequestSummary, StipulationState, StipulationTask } from "./contracts"

type Row = Record<string, string | number | null>
const idempotencyPattern = /^[A-Za-z0-9._:-]{1,160}$/

function required(value: string | undefined, field: string, max = 300): string {
  const normalized = value?.trim()
  if (!normalized || normalized.length > max) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`${field} is required and must be at most ${max} characters.`] })
  return normalized
}

function idempotency(value: string): string {
  if (!idempotencyPattern.test(value)) throw new AppError(422, "invalid_idempotency_key", "Provide a stable idempotency key using letters, numbers, period, underscore, colon, or hyphen.")
  return value
}

function offerSnapshot(value: OfferRevisionForClosing): OfferRevisionBinding { return { ...value } }
function maskEmail(value: string): string { return maskClosingEmail(value) }
function maskRecipient(value: string, channel: "email" | "sms"): string { return channel === "email" ? maskClosingEmail(value) : maskClosingSms(value) }
function json<T>(value: unknown, fallback: T): T { return parseJson(value, fallback) }

function stipulation(row: Row): StipulationTask {
  return {
    id: String(row.id), dealId: String(row.deal_id), offerId: row.offer_id ? String(row.offer_id) : undefined,
    offerRevisionId: row.offer_revision_id ? String(row.offer_revision_id) : undefined, funderId: row.funder_id ? String(row.funder_id) : undefined,
    documentCategory: String(row.document_category), label: String(row.label), ownerMembershipId: row.owner_membership_id ? String(row.owner_membership_id) : undefined,
    dueDate: row.due_date ? String(row.due_date) : undefined, status: String(row.status) as StipulationState,
    linkedDocumentId: row.linked_document_id ? String(row.linked_document_id) : undefined,
    exceptionReason: row.exception_reason ? String(row.exception_reason) : undefined, createdAt: String(row.created_at),
    receivedAt: row.received_at ? String(row.received_at) : undefined, verifiedAt: row.verified_at ? String(row.verified_at) : undefined,
    updatedAt: String(row.updated_at),
  }
}

function uploadLink(row: Row): MerchantUploadLink {
  return { id: String(row.id), stipulationId: row.stipulation_id ? String(row.stipulation_id) : undefined, destinationCategory: String(row.destination_category), expiresAt: String(row.expires_at), maxUploads: Number(row.max_uploads), usedCount: Number(row.used_count) }
}

function delivery(row: Row): ClosingDelivery {
  return { id: String(row.id), kind: String(row.kind), recordId: String(row.record_id), channel: String(row.channel) as ClosingDelivery["channel"], state: String(row.state) as ClosingDelivery["state"], payloadHash: String(row.payload_hash), correlationId: String(row.correlation_id), externalId: row.external_id ? String(row.external_id) : undefined, errorCode: row.error_code ? String(row.error_code) : undefined, errorMessage: row.error_message ? String(row.error_message) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

async function resolveOffer(actor: DealActor, dealId: string, offerId?: string, revisionId?: string): Promise<OfferRevisionForClosing> {
  const offer = await getOfferRevisionForClosing(actor, { dealId, offerId, revisionId })
  assertOfferRevisionEligibleForClosing(offer)
  return offer
}

async function contract(row: Row, actor: DealActor): Promise<ContractWorkflow> {
  const offer = await getOfferRevisionForClosing(actor, { dealId: String(row.deal_id), offerId: String(row.offer_id), revisionId: String(row.offer_revision_id) })
  const source = row.signature_source ? String(row.signature_source) as "external" | "manual" : undefined
  return {
    id: String(row.id), dealId: String(row.deal_id), offer: offerSnapshot(offer), state: String(row.state) as ContractWorkflow["state"],
    recipientMasked: row.recipient_cipher ? maskEmail(decryptSensitive(String(row.recipient_cipher), actor.workspaceId)) : undefined,
    attachedDocumentIds: json(row.attached_document_ids_json, []), outstandingStips: json(row.outstanding_stips_json, []),
    acceptedAt: row.accepted_at ? String(row.accepted_at) : undefined, contractRequestedAt: row.contract_requested_at ? String(row.contract_requested_at) : undefined,
    contractSentAt: row.contract_sent_at ? String(row.contract_sent_at) : undefined, signedAt: row.signed_at ? String(row.signed_at) : undefined,
    finalReviewAt: row.final_review_at ? String(row.final_review_at) : undefined, repricingRequestedAt: row.repricing_requested_at ? String(row.repricing_requested_at) : undefined,
    signature: source ? { source, externalId: row.signature_external_id ? String(row.signature_external_id) : undefined, evidenceDocumentId: row.signature_evidence_document_id ? String(row.signature_evidence_document_id) : undefined, manualReason: row.manual_signature_reason ? String(row.manual_signature_reason) : undefined } : undefined,
    updatedAt: String(row.updated_at),
  }
}

async function psf(row: Row, actor: DealActor): Promise<PsfRequestSummary> {
  const offer = await getOfferRevisionForClosing(actor, { dealId: String(row.deal_id), offerId: String(row.offer_id), revisionId: String(row.offer_revision_id) })
  const bank = decryptSensitive(String(row.bank_name_cipher), actor.workspaceId), account = decryptSensitive(String(row.account_number_cipher), actor.workspaceId)
  return { id: String(row.id), dealId: String(row.deal_id), offer: offerSnapshot(offer), amountCents: Number(row.amount_cents), bankNameMasked: bank ? `${bank.slice(0, 1)}•••` : "••••", accountLast4: account.slice(-4), state: String(row.state) as PsfRequestSummary["state"], payloadVersion: Number(row.payload_version), payloadHash: String(row.payload_hash), correlationId: String(row.correlation_id), externalRequestId: row.external_request_id ? String(row.external_request_id) : undefined, lastErrorCode: row.last_error_code ? String(row.last_error_code) : undefined, lastErrorMessage: row.last_error_message ? String(row.last_error_message) : undefined, deliveredAt: row.delivered_at ? String(row.delivered_at) : undefined, signedAt: row.signed_at ? String(row.signed_at) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

async function message(row: Row, actor: DealActor): Promise<OfferMessagePreview> {
  const offer = await getOfferRevisionForClosing(actor, { dealId: String(row.deal_id), offerId: String(row.offer_id), revisionId: String(row.offer_revision_id) })
  const channel = String(row.channel) as "email" | "sms"
  return { id: String(row.id), dealId: String(row.deal_id), offer: offerSnapshot(offer), selectionMode: String(row.selection_mode) as OfferMessagePreview["selectionMode"], channel, senderId: row.sender_id ? String(row.sender_id) : undefined, recipientMasked: maskRecipient(decryptSensitive(String(row.recipient_cipher), actor.workspaceId), channel), subject: row.subject_cipher ? decryptSensitive(String(row.subject_cipher), actor.workspaceId) : undefined, body: decryptSensitive(String(row.body_cipher), actor.workspaceId), contentHash: String(row.content_hash), state: String(row.state) as OfferMessagePreview["state"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

export async function getClosingSnapshot(actor: DealActor, dealId: string): Promise<ClosingSnapshot> {
  const deal = await getDealForDocument(actor, dealId)
  const database = getDatabase()
  const psfConfig = await database.prepare<Row>("SELECT visible_to_reps, enabled, destination_cipher, signing_secret_cipher FROM mca_psf_config WHERE workspace_id=?").get(actor.workspaceId)
  const mayViewPsf = actor.source !== "api_key" && (actor.role === "admin" || actor.role === "super_admin" || (Number(psfConfig?.visible_to_reps) === 1 && (actor.role === "rep" || actor.role === "manager")))
  const docuSealConfigured = docuSealPsfConnectionConfigured(actor.workspaceId)
  const psfDeliveryReady = psfProviderReady({
    docuSealConfigured,
    enabled: Number(psfConfig?.enabled) === 1,
    destinationConfigured: Boolean(psfConfig?.destination_cipher),
    signingSecretConfigured: Boolean(psfConfig?.signing_secret_cipher),
  })
  const verifiedPsfReady = psfDeliveryReady && (!verifiedClosingFlowEnabled() || docuSealConfigured)
  const [stipRows, contractRows, psfRows, messageRows, deliveryRows, pitchRows] = await Promise.all([
    database.prepare<Row>("SELECT * FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC").all(actor.workspaceId, dealId),
    database.prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC").all(actor.workspaceId, dealId),
    mayViewPsf ? database.prepare<Row>("SELECT * FROM mca_psf_requests WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC").all(actor.workspaceId, dealId) : Promise.resolve([]),
    database.prepare<Row>("SELECT * FROM mca_offer_message_previews WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC LIMIT 20").all(actor.workspaceId, dealId),
    database.prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND deal_id=? ORDER BY created_at DESC LIMIT 30").all(actor.workspaceId, dealId),
    database.prepare<Row>("SELECT DISTINCT offer_revision_id FROM mca_pitch_events WHERE workspace_id=? AND deal_id=?").all(actor.workspaceId, dealId),
  ])
  const allowedOwnerIds = permittedAssignmentIds(actor)
  const ownerRows = await database.prepare<Row>("SELECT m.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' ORDER BY lower(u.name)").all(actor.workspaceId)
  const postmarkConfigured = postmarkConnectionConfigured(actor.workspaceId)
  const emailTransportConfigured = postmarkConfigured || Boolean(process.env.MCA_CLOSING_EMAIL_WEBHOOK_URL)
  const smsAccounts = (await listSmsAccounts(actor)).accounts.filter((item) => item.state === "active")
  const smsProviderConfigured = smsAccounts.some((item) => item.providerConfigured)
  return {
    dealId, stipulations: stipRows.map(stipulation), contracts: await Promise.all(contractRows.map((row) => contract(row, actor))),
    psfRequests: await Promise.all(psfRows.map((row) => psf(row, actor))), messagePreviews: await Promise.all(messageRows.map((row) => message(row, actor))),
    deliveries: deliveryRows.map(delivery), pitchedRevisionIds: pitchRows.map((row) => String(row.offer_revision_id)),
    capabilities: { psfVisible: mayViewPsf, psfAdmin: actor.source !== "api_key" && (actor.role === "admin" || actor.role === "super_admin") },
    psfDeliveryReady: verifiedPsfReady,
    verifiedFlowEnabled: verifiedClosingFlowEnabled(),
    merchantContact: { email: deal.contactEmail, phone: deal.contactPhone },
    assignableOwners: ownerRows.filter((row) => allowedOwnerIds.has(String(row.id))).map((row) => ({ id: String(row.id), name: String(row.name) })),
    merchantSmsAccounts: smsAccounts.map((item) => ({ id: item.id, label: item.label, senderMasked: item.senderMasked, providerConfigured: item.providerConfigured, isDefault: item.isDefault })),
    productionGates: {
      merchantEmail: postmarkConfigured || process.env.MCA_MERCHANT_EMAIL_WEBHOOK_URL ? "configured; verify delivery before production use" : "unavailable: connect merchant email in Settings",
      merchantSms: smsProviderConfigured ? "ready when merchant text consent is recorded" : "unavailable: connect and assign merchant text messaging in Settings",
      contractDelivery: emailTransportConfigured ? "configured; verify delivery before production use" : "unavailable: connect contract delivery in Settings",
      contractSignature: "unavailable: no verified contract signature callback is connected; use documented manual evidence review",
      psfDelivery: verifiedClosingFlowEnabled() && !docuSealConfigured
        ? "unavailable: connect DocuSeal with an approved PSF template and signed callback"
        : docuSealConfigured
        ? (psfDeliveryReady
          ? "DocuSeal is configured; verify delivery before production use"
          : "DocuSeal is configured; enable PSF delivery before sending")
        : psfDeliveryReady
          ? "webhook is configured; verify delivery before production use"
          : "available after an administrator connects and validates the PSF provider",
    },
  }
}

export async function createStipulation(actor: DealActor, input: { dealId: string; offerId?: string; revisionId?: string; funderId?: string; documentCategory: string; label: string; ownerMembershipId?: string; dueDate?: string; idempotencyKey: string }): Promise<StipulationTask> {
  await getDealForDocument(actor, input.dealId)
  if (!DOCUMENT_CATEGORIES.includes(input.documentCategory as DocumentCategory)) throw new AppError(422, "document_category_invalid", "Choose a valid document destination.")
  if (input.ownerMembershipId && !actor.activeMembershipIds.includes(input.ownerMembershipId)) throw new AppError(422, "owner_invalid", "Choose an active workspace member.")
  const offer = input.offerId || input.revisionId ? await resolveOffer(actor, input.dealId, input.offerId, input.revisionId) : undefined
  const key = idempotency(input.idempotencyKey), now = nowIso(), id = newId()
  const result = await getDatabase().prepare<Row>(`INSERT INTO mca_closing_stipulations
    (id,workspace_id,deal_id,offer_id,offer_revision_id,funder_id,document_category,label,owner_membership_id,due_date,status,linked_document_id,exception_reason,idempotency_key,created_by_user_id,created_at,received_at,verified_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'open',NULL,NULL,?,?,?,NULL,NULL,?) ON CONFLICT (workspace_id,deal_id,idempotency_key) DO NOTHING RETURNING *`).get(
      id, actor.workspaceId, input.dealId, offer?.offerId ?? null, offer?.revisionId ?? null, input.funderId ?? offer?.funderId ?? null,
      input.documentCategory, required(input.label, "label", 180), input.ownerMembershipId ?? null, input.dueDate ?? null, key, actor.userId, now, now)
  const row = result ?? await getDatabase().prepare<Row>("SELECT * FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? AND idempotency_key=?").get(actor.workspaceId, input.dealId, key)
  if (!row || String(row.document_category) !== input.documentCategory || String(row.label) !== input.label.trim()) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different stipulation.")
  if (result) await recordAuditEvent({ context: actor, action: "closing.stipulation_created", resourceType: "closing_stipulation", resourceId: id, metadata: { dealId: input.dealId, documentCategory: input.documentCategory, offerRevisionId: offer?.revisionId }, correlationId: actor.correlationId })
  return stipulation(row)
}

export async function updateStipulation(actor: DealActor, id: string, input: { status: "verified" | "waived"; exceptionReason?: string }): Promise<StipulationTask> {
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_closing_stipulations WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
  if (!row) throw new AppError(404, "stipulation_not_found", "The stipulation was not found.")
  await getDealForDocument(actor, String(row.deal_id))
  if (input.status === "verified") {
    if (!row.linked_document_id || String(row.status) !== "received") throw new AppError(409, "stipulation_not_received", "Upload and validate the requested document before verification.")
    const document = await getDocument(actor, String(row.linked_document_id))
    if (!isDocumentReady(document.processingState) || document.category !== row.document_category) throw new AppError(409, "document_not_valid_for_stipulation", "The uploaded document must be ready and retain the requested category before verification.")
  } else if (!required(input.exceptionReason, "exceptionReason", 500)) throw new AppError(422, "exception_required", "Explain why this stipulation is waived.")
  const now = nowIso()
  const updated = await getDatabase().prepare<Row>(`UPDATE mca_closing_stipulations SET status=?, exception_reason=?, verified_at=?, updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(input.status, input.status === "waived" ? input.exceptionReason!.trim() : null, input.status === "verified" ? now : null, now, actor.workspaceId, id)
  await recordAuditEvent({ context: actor, action: `closing.stipulation_${input.status}`, resourceType: "closing_stipulation", resourceId: id, metadata: { dealId: row.deal_id, hasDocument: Boolean(row.linked_document_id) }, correlationId: actor.correlationId })
  return stipulation(updated!)
}

export async function createMerchantUploadLink(actor: DealActor, input: { stipulationId: string; idempotencyKey: string; expiresInHours?: number; maxUploads?: number; origin: string }): Promise<MerchantUploadLink> {
  const taskRow = await getDatabase().prepare<Row>("SELECT * FROM mca_closing_stipulations WHERE workspace_id=? AND id=?").get(actor.workspaceId, input.stipulationId)
  if (!taskRow) throw new AppError(404, "stipulation_not_found", "The stipulation was not found.")
  await getDealForDocument(actor, String(taskRow.deal_id))
  if (["verified", "waived"].includes(String(taskRow.status))) throw new AppError(409, "stipulation_closed", "This stipulation no longer accepts uploads.")
  const key = idempotency(input.idempotencyKey)
  const origin = input.origin.replace(/\/$/, "")
  const existing = await getDatabase().prepare<Row>("SELECT * FROM mca_merchant_upload_links WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
  if (existing) {
    if (String(existing.stipulation_id) !== input.stipulationId) throw new AppError(409, "idempotency_conflict", "That retry key already identifies another upload request.")
    return { ...uploadLink(existing), url: `${origin}/merchant-upload/${merchantUploadTokenFromRow(existing, actor.workspaceId, input.stipulationId, key)}` }
  }
  const token = createOpaqueToken(32)
  const id = newId(), now = nowIso(), hours = Math.min(Math.max(input.expiresInHours ?? 72, 1), 168), maxUploads = Math.min(Math.max(input.maxUploads ?? 1, 1), 10)
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString()
  const row = await getDatabase().prepare<Row>(`INSERT INTO mca_merchant_upload_links
    (id,workspace_id,deal_id,stipulation_id,token_hash,token_cipher,destination_category,expires_at,max_uploads,used_count,revoked_at,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,NULL,?,?,?,?) RETURNING *`).get(id, actor.workspaceId, taskRow.deal_id, input.stipulationId, hashOpaqueToken(token), encryptSensitive(token, actor.workspaceId), taskRow.document_category, expiresAt, maxUploads, key, actor.userId, now, now)
  await recordAuditEvent({ context: actor, action: "closing.upload_link_created", resourceType: "merchant_upload_link", resourceId: id, metadata: { stipulationId: input.stipulationId, expiresAt, maxUploads }, correlationId: actor.correlationId })
  return { ...uploadLink(row!), url: `${origin}/merchant-upload/${token}` }
}

function closingTokenSecret(name: "upload" | "artifact"): Buffer {
  const envName = name === "upload" ? "MCA_UPLOAD_TOKEN_SECRET" : "MCA_CLOSING_ARTIFACT_TOKEN_SECRET"
  const configured = process.env[envName]
  if (configured && configured.length >= 32) return Buffer.from(configured)
  if (process.env.NODE_ENV === "production") throw new AppError(503, `${name}_tokens_unavailable`, `Configure ${envName} before issuing ${name} links.`)
  return Buffer.from(`local-only-${name}-token-secret-32-bytes-minimum`)
}

function merchantUploadToken(workspaceId: string, stipulationId: string, key: string): string {
  return createHmac("sha256", closingTokenSecret("upload")).update(`${workspaceId}:${stipulationId}:${key}`).digest("base64url")
}

function merchantUploadTokenFromRow(row: Row, workspaceId: string, stipulationId: string, key: string): string {
  if (row.token_cipher) return decryptSensitive(String(row.token_cipher), workspaceId)
  return merchantUploadToken(workspaceId, stipulationId, key)
}

function secureUploadPlaceholder(): RegExp {
  return /\[secure-upload:([A-Za-z0-9._:-]{1,160})\]/g
}

async function materializeSecureUploadBody(actor: DealActor, previewId: string, body: string, origin: string): Promise<string> {
  const stipulationIds = [...new Set([...body.matchAll(secureUploadPlaceholder())].map((match) => match[1]))]
  if (!stipulationIds.length) return body
  const urls = new Map<string, string>()
  for (const stipulationId of stipulationIds) {
    const link = await createMerchantUploadLink(actor, { stipulationId, idempotencyKey: `send:${previewId}:${stipulationId}`, origin })
    if (!link.url) throw new AppError(409, "upload_link_unavailable", "Create a new preview to issue a fresh secure upload link.")
    urls.set(stipulationId, link.url)
  }
  return body.replace(secureUploadPlaceholder(), (_match, stipulationId: string) => urls.get(stipulationId) ?? `[secure-upload:${stipulationId}]`)
}

function closingArtifactOrigin(): string {
  const configured = process.env.MCA_APP_ORIGIN?.replace(/\/$/, "")
  if (configured) return configured
  if (process.env.NODE_ENV === "production") throw new AppError(503, "artifact_origin_unconfigured", "Configure MCA_APP_ORIGIN before delivering contract attachments.")
  return "http://localhost:3000"
}

function issueClosingArtifactToken(document: { id: string; workspaceId: string; version: number }, now = Date.now()): { token: string; expiresAt: string } {
  const expiresAtMs = now + 5 * 60_000
  const payload = Buffer.from(JSON.stringify({ d: document.id, w: document.workspaceId, v: document.version, e: expiresAtMs })).toString("base64url")
  const signature = createHmac("sha256", closingTokenSecret("artifact")).update(payload).digest("base64url")
  return { token: `${payload}.${signature}`, expiresAt: new Date(expiresAtMs).toISOString() }
}

export async function redeemClosingArtifact(token: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }> {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) throw new AppError(404, "artifact_link_invalid", "This contract artifact link is invalid or expired.")
  const expected = Buffer.from(createHmac("sha256", closingTokenSecret("artifact")).update(payload).digest("base64url")), supplied = Buffer.from(signature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AppError(404, "artifact_link_invalid", "This contract artifact link is invalid or expired.")
  let data: { d?: string; w?: string; v?: number; e?: number }
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof data } catch { throw new AppError(404, "artifact_link_invalid", "This contract artifact link is invalid or expired.") }
  if (!data.d || !data.w || !data.v || !data.e || data.e < Date.now()) throw new AppError(404, "artifact_link_invalid", "This contract artifact link is invalid or expired.")
  const actor: DealActor = { workspaceId: data.w, userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: newId() }
  const result = await getDocumentContent(actor, data.d)
  if (result.document.version !== data.v) throw new AppError(404, "artifact_link_invalid", "This contract artifact link no longer matches its pinned version.")
  return { filename: result.document.displayFilename, mimeType: result.document.mimeType, bytes: result.bytes }
}

async function publicLink(token: string, lock = false, executor: DbExecutor = getDatabase()): Promise<Row> {
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
  const row = await executor.prepare<Row>(`SELECT l.*, s.label FROM mca_merchant_upload_links l LEFT JOIN mca_closing_stipulations s ON s.id=l.stipulation_id AND s.workspace_id=l.workspace_id WHERE l.token_hash=?${lock ? " FOR UPDATE OF l" : ""}`).get(hashOpaqueToken(token))
  if (!row || row.revoked_at || String(row.expires_at) <= nowIso() || Number(row.used_count) >= Number(row.max_uploads)) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
  return row
}

export async function merchantUploadBinding(token: string, allowConsumed = false): Promise<{ workspaceId: string; dealId: string; linkId: string; category: DocumentCategory }> {
  if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_merchant_upload_links WHERE token_hash=?").get(hashOpaqueToken(token))
  if (!row || row.revoked_at || String(row.expires_at) <= nowIso() || (!allowConsumed && Number(row.used_count) >= Number(row.max_uploads))) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
  return { workspaceId: String(row.workspace_id), dealId: String(row.deal_id), linkId: String(row.id), category: String(row.destination_category) as DocumentCategory }
}

export async function inspectMerchantUpload(token: string): Promise<{ requestLabel: string; destinationCategory: string; expiresAt: string; remainingUploads: number }> {
  const row = await publicLink(token)
  return { requestLabel: row.label ? String(row.label) : "Requested document", destinationCategory: String(row.destination_category), expiresAt: String(row.expires_at), remainingUploads: Number(row.max_uploads) - Number(row.used_count) }
}

export async function uploadMerchantDocument(token: string, input: { idempotencyKey: string; filename: string; mimeType: string; bytes: Uint8Array }): Promise<{ documentId: string; processingState: string; stipulationStatus: StipulationState }> {
  return withImmediateTransaction(async (database) => {
    if (!/^[A-Za-z0-9_-]{30,200}$/.test(token)) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
    const row = await database.prepare<Row>("SELECT l.*,s.status stipulation_status FROM mca_merchant_upload_links l LEFT JOIN mca_closing_stipulations s ON s.id=l.stipulation_id AND s.workspace_id=l.workspace_id WHERE l.token_hash=? FOR UPDATE OF l").get(hashOpaqueToken(token))
    if (!row || row.revoked_at || String(row.expires_at) <= nowIso()) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
    const storageKey = `merchant:${row.id}:${idempotency(input.idempotencyKey)}`
    const prior = await database.prepare<Row>("SELECT id,deal_id,category,processing_state FROM mca_documents WHERE workspace_id=? AND idempotency_key=?").get(row.workspace_id, storageKey)
    if (prior) {
      if (prior.deal_id !== row.deal_id || prior.category !== row.destination_category) throw new AppError(409, "idempotency_conflict", "That retry key already identifies another document.")
      const actor: DealActor = { workspaceId: String(row.workspace_id), userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: newId() }
      const state = documentRuntimeEnabled() && ["pending_scan", "scan_failed"].includes(String(prior.processing_state))
        ? (await retryDocumentScan(actor, String(prior.id))).processingState
        : String(prior.processing_state)
      return { documentId: String(prior.id), processingState: state, stipulationStatus: String(row.stipulation_status ?? "open") as StipulationState }
    }
    if (Number(row.used_count) >= Number(row.max_uploads)) throw new AppError(404, "upload_link_invalid", "This upload link is invalid or expired.")
    const now = nowIso()
    const actor: DealActor = { workspaceId: String(row.workspace_id), userId: null, membershipId: null, role: "admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId: newId() }
    const document = await storeDocument(actor, { dealId: String(row.deal_id), idempotencyKey: storageKey, filename: input.filename, mimeType: input.mimeType, bytes: input.bytes, category: String(row.destination_category) as DocumentCategory, source: "merchant_secure_upload", sourceReference: `stipulation:${row.stipulation_id ?? "auto"}` })
    const consumed = await database.prepare<Row>("UPDATE mca_merchant_upload_links SET used_count=used_count+1,updated_at=? WHERE id=? AND used_count<max_uploads RETURNING *").get(now, row.id)
    if (!consumed) throw new AppError(409, "upload_link_consumed", "This upload link has already been used.")
    let stipulationStatus: StipulationState = "open"
    if (row.stipulation_id) {
      const updated = await database.prepare<Row>(`UPDATE mca_closing_stipulations SET linked_document_id=?,status='received',received_at=?,updated_at=? WHERE workspace_id=? AND id=? AND status='open' RETURNING *`).get(document.id, now, now, row.workspace_id, row.stipulation_id)
      if (updated) stipulationStatus = "received"
      else {
        const current = await database.prepare<Row>("SELECT status FROM mca_closing_stipulations WHERE workspace_id=? AND id=?").get(row.workspace_id, row.stipulation_id)
        stipulationStatus = String(current?.status ?? "open") as StipulationState
      }
    }
    await recordAuditEvent({ context: actor, action: "closing.merchant_document_uploaded", resourceType: "merchant_upload_link", resourceId: String(row.id), metadata: { stipulationId: row.stipulation_id, documentId: document.id, category: document.category, processingState: document.processingState }, correlationId: actor.correlationId, executor: database })
    return { documentId: document.id, processingState: document.processingState, stipulationStatus }
  })
}

function requestPreview(row: Row, actor: DealActor): ClosingRequestPreview {
  const channel = String(row.channel) as "email" | "sms"
  return { id: String(row.id), dealId: String(row.deal_id), kind: String(row.kind) as ClosingRequestPreview["kind"], recordId: String(row.record_id), channel, senderId: row.sender_id ? String(row.sender_id) : undefined, recipientMasked: maskRecipient(decryptSensitive(String(row.recipient_cipher), actor.workspaceId), channel), subject: row.subject_cipher ? decryptSensitive(String(row.subject_cipher), actor.workspaceId) : undefined, body: decryptSensitive(String(row.body_cipher), actor.workspaceId), contentHash: String(row.content_hash), state: String(row.state) as ClosingRequestPreview["state"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }
}

async function persistRequestPreview(actor: DealActor, input: { dealId: string; kind: ClosingRequestPreview["kind"]; recordId: string; channel: "email" | "sms"; senderId?: string; recipient: string; subject?: string; body: string; attachmentRefs?: Array<{ id: string; version: number; checksum: string }>; idempotencyKey: string }): Promise<ClosingRequestPreview> {
  const attachmentRefs = input.attachmentRefs ?? []
  const key = idempotency(input.idempotencyKey), hash = contentHash({ kind: input.kind, recordId: input.recordId, channel: input.channel, senderId: input.senderId, recipient: input.recipient, subject: input.subject, body: input.body, attachmentRefs })
  const now = nowIso(), id = newId()
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_closing_previews
    (id,workspace_id,deal_id,kind,record_id,channel,sender_id,recipient_cipher,subject_cipher,body_cipher,content_hash,attachment_document_refs_json,state,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'preview',?,?,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, input.kind, input.recordId, input.channel, input.senderId ?? null, encryptSensitive(input.recipient, actor.workspaceId), input.subject ? encryptSensitive(input.subject, actor.workspaceId) : null, encryptSensitive(input.body, actor.workspaceId), hash, JSON.stringify(attachmentRefs), key, actor.userId, now, now)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_closing_previews WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
  if (!row || String(row.content_hash) !== hash) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different preview.")
  return requestPreview(row, actor)
}

async function attemptDelivery(actor: DealActor, input: { dealId: string; kind: string; recordId: string; attemptKey: string; channel: "email" | "sms" | "webhook"; recipient?: string; payloadHash: string; senderId?: string; sender?: { fromName: string; fromAddress: string }; subject?: string; body?: string; payload?: Record<string, unknown>; attachments?: Array<{ id: string; version: number; checksum: string; url: string; expiresAt: string; filename?: string; mimeType?: string; bytes?: Uint8Array }>; endpoint?: string; authorizationToken?: string }, transportOverride?: ClosingTransport): Promise<ClosingDelivery> {
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  const key = idempotency(input.attemptKey), now = nowIso(), id = newId(), correlationId = deliveryCorrelationId()
  await assertOutboundDispatch(actor.workspaceId, now)
  const transport = transportOverride ?? closingTransport()
  const reservation = await withImmediateTransaction(async (database) => {
    if (input.kind === "psf_request") {
      await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`${actor.workspaceId}:psf-provider:${input.recordId}`)
      const opposite = await database.prepare<Row>("SELECT id FROM mca_closing_deliveries WHERE workspace_id=? AND record_id=? AND kind='psf_docuseal' LIMIT 1").get(actor.workspaceId, input.recordId)
      if (opposite) throw new AppError(409, "psf_provider_conflict", "This PSF request is already reserved for DocuSeal.")
    }
    await database.prepare("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))").get(`${actor.workspaceId}:${input.kind}:${input.recordId}`)
    const sameKey = await database.prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND kind=? AND record_id=? AND attempt_key=?").get(actor.workspaceId, input.kind, input.recordId, key)
    if (sameKey) {
      if (String(sameKey.payload_hash) !== input.payloadHash) throw new AppError(409, "idempotency_conflict", "That retry key already identifies another delivery payload.")
      return { row: sameKey, send: false }
    }
    const fence = await database.prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND kind=? AND record_id=? AND (state IN ('pending','sent') OR error_code='provider_outcome_unknown') ORDER BY created_at DESC LIMIT 1").get(actor.workspaceId, input.kind, input.recordId)
    if (fence) {
      if (String(fence.payload_hash) !== input.payloadHash) throw new AppError(409, "delivery_content_conflict", "A delivery is already reserved for different immutable content.")
      return { row: fence, send: false }
    }
    const inserted = await database.prepare<Row>(`INSERT INTO mca_closing_deliveries
      (id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,NULL,NULL,NULL,?,?) RETURNING *`).get(id, actor.workspaceId, input.dealId, input.kind, input.recordId, key, input.channel, input.recipient ? encryptSensitive(input.recipient, actor.workspaceId) : null, input.payloadHash, correlationId, now, now)
    return { row: inserted!, send: true }
  })
  if (!reservation.send) {
    if (reservation.row.state === "sent") return delivery(reservation.row)
    if (!transport.reconcile || (reservation.row.state !== "pending" && reservation.row.error_code !== "provider_outcome_unknown")) return delivery(reservation.row)
    const reconciled = await transport.reconcile({ workspaceId: actor.workspaceId, kind: input.kind as "stipulation_request" | "contract_request" | "repricing_request" | "offer_message" | "psf_request", channel: input.channel, endpoint: input.endpoint, authorizationToken: input.authorizationToken, senderId: input.senderId, sender: input.sender, recipient: input.recipient ?? "configured-webhook", subject: input.subject, body: input.body, payload: input.payload, attachments: input.attachments, correlationId: String(reservation.row.correlation_id), recordId: input.recordId, attemptKey: String(reservation.row.attempt_key), payloadHash: input.payloadHash })
    const recovered = reconciled.state === "sent" && reconciled.externalId
      ? await getDatabase().prepare<Row>("UPDATE mca_closing_deliveries SET state='sent',external_id=?,error_code=NULL,error_message=NULL,updated_at=? WHERE workspace_id=? AND id=? RETURNING *").get(reconciled.externalId, nowIso(), actor.workspaceId, reservation.row.id)
      : await getDatabase().prepare<Row>("UPDATE mca_closing_deliveries SET state='blocked',error_code='provider_outcome_unknown',error_message='The provider outcome could not be reconciled. Check provider activity before retrying.',updated_at=? WHERE workspace_id=? AND id=? AND state<>'sent' RETURNING *").get(nowIso(), actor.workspaceId, reservation.row.id)
    if (!recovered) {
      const current = await getDatabase().prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND id=?").get(actor.workspaceId, reservation.row.id)
      return delivery(current!)
    }
    await recordAuditEvent({ context: actor, action: "closing.delivery_reconciled", resourceType: input.kind, resourceId: input.recordId, metadata: { channel: input.channel, state: recovered.state, payloadHash: input.payloadHash, externalIdPresent: Boolean(recovered.external_id) }, correlationId: String(reservation.row.correlation_id) })
    return delivery(recovered)
  }
  await (await import("../company-access")).assertCompanyOperational(actor.workspaceId)
  await assertOutboundDispatch(actor.workspaceId, now)
  const result = await transport.deliver({ workspaceId: actor.workspaceId, kind: input.kind as "stipulation_request" | "contract_request" | "repricing_request" | "offer_message" | "psf_request", channel: input.channel, endpoint: input.endpoint, authorizationToken: input.authorizationToken, senderId: input.senderId, sender: input.sender, recipient: input.recipient ?? "configured-webhook", subject: input.subject, body: input.body, payload: input.payload, attachments: input.attachments, correlationId, recordId: input.recordId, attemptKey: key, payloadHash: input.payloadHash })
  const updated = await getDatabase().prepare<Row>("UPDATE mca_closing_deliveries SET state=?,external_id=?,error_code=?,error_message=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *").get(result.state, result.externalId ?? null, result.errorCode ?? null, result.errorMessage ?? null, nowIso(), actor.workspaceId, reservation.row.id)
  await recordAuditEvent({ context: actor, action: "closing.delivery_attempted", resourceType: input.kind, resourceId: input.recordId, metadata: { channel: input.channel, state: result.state, errorCode: result.errorCode, payloadHash: input.payloadHash, externalIdPresent: Boolean(result.externalId) }, correlationId })
  return delivery(updated!)
}

export async function previewStipulationRequest(actor: DealActor, input: { dealId: string; stipulationIds: string[]; recipient?: string; overrideReason?: string; senderId?: string; channel?: "email" | "sms"; idempotencyKey: string; origin: string }): Promise<ClosingRequestPreview> {
  const deal = await getDealForDocument(actor, input.dealId), channel = input.channel ?? "email"
  const bound = channel === "email"
    ? bindMerchantEmail(deal, { recipient: input.recipient, overrideReason: input.overrideReason, dealId: input.dealId, kind: "stipulation_request" }, actor)
    : bindMerchantSms(deal, { recipient: input.recipient, overrideReason: input.overrideReason, dealId: input.dealId, kind: "stipulation_request" }, actor)
  await recordRecipientOverrideAudit(actor, bound, { dealId: input.dealId, kind: "stipulation_request" })
  if (!input.stipulationIds.length) throw new AppError(422, "stipulations_required", "Choose at least one open stipulation.")
  const rows = await getDatabase().prepare<Row>(`SELECT * FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? AND id = ANY(?) AND status='open' ORDER BY created_at`).all(actor.workspaceId, input.dealId, input.stipulationIds)
  if (rows.length !== new Set(input.stipulationIds).size) throw new AppError(422, "stipulations_invalid", "Each requested item must be an open stipulation on this deal.")
  const lines: string[] = []
  for (const row of rows) {
    lines.push(`• ${row.label}: [secure-upload:${row.id}]`)
  }
  const merchant = deal.dbaName || deal.legalName || "there"
  const subject = `Documents needed for ${deal.displayId}`
  const body = `Hello ${merchant},\n\nPlease upload the following requested documents using the secure, expiring links below:\n\n${lines.join("\n")}\n\nPlease contact your representative if a requested item is unavailable.`
  return persistRequestPreview(actor, { dealId: input.dealId, kind: "stipulation_request", recordId: String(rows[0].id), channel, senderId: input.senderId, recipient: bound.address, subject: channel === "email" ? subject : undefined, body, idempotencyKey: input.idempotencyKey })
}

export async function acceptOfferForClosing(actor: DealActor, input: { dealId: string; offerId?: string; revisionId?: string; idempotencyKey: string }): Promise<ContractWorkflow> {
  await getDealForDocument(actor, input.dealId)
  const offer = await resolveOffer(actor, input.dealId, input.offerId, input.revisionId)
  const key = idempotency(input.idempotencyKey), now = nowIso(), id = newId()
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_contract_workflows
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,funder_id,funder_name,state,recipient_cipher,attached_document_ids_json,outstanding_stips_json,accepted_at,contract_requested_at,contract_sent_at,signed_at,final_review_at,repricing_requested_at,signature_source,signature_external_id,signature_evidence_document_id,manual_signature_reason,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?, 'accepted',NULL,'[]','[]',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,?,?,?)
    ON CONFLICT (workspace_id,deal_id,offer_revision_id) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, offer.offerId, offer.revisionId, offer.revisionNumber, offer.funderId ?? null, offer.funderName, now, key, actor.userId, now, now)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND deal_id=? AND offer_revision_id=?").get(actor.workspaceId, input.dealId, offer.revisionId)
  if (!row) throw new Error("Contract workflow insert failed.")
  if (inserted) await recordAuditEvent({ context: actor, action: "closing.offer_accepted", resourceType: "contract_workflow", resourceId: id, metadata: { dealId: input.dealId, offerId: offer.offerId, offerRevisionId: offer.revisionId, revisionNumber: offer.revisionNumber }, correlationId: actor.correlationId })
  return contract(row, actor)
}

async function validatedClosingDocuments(actor: DealActor, dealId: string, documentIds: string[], exceptions: Record<string, string>): Promise<{ attachments: string[]; missing: string[] }> {
  const documents = await listSubmissionDocuments(actor, dealId), clean = new Map(documents.filter((item) => isDocumentReady(item.processingState)).map((item) => [item.id, item]))
  for (const id of documentIds) if (!clean.has(id)) throw new AppError(422, "attachment_invalid", "Every attachment must be a clean document from this deal.")
  const attachments = [...new Set(documentIds)]
  const missing: string[] = []
  for (const category of ["driver_license", "voided_check"] as const) {
    const has = attachments.some((id) => clean.get(id)?.category === category)
    if (!has && !exceptions[category]?.trim()) missing.push(category)
  }
  return { attachments, missing }
}

export async function previewContractAction(actor: DealActor, input: { workflowId: string; action: "request_contract" | "request_repricing"; recipient?: string; overrideReason?: string; senderId: string; attachedDocumentIds?: string[]; exceptions?: Record<string, string>; reason?: string; idempotencyKey: string }): Promise<{ workflow: ContractWorkflow; preview: ClosingRequestPreview }> {
  await assertSenderUsable(actor, input.senderId, "submission")
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=?").get(actor.workspaceId, input.workflowId)
  if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
  if (verifiedClosingFlowEnabled() && ["signed", "final_review"].includes(String(row.state))) throw new AppError(409, "contract_already_signed", "A signed contract cannot be requested or repriced again.")
  const deal = await getDealForDocument(actor, String(row.deal_id))
  const bound = await bindFunderEmail({ funderId: row.funder_id ? String(row.funder_id) : undefined, recipient: input.recipient, overrideReason: input.overrideReason, dealId: deal.id, resourceId: input.workflowId, kind: input.action }, actor)
  await recordRecipientOverrideAudit(actor, bound, { dealId: deal.id, resourceId: input.workflowId, kind: input.action === "request_contract" ? "contract_request" : "repricing_request" })
  const { attachments, missing } = await validatedClosingDocuments(actor, deal.id, input.attachedDocumentIds ?? [], input.exceptions ?? {})
  if (input.action === "request_contract" && missing.length) throw new AppError(422, "closing_documents_missing", "Attach a driver license and voided check, or record an explicit exception for each missing item.", Object.fromEntries(missing.map((item) => [item, ["Attach this document or enter an exception."]])))
  const openStips = await getDatabase().prepare<Row>("SELECT label FROM mca_closing_stipulations WHERE workspace_id=? AND deal_id=? AND status IN ('open','received') ORDER BY created_at").all(actor.workspaceId, deal.id)
  if (input.action === "request_repricing" && !input.reason?.trim()) throw new AppError(422, "repricing_reason_required", "Enter a reason before preparing a repricing request.")
  const kind = input.action === "request_contract" ? "contract_request" : "repricing_request", state = input.action === "request_contract" ? "contract_requested" : "repricing_requested", now = nowIso()
  const subject = input.action === "request_contract" ? `Contract request · ${deal.displayId}` : `Repricing request · ${deal.displayId}`
  const body = `${input.action === "request_contract" ? "Please prepare the contract" : "Please review the requested repricing"} for ${deal.legalName || deal.dbaName || deal.displayId}.\n\nOffer revision: ${row.offer_revision_number}\nFunder: ${row.funder_name}${input.action === "request_repricing" ? `\nReason: ${input.reason!.trim()}` : ""}\nAttachments: ${attachments.length}\nOutstanding stipulations: ${openStips.length ? openStips.map((item) => item.label).join(", ") : "None"}`
  const updated = await getDatabase().prepare<Row>(`UPDATE mca_contract_workflows SET state=?,recipient_cipher=?,attached_document_ids_json=?,outstanding_stips_json=?,${input.action === "request_contract" ? "contract_requested_at" : "repricing_requested_at"}=?,updated_at=? WHERE workspace_id=? AND id=?${verifiedClosingFlowEnabled() ? " AND state NOT IN ('signed','final_review')" : ""} RETURNING *`).get(state, encryptSensitive(bound.address, actor.workspaceId), JSON.stringify(attachments), JSON.stringify(openStips.map((item) => String(item.label))), now, now, actor.workspaceId, input.workflowId)
  if (!updated) throw new AppError(409, "contract_already_signed", "A signed contract cannot be requested or repriced again.")
  const documentMap = new Map((await listSubmissionDocuments(actor, deal.id)).map((item) => [item.id, item]))
  const attachmentRefs = attachments.map((id) => { const item = documentMap.get(id)!; return { id, version: item.version, checksum: item.checksum } })
  const preview = await persistRequestPreview(actor, { dealId: deal.id, kind, recordId: input.workflowId, channel: "email", senderId: input.senderId, recipient: bound.address, subject, body, attachmentRefs, idempotencyKey: input.idempotencyKey })
  return { workflow: await contract(updated!, actor), preview }
}

export async function sendRequestPreview(actor: DealActor, previewId: string, attemptKey: string): Promise<ClosingDelivery> {
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_closing_previews WHERE workspace_id=? AND id=?").get(actor.workspaceId, previewId)
  if (!row) throw new AppError(404, "closing_preview_not_found", "The request preview was not found.")
  await assertOutboundDispatch(actor.workspaceId, String(row.created_at))
  await getDealForDocument(actor, String(row.deal_id))
  const channel = String(row.channel) as "email" | "sms", senderId = row.sender_id ? String(row.sender_id) : undefined
  let emailSender: { fromName: string; fromAddress: string } | undefined
  if (channel === "email") {
    if (!senderId) throw new AppError(422, "sender_required", "Choose a sender before sending.")
    const sender = await assertSenderUsable(actor, senderId, String(row.kind) === "stipulation_request" ? "merchant" : "submission")
    emailSender = { fromName: sender.fromName, fromAddress: sender.fromAddress }
  }
  const recipient = decryptSensitive(String(row.recipient_cipher), actor.workspaceId), subject = row.subject_cipher ? decryptSensitive(String(row.subject_cipher), actor.workspaceId) : undefined, storedBody = decryptSensitive(String(row.body_cipher), actor.workspaceId)
  const attachmentRefs = json<Array<{ id: string; version: number; checksum: string }>>(row.attachment_document_refs_json, [])
  const pinnedHash = contentHash({ kind: row.kind, recordId: row.record_id, channel, senderId, recipient, subject, body: storedBody, attachmentRefs })
  if (pinnedHash !== row.content_hash) throw new AppError(409, "preview_integrity_failed", "The saved preview no longer matches its immutable content hash.")
  const body = String(row.kind) === "stipulation_request" ? await materializeSecureUploadBody(actor, String(row.id), storedBody, closingArtifactOrigin()) : storedBody
  const attachments = await Promise.all(attachmentRefs.map(async (ref) => {
    const current = await getDocument(actor, ref.id)
    if (current.version !== ref.version || current.checksum !== ref.checksum || !isDocumentReady(current.processingState)) throw new AppError(409, "attachment_changed", "A pinned contract attachment is no longer available in the validated version.")
    const content = await getDocumentContent(actor, ref.id)
    if (content.document.version !== ref.version || content.document.checksum !== ref.checksum) throw new AppError(409, "attachment_changed", "A pinned contract attachment is no longer available in the validated version.")
    const token = issueClosingArtifactToken(current)
    return { ...ref, url: `${closingArtifactOrigin()}/api/mca/closing/artifacts/${token.token}`, expiresAt: token.expiresAt, filename: content.document.displayFilename, mimeType: content.document.mimeType, bytes: content.bytes }
  }))
  const result = await withOutboundApproval(actor.workspaceId, String(row.created_at), () => attemptDelivery(actor, { dealId: String(row.deal_id), kind: String(row.kind), recordId: String(row.record_id), attemptKey, channel, recipient, payloadHash: pinnedHash, senderId, sender: emailSender, subject, body, attachments }))
  await getDatabase().prepare("UPDATE mca_closing_previews SET state=?,updated_at=? WHERE workspace_id=? AND id=?").run(result.state === "sent" ? "sent" : "failed", nowIso(), actor.workspaceId, previewId)
  if (result.state === "sent" && row.kind === "contract_request") await getDatabase().prepare("UPDATE mca_contract_workflows SET state='contract_sent',contract_sent_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='contract_requested'").run(nowIso(), nowIso(), actor.workspaceId, row.record_id)
  return result
}

export async function recordContractSignature(actor: DealActor, input: { workflowId: string; source: "external" | "manual"; externalId?: string; evidenceDocumentId?: string; manualReason?: string }): Promise<ContractWorkflow> {
  if (verifiedClosingFlowEnabled()) return withImmediateTransaction(async (database) => {
    const row = await database.prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, input.workflowId)
    if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
    await getDealForDocument(actor, String(row.deal_id))
    if (["signed", "final_review"].includes(String(row.state))) {
      if (row.signature_source === input.source && row.signature_external_id === (input.externalId?.trim() ?? null)
        && row.signature_evidence_document_id === (input.evidenceDocumentId ?? null)
        && row.manual_signature_reason === (input.manualReason?.trim() ?? null)) return contract(row, actor)
      throw new AppError(409, "signature_conflict", "A different signature decision has already been recorded.")
    }
    if (row.state !== "contract_sent") throw new AppError(409, "contract_not_sent", "Send the contract request before recording a signature.")
    if (input.source === "external") throw new AppError(503, "contract_signature_provider_unavailable", "No verified contract signature callback is connected. Use manual evidence review after provider setup.")
    const reason = required(input.manualReason, "manualReason", 500)
    const evidenceId = required(input.evidenceDocumentId, "evidenceDocumentId", 300)
    const evidence = await getDocument(actor, evidenceId)
    if (evidence.dealId !== row.deal_id || evidence.category !== "closing_document" || evidence.processingState !== "clean") throw new AppError(422, "signature_evidence_invalid", "Manual signature evidence must be a scan-clean closing document from this deal.")
    const now = nowIso()
    const updated = await database.prepare<Row>(`UPDATE mca_contract_workflows SET state='signed',signed_at=?,signature_source='manual',signature_external_id=NULL,signature_evidence_document_id=?,manual_signature_reason=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(now, evidenceId, reason, now, actor.workspaceId, input.workflowId)
    await recordAuditEvent({ context: actor, action: "closing.contract_signature_recorded", resourceType: "contract_workflow", resourceId: input.workflowId, metadata: { source: "manual", evidenceDocumentId: evidenceId }, correlationId: actor.correlationId, executor: database })
    return contract(updated!, actor)
  })
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=?").get(actor.workspaceId, input.workflowId)
  if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
  await getDealForDocument(actor, String(row.deal_id))
  if (input.source === "external") {
    required(input.externalId, "externalId", 300)
    required(input.evidenceDocumentId, "evidenceDocumentId", 300)
    const evidence = await getDocument(actor, input.evidenceDocumentId!)
    if (evidence.dealId !== row.deal_id || evidence.category !== "closing_document" || !isDocumentReady(evidence.processingState)) throw new AppError(422, "signature_evidence_invalid", "External signature evidence must be an available closing document from this deal.")
  } else required(input.manualReason, "manualReason", 500)
  const now = nowIso()
  const updated = await getDatabase().prepare<Row>(`UPDATE mca_contract_workflows SET state='signed',signed_at=?,signature_source=?,signature_external_id=?,signature_evidence_document_id=?,manual_signature_reason=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *`).get(now, input.source, input.source === "external" ? input.externalId!.trim() : null, input.evidenceDocumentId ?? null, input.source === "manual" ? input.manualReason!.trim() : null, now, actor.workspaceId, input.workflowId)
  await recordAuditEvent({ context: actor, action: "closing.contract_signature_recorded", resourceType: "contract_workflow", resourceId: input.workflowId, metadata: { source: input.source, externalIdPresent: Boolean(input.externalId), evidenceDocumentId: input.evidenceDocumentId }, correlationId: actor.correlationId })
  return contract(updated!, actor)
}

/**
 * Internal provider-completion entry point. Unlike the user-facing signature
 * mutation, this accepts external signatures only while the complete DocuSeal
 * verification gate is enabled. The evidence is re-read under the actor's
 * workspace before the state transition.
 */
export async function recordVerifiedExternalContractSignature(actor: DealActor, input: { workflowId: string; externalId: string; evidenceDocumentId: string }): Promise<ContractWorkflow> {
  if (!verifiedClosingFlowEnabled() || process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED !== "true" || process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED !== "true") {
    throw new AppError(503, "contract_signature_provider_unavailable", "No verified contract signature callback is connected. Use manual evidence review after provider setup.")
  }
  return withImmediateTransaction(async (database) => {
    const externalId = required(input.externalId, "externalId", 300)
    const evidenceId = required(input.evidenceDocumentId, "evidenceDocumentId", 300)
    const row = await database.prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, input.workflowId)
    if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
    await getDealForDocument(actor, String(row.deal_id))
    if (["signed", "final_review"].includes(String(row.state))) {
      if (row.signature_source === "external" && row.signature_external_id === externalId && row.signature_evidence_document_id === evidenceId) return contract(row, actor)
      throw new AppError(409, "signature_conflict", "A different signature decision has already been recorded.")
    }
    if (row.state !== "contract_sent") throw new AppError(409, "contract_not_sent", "Send the contract request before recording a signature.")
    const evidence = await getDocument(actor, evidenceId)
    if (evidence.dealId !== row.deal_id || evidence.category !== "closing_document" || evidence.processingState !== "clean") throw new AppError(422, "signature_evidence_invalid", "External signature evidence must be a scan-clean closing document from this deal.")
    const now = nowIso()
    const updated = await database.prepare<Row>(`UPDATE mca_contract_workflows SET state='signed',signed_at=?,signature_source='external',signature_external_id=?,signature_evidence_document_id=?,manual_signature_reason=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='contract_sent' RETURNING *`).get(now, externalId, evidenceId, now, actor.workspaceId, input.workflowId)
    if (!updated) throw new AppError(409, "contract_not_sent", "The contract state changed before the verified signature was recorded.")
    await recordAuditEvent({ context: actor, action: "closing.contract_signature_recorded", resourceType: "contract_workflow", resourceId: input.workflowId, metadata: { source: "external", externalIdPresent: true, evidenceDocumentId: evidenceId, verification: "docuseal_independent_fetch" }, correlationId: actor.correlationId, executor: database })
    return contract(updated, actor)
  })
}

export async function markContractFinalReview(actor: DealActor, workflowId: string): Promise<ContractWorkflow> {
  if (verifiedClosingFlowEnabled()) return withImmediateTransaction(async (database) => {
    const row = await database.prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=? FOR UPDATE").get(actor.workspaceId, workflowId)
    if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
    await getDealForDocument(actor, String(row.deal_id))
    if (row.state === "final_review") return contract(row, actor)
    if (row.state !== "signed" || !row.signed_at || !row.signature_source || !row.signature_evidence_document_id) throw new AppError(409, "signature_evidence_required", "A scan-clean signed document is required before final review.")
    const evidence = await getDocument(actor, String(row.signature_evidence_document_id))
    if (evidence.dealId !== row.deal_id || evidence.category !== "closing_document" || evidence.processingState !== "clean") throw new AppError(409, "signature_evidence_required", "The signed document must remain scan-clean before final review.")
    const now = nowIso()
    const updated = await database.prepare<Row>("UPDATE mca_contract_workflows SET state='final_review',final_review_at=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *").get(now, now, actor.workspaceId, workflowId)
    await recordAuditEvent({ context: actor, action: "closing.contract_final_review", resourceType: "contract_workflow", resourceId: workflowId, metadata: { evidenceDocumentId: row.signature_evidence_document_id }, correlationId: actor.correlationId, executor: database })
    return contract(updated!, actor)
  })
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=?").get(actor.workspaceId, workflowId)
  if (!row) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
  await getDealForDocument(actor, String(row.deal_id))
  if (row.state !== "signed" || !row.signed_at || !row.signature_source) throw new AppError(409, "signature_evidence_required", "Record signature evidence before final review.")
  const now = nowIso(), updated = await getDatabase().prepare<Row>("UPDATE mca_contract_workflows SET state='final_review',final_review_at=?,updated_at=? WHERE workspace_id=? AND id=? RETURNING *").get(now, now, actor.workspaceId, workflowId)
  return contract(updated!, actor)
}

function assertPsfAdmin(actor: DealActor): void {
  if (actor.source === "api_key" || (actor.role !== "admin" && actor.role !== "super_admin")) throw new AppError(403, "psf_configuration_denied", "Only workspace administrators can configure PSF delivery.")
}

function privateIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  const mapped = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized
  if (isIP(mapped) !== 4) return false
  const [a, b] = mapped.split(".").map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

async function safeWebhookUrl(value: string): Promise<string> {
  let url: URL
  try { url = new URL(value) } catch { throw new AppError(422, "psf_destination_invalid", "Enter a valid HTTPS webhook URL.") }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") throw new AppError(422, "psf_destination_invalid", "PSF delivery requires an HTTPS URL without embedded credentials or a nonstandard port.")
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const privateHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal" || (Boolean(isIP(host)) && privateIp(host))
  if (privateHost) throw new AppError(422, "psf_destination_private", "PSF delivery cannot target a private or loopback address.")
  let addresses: Array<{ address: string }>
  try { addresses = await lookup(host, { all: true, verbatim: true }) } catch { throw new AppError(422, "psf_destination_unresolvable", "The PSF destination host could not be resolved.") }
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) throw new AppError(422, "psf_destination_private", "The PSF destination resolves to a private or loopback address.")
  return url.toString()
}

type PsfConfigurationSummary = { enabled: boolean; visibleToReps: boolean; destinationConfigured: boolean; signingSecretConfigured: boolean; docuSealConfigured: boolean; provider: "docuseal" | "webhook" | null }

export async function getPsfConfiguration(actor: DealActor): Promise<PsfConfigurationSummary> {
  assertPsfAdmin(actor)
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_psf_config WHERE workspace_id=?").get(actor.workspaceId)
  const direct = docuSealPsfConnectionConfigured(actor.workspaceId), webhook = Boolean(row?.destination_cipher && row?.signing_secret_cipher)
  return { enabled: Number(row?.enabled) === 1, visibleToReps: Number(row?.visible_to_reps) === 1, destinationConfigured: Boolean(row?.destination_cipher), signingSecretConfigured: Boolean(row?.signing_secret_cipher), docuSealConfigured: direct, provider: direct ? "docuseal" : webhook ? "webhook" : null }
}

export async function updatePsfConfiguration(actor: DealActor, input: { enabled: boolean; visibleToReps: boolean; destination?: string; signingSecret?: string }): Promise<PsfConfigurationSummary> {
  assertPsfAdmin(actor)
  const existing = await getDatabase().prepare<Row>("SELECT * FROM mca_psf_config WHERE workspace_id=?").get(actor.workspaceId)
  const destinationCipher = input.destination?.trim() ? encryptSensitive(await safeWebhookUrl(input.destination.trim()), actor.workspaceId) : existing?.destination_cipher
  const suppliedSecret = input.signingSecret?.trim()
  if (suppliedSecret && suppliedSecret.length < 32) throw new AppError(422, "psf_signing_secret_invalid", "Use a PSF signing secret of at least 32 characters.")
  const secretCipher = suppliedSecret ? encryptSensitive(suppliedSecret, actor.workspaceId) : existing?.signing_secret_cipher
  const direct = docuSealPsfConnectionConfigured(actor.workspaceId)
  if (verifiedClosingFlowEnabled() && input.enabled && !direct) throw new AppError(503, "psf_signature_provider_unavailable", "Connect DocuSeal with an approved PSF template before enabling verified PSF delivery.")
  if (input.enabled && !direct && (!destinationCipher || !secretCipher)) throw new AppError(422, "psf_configuration_incomplete", "Connect DocuSeal or save an HTTPS destination and signing secret before enabling PSF delivery.")
  const now = nowIso()
  await getDatabase().prepare(`INSERT INTO mca_psf_config (workspace_id,enabled,visible_to_reps,destination_cipher,signing_secret_cipher,updated_by_user_id,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,visible_to_reps=EXCLUDED.visible_to_reps,destination_cipher=EXCLUDED.destination_cipher,signing_secret_cipher=EXCLUDED.signing_secret_cipher,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`).run(actor.workspaceId, input.enabled ? 1 : 0, input.visibleToReps ? 1 : 0, destinationCipher ?? null, secretCipher ?? null, actor.userId, now)
  await recordAuditEvent({ context: actor, action: "closing.psf_configuration_updated", resourceType: "workspace", resourceId: actor.workspaceId, metadata: { enabled: input.enabled, visibleToReps: input.visibleToReps, destinationConfigured: Boolean(destinationCipher), signingSecretConfigured: Boolean(secretCipher) }, correlationId: actor.correlationId })
  return { enabled: input.enabled, visibleToReps: input.visibleToReps, destinationConfigured: Boolean(destinationCipher), signingSecretConfigured: Boolean(secretCipher), docuSealConfigured: direct, provider: direct ? "docuseal" : destinationCipher && secretCipher ? "webhook" : null }
}

async function psfVisibilityForUse(actor: DealActor): Promise<Row | undefined> {
  if (actor.source === "api_key") throw new AppError(403, "psf_permission_denied", "PSF details require an interactive workspace session.")
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_psf_config WHERE workspace_id=?").get(actor.workspaceId)
  const permitted = actor.role === "admin" || actor.role === "super_admin" || (Number(row?.visible_to_reps) === 1 && (actor.role === "rep" || actor.role === "manager"))
  if (!permitted) throw new AppError(403, "psf_permission_denied", "PSF actions are not visible for your role in this workspace.")
  return row
}

async function psfConfigForUse(actor: DealActor): Promise<{ endpoint: string; secret: string }> {
  const row = await psfVisibilityForUse(actor)
  if (!row || Number(row.enabled) === 0 || !row.destination_cipher || !row.signing_secret_cipher) throw new AppError(503, "psf_delivery_unconfigured", "An administrator must enable PSF delivery with an HTTPS destination and signing secret.")
  return { endpoint: await safeWebhookUrl(decryptSensitive(String(row.destination_cipher), actor.workspaceId)), secret: decryptSensitive(String(row.signing_secret_cipher), actor.workspaceId) }
}

export async function confirmPsfRequest(actor: DealActor, input: { dealId: string; offerId?: string; revisionId?: string; amountCents: number; bankName: string; routingNumber: string; accountNumber: string; businessName: string; contactName: string; contactEmail?: string; overrideReason?: string; idempotencyKey: string; deliver?: boolean; attemptKey?: string }): Promise<{ request: PsfRequestSummary; delivery?: ClosingDelivery }> {
  await psfVisibilityForUse(actor)
  if (verifiedClosingFlowEnabled() && input.deliver && !docuSealPsfConnectionConfigured(actor.workspaceId)) throw new AppError(503, "psf_signature_provider_unavailable", "Connect DocuSeal with an approved PSF template before sending a verified PSF request.")
  const deal = await getDealForDocument(actor, input.dealId)
  const offer = await resolveOffer(actor, input.dealId, input.offerId, input.revisionId)
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new AppError(422, "amount_invalid", "Enter a positive amount in cents.")
  const routing = assertUsAbaRoutingNumber(input.routingNumber)
  const account = input.accountNumber.replace(/\s/g, "")
  if (!/^\d{4,17}$/.test(account)) throw new AppError(422, "account_number_invalid", "Enter a bank account number containing 4 to 17 digits.")
  const bound = bindMerchantEmail(deal, { recipient: input.contactEmail, overrideReason: input.overrideReason, dealId: input.dealId, kind: "psf_request" }, actor)
  await recordRecipientOverrideAudit(actor, bound, { dealId: input.dealId, kind: "psf_request" })
  const clearPayload = { schemaVersion: 1, requestType: "psf", dealId: input.dealId, offerId: offer.offerId, offerRevisionId: offer.revisionId, offerRevisionNumber: offer.revisionNumber, amountCents: input.amountCents, bankName: required(input.bankName, "bankName", 180), routingNumber: routing, accountNumber: account, businessName: required(input.businessName, "businessName", 220), contactName: required(input.contactName, "contactName", 180), contactEmail: bound.address }
  const hash = contentHash(clearPayload), key = idempotency(input.idempotencyKey), now = nowIso(), id = newId(), correlationId = deliveryCorrelationId()
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_psf_requests
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,amount_cents,bank_name_cipher,routing_number_cipher,account_number_cipher,business_name_cipher,contact_name_cipher,contact_email_cipher,payload_version,payload_hash,state,idempotency_key,correlation_id,external_request_id,last_error_code,last_error_message,delivered_at,signed_at,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,'pending',?,?,NULL,NULL,NULL,NULL,NULL,?,?,?) ON CONFLICT (workspace_id,deal_id,offer_revision_id) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, offer.offerId, offer.revisionId, offer.revisionNumber, input.amountCents, encryptSensitive(clearPayload.bankName, actor.workspaceId), encryptSensitive(routing, actor.workspaceId), encryptSensitive(account, actor.workspaceId), encryptSensitive(clearPayload.businessName, actor.workspaceId), encryptSensitive(clearPayload.contactName, actor.workspaceId), encryptSensitive(clearPayload.contactEmail, actor.workspaceId), hash, key, correlationId, actor.userId, now, now)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_psf_requests WHERE workspace_id=? AND deal_id=? AND offer_revision_id=?").get(actor.workspaceId, input.dealId, offer.revisionId)
  if (!row || String(row.payload_hash) !== hash) throw new AppError(409, "psf_revision_conflict", "This offer revision already has a different PSF request. Review the saved request instead of replacing bank details.")
  let attempt: ClosingDelivery | undefined
  if (input.deliver && (row.state === "pending" || row.state === "failed")) {
    const provider = await selectPsfDeliveryProvider(actor.workspaceId, String(row.id))
    if (provider === "docuseal") {
      await deliverPsfRequestWithDocuSeal(actor, String(row.id))
      const directAttempt = await getDatabase().prepare<Row>("SELECT * FROM mca_closing_deliveries WHERE workspace_id=? AND kind='psf_docuseal' AND record_id=? ORDER BY created_at DESC LIMIT 1").get(actor.workspaceId, row.id)
      if (directAttempt) attempt = delivery(directAttempt)
    } else {
      const config = await psfConfigForUse(actor)
      attempt = await withOutboundApproval(actor.workspaceId, String(row.created_at), () => attemptDelivery(actor, { dealId: input.dealId, kind: "psf_request", recordId: String(row.id), attemptKey: input.attemptKey ?? key, channel: "webhook", payloadHash: hash, payload: clearPayload, endpoint: config.endpoint, authorizationToken: config.secret }))
      if (attempt.state === "sent" && !attempt.externalId) {
        await getDatabase().prepare("UPDATE mca_closing_deliveries SET state='failed',error_code='provider_ack_missing',error_message='The PSF provider did not return an external request identity.',updated_at=? WHERE workspace_id=? AND id=?").run(nowIso(), actor.workspaceId, attempt.id)
        attempt = { ...attempt, state: "failed", errorCode: "provider_ack_missing", errorMessage: "The PSF provider did not return an external request identity." }
      }
      const delivered = attempt.state === "sent"
      await getDatabase().prepare("UPDATE mca_psf_requests SET state=?,external_request_id=?,last_error_code=?,last_error_message=?,delivered_at=?,updated_at=? WHERE workspace_id=? AND id=?").run(delivered ? "delivered" : "failed", delivered ? attempt.externalId : null, delivered ? null : attempt.errorCode ?? "delivery_failed", delivered ? null : attempt.errorMessage ?? "PSF delivery failed.", delivered ? nowIso() : null, nowIso(), actor.workspaceId, row.id)
    }
  }
  const current = await getDatabase().prepare<Row>("SELECT * FROM mca_psf_requests WHERE workspace_id=? AND id=?").get(actor.workspaceId, row.id)
  return { request: await psf(current!, actor), delivery: attempt }
}

export async function recordPsfWebhook(workspaceId: string, rawBody: string, signatureHeader: string | null): Promise<{ requestId: string; state: "signed" | "retained" }> {
  if (verifiedClosingFlowEnabled()) throw new AppError(503, "psf_signature_provider_unavailable", "Generic PSF callbacks cannot establish a verified signature. Connect DocuSeal and retain its signed documents and audit log.")
  const config = await getDatabase().prepare<Row>("SELECT * FROM mca_psf_config WHERE workspace_id=? AND enabled<>0").get(workspaceId)
  if (!config?.signing_secret_cipher) throw new AppError(404, "psf_webhook_unavailable", "PSF webhook processing is unavailable.")
  const [timestamp, supplied] = (signatureHeader ?? "").split(".", 2), epoch = Number(timestamp)
  if (!timestamp || !supplied || !Number.isFinite(epoch) || Math.abs(Date.now() - epoch * 1000) > 5 * 60_000) throw new AppError(401, "psf_signature_invalid", "PSF webhook signature is missing, malformed, or stale.")
  const secret = decryptSensitive(String(config.signing_secret_cipher), workspaceId), expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")
  const a = Buffer.from(expected), b = Buffer.from(supplied)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, "psf_signature_invalid", "PSF webhook signature is invalid.")
  let payload: { externalRequestId?: unknown; status?: unknown; evidenceId?: unknown }
  try { payload = JSON.parse(rawBody) as typeof payload } catch { throw new AppError(400, "invalid_json", "Webhook body must be valid JSON.") }
  if (payload.status !== "signed" || typeof payload.externalRequestId !== "string" || !payload.externalRequestId.trim()) throw new AppError(422, "psf_event_invalid", "A signed event with an external request identity is required.")
  const existing = await getDatabase().prepare<Row>(`SELECT r.* FROM mca_psf_requests r WHERE r.workspace_id=? AND r.external_request_id=?
    AND EXISTS (SELECT 1 FROM mca_closing_deliveries d WHERE d.workspace_id=r.workspace_id AND d.record_id=r.id AND d.kind='psf_request' AND d.state='sent' AND d.external_id=r.external_request_id)
    AND NOT EXISTS (SELECT 1 FROM mca_closing_deliveries d WHERE d.workspace_id=r.workspace_id AND d.record_id=r.id AND d.kind='psf_docuseal')`).get(workspaceId, payload.externalRequestId.trim())
  if (!existing || !["delivered", "signed"].includes(String(existing.state))) throw new AppError(404, "psf_request_not_found", "No delivered PSF request matches this external identity.")
  if (existing.state === "signed") return { requestId: String(existing.id), state: "signed" }
  if (await (await import("../paused-receipts")).retainReceiptIfPaused({ workspaceId, kind: "psf_completion", resourceId: String(existing.id), payload })) return { requestId: String(existing.id), state: "retained" }
  const now = nowIso(), row = await getDatabase().prepare<Row>("UPDATE mca_psf_requests SET state='signed',signed_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='delivered' RETURNING *").get(now, now, workspaceId, existing.id)
  if (!row) throw new AppError(409, "psf_state_conflict", "The PSF request state changed while processing this event.")
  await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "closing.psf_signed", resourceType: "psf_request", resourceId: String(row.id), metadata: { externalRequestIdPresent: true, evidenceId: typeof payload.evidenceId === "string" ? payload.evidenceId.slice(0, 300) : undefined }, correlationId: newId() })
  return { requestId: String(row.id), state: "signed" }
}

export function recordPsfDocuSealWebhook(workspaceId: string, rawBody: string | Uint8Array, signatureHeader: string | null) {
  return processDocuSealPsfWebhook(workspaceId, rawBody, signatureHeader)
}

function money(cents: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100) }
function renderOfferLine(offer: OfferRevisionForClosing): string {
  return [offer.funderName, money(offer.amountCents), offer.factorRate ? `factor ${offer.factorRate.toFixed(3)}` : undefined, offer.termMonths ? `${offer.termMonths} months` : undefined, offer.paymentAmountCents && offer.paymentFrequency ? `${money(offer.paymentAmountCents)} ${offer.paymentFrequency}` : undefined].filter(Boolean).join(" · ")
}

export async function previewMerchantOffers(actor: DealActor, input: { dealId: string; selectionMode: "selected" | "all" | "highest"; revisionId?: string; channel: "email" | "sms"; senderId?: string; recipient?: string; overrideReason?: string; idempotencyKey: string }): Promise<OfferMessagePreview> {
  const deal = await getDealForDocument(actor, input.dealId)
  let senderId = input.senderId
  const bound = input.channel === "email"
    ? bindMerchantEmail(deal, { recipient: input.recipient, overrideReason: input.overrideReason, dealId: input.dealId, kind: "offer_message" }, actor)
    : bindMerchantSms(deal, { recipient: input.recipient, overrideReason: input.overrideReason, dealId: input.dealId, kind: "offer_message" }, actor)
  await recordRecipientOverrideAudit(actor, bound, { dealId: input.dealId, kind: "offer_message" })
  const recipient = bound.address
  if (input.channel === "email") {
    if (!senderId) throw new AppError(422, "sender_required", "Choose a verified merchant sender.")
    await assertSenderUsable(actor, senderId, "merchant")
  } else {
    const consent = await getSmsConsent(actor, input.dealId, recipient, { matchDealContact: !bound.overridden })
    if (consent.state !== "opted_in") throw new AppError(409, consent.state === "opted_out" ? "sms_recipient_opted_out" : "sms_consent_required", consent.state === "opted_out" ? "This merchant opted out of text messages." : "Record merchant SMS consent before preparing a text preview.")
    const route = await resolveSmsRoute(actor, { dealId: input.dealId, senderAccountId: senderId })
    if (!route.providerConfigured) throw new AppError(503, "sms_provider_unconfigured", "The assigned text messaging account is not ready. Ask an administrator to finish its provider setup in Settings.")
    senderId = route.accountId
  }
  let offers = await listOfferRevisionsForClosing(actor, { dealId: input.dealId })
  const at = nowIso()
  if (input.selectionMode === "selected") {
    offers = offers.filter((offer) => offer.state === "active" || (offer.state === "superseded" && offer.selected))
    if (input.revisionId) offers = offers.filter((offer) => offer.revisionId === input.revisionId)
    offers = offers.filter((offer) => offer.selected)
  } else {
    offers = offers.filter((offer) => isOfferRevisionOpenForMerchantPreview(offer, at))
    if (input.selectionMode === "highest" && offers.length) offers = [pickHighestMerchantOffer(offers)]
  }
  if (!offers.length) throw new AppError(422, "offer_preview_empty", "No eligible offer revisions match this preview mode.")
  if (input.selectionMode === "selected") for (const offer of offers) assertOfferRevisionEligibleForClosing(offer)
  else for (const offer of offers) assertOfferRevisionValidity(offer, at)
  const subject = input.channel === "email" ? `Funding options for ${deal.dbaName || deal.legalName || deal.displayId}` : undefined
  const body = `Hello ${deal.contactName || "there"},\n\nHere ${offers.length === 1 ? "is your funding option" : "are your funding options"}:\n\n${offers.map((offer) => `• ${renderOfferLine(offer)}`).join("\n")}\n\nReply to your representative with questions or to discuss next steps.`
  const primary = offers[0], revisionIds = offers.map((offer) => offer.revisionId), hash = contentHash({ selectionMode: input.selectionMode, revisionIds, channel: input.channel, senderId, recipient, subject, body })
  const key = idempotency(input.idempotencyKey), now = nowIso(), id = newId()
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_offer_message_previews
    (id,workspace_id,deal_id,offer_id,offer_revision_id,offer_revision_number,offer_revision_ids_json,selection_mode,channel,sender_id,recipient_cipher,subject_cipher,body_cipher,content_hash,state,idempotency_key,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preview',?,?,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, primary.offerId, primary.revisionId, primary.revisionNumber, JSON.stringify(revisionIds), input.selectionMode, input.channel, senderId ?? null, encryptSensitive(recipient, actor.workspaceId), subject ? encryptSensitive(subject, actor.workspaceId) : null, encryptSensitive(body, actor.workspaceId), hash, key, actor.userId, now, now)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_offer_message_previews WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
  if (!row || String(row.content_hash) !== hash) throw new AppError(409, "idempotency_conflict", "That retry key already identifies a different merchant preview.")
  return message(row, actor)
}

export async function sendMerchantOfferPreview(actor: DealActor, previewId: string, attemptKey: string, smsTransport?: TwilioSmsTransport): Promise<{ preview: OfferMessagePreview; delivery: ClosingDelivery; pitched: boolean }> {
  const row = await getDatabase().prepare<Row>("SELECT * FROM mca_offer_message_previews WHERE workspace_id=? AND id=?").get(actor.workspaceId, previewId)
  if (!row) throw new AppError(404, "offer_preview_not_found", "The merchant offer preview was not found.")
  await assertOutboundDispatch(actor.workspaceId, String(row.created_at))
  await getDealForDocument(actor, String(row.deal_id))
  const channel = String(row.channel) as "email" | "sms", senderId = row.sender_id ? String(row.sender_id) : undefined
  let emailSender: { fromName: string; fromAddress: string } | undefined
  if (channel === "email") {
    if (!senderId) throw new AppError(422, "sender_required", "Choose a verified merchant sender.")
    const sender = await assertSenderUsable(actor, senderId, "merchant")
    emailSender = { fromName: sender.fromName, fromAddress: sender.fromAddress }
  } else {
    if (!senderId) throw new AppError(409, "sms_route_unpinned", "Create a new text preview after choosing an assigned text messaging account.")
    const route = await resolveSmsRoute(actor, { dealId: String(row.deal_id), senderAccountId: senderId })
    if (!route.providerConfigured) throw new AppError(503, "sms_provider_unconfigured", "The pinned text messaging account is not ready. Ask an administrator to review it in Settings.")
  }
  const recipient = decryptSensitive(String(row.recipient_cipher), actor.workspaceId), subject = row.subject_cipher ? decryptSensitive(String(row.subject_cipher), actor.workspaceId) : undefined, body = decryptSensitive(String(row.body_cipher), actor.workspaceId), revisionIds = json<string[]>(row.offer_revision_ids_json, [String(row.offer_revision_id)])
  const hash = contentHash({ selectionMode: row.selection_mode, revisionIds, channel, senderId, recipient, subject, body })
  if (hash !== row.content_hash) throw new AppError(409, "preview_integrity_failed", "The saved preview no longer matches its immutable content hash.")
  const sent = await withOutboundApproval(actor.workspaceId, String(row.created_at), () => attemptDelivery(actor, { dealId: String(row.deal_id), kind: "offer_message", recordId: previewId, attemptKey, channel, recipient, payloadHash: hash, senderId, sender: emailSender, subject, body }, channel === "sms" ? createMerchantOfferSmsTransport(actor, String(row.deal_id), smsTransport) : undefined))
  const state = sent.state === "sent" ? "sent" : "failed", now = nowIso()
  await getDatabase().prepare("UPDATE mca_offer_message_previews SET state=?,updated_at=? WHERE workspace_id=? AND id=?").run(state, now, actor.workspaceId, previewId)
  let pitched = false
  if (sent.state === "sent") {
    for (const revisionId of revisionIds) {
      const revision = await getOfferRevisionForClosing(actor, { dealId: String(row.deal_id), revisionId })
      await getDatabase().prepare(`INSERT INTO mca_pitch_events (id,workspace_id,deal_id,offer_id,offer_revision_id,message_preview_id,channel,transport_succeeded,notes,idempotency_key,actor_user_id,pitched_at)
        VALUES (?,?,?,?,?,?,?,1,NULL,?,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING`).run(newId(), actor.workspaceId, row.deal_id, revision.offerId, revisionId, previewId, channel, `delivery:${sent.id}:${revisionId}`, actor.userId, now)
    }
    pitched = true
  }
  const current = await getDatabase().prepare<Row>("SELECT * FROM mca_offer_message_previews WHERE workspace_id=? AND id=?").get(actor.workspaceId, previewId)
  return { preview: await message(current!, actor), delivery: sent, pitched }
}

export async function recordPhonePitch(actor: DealActor, input: { dealId: string; offerId?: string; revisionId?: string; notes?: string; idempotencyKey: string }): Promise<{ id: string; offerRevisionId: string; pitchedAt: string }> {
  await getDealForDocument(actor, input.dealId)
  const offer = await resolveOffer(actor, input.dealId, input.offerId, input.revisionId), key = idempotency(input.idempotencyKey), id = newId(), now = nowIso()
  const inserted = await getDatabase().prepare<Row>(`INSERT INTO mca_pitch_events (id,workspace_id,deal_id,offer_id,offer_revision_id,message_preview_id,channel,transport_succeeded,notes,idempotency_key,actor_user_id,pitched_at)
    VALUES (?,?,?,?,?,NULL,'phone',0,?,?,?,?) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING *`).get(id, actor.workspaceId, input.dealId, offer.offerId, offer.revisionId, input.notes?.trim().slice(0, 1000) ?? null, key, actor.userId, now)
  const row = inserted ?? await getDatabase().prepare<Row>("SELECT * FROM mca_pitch_events WHERE workspace_id=? AND idempotency_key=?").get(actor.workspaceId, key)
  if (!row || String(row.offer_revision_id) !== offer.revisionId || String(row.channel) !== "phone") throw new AppError(409, "idempotency_conflict", "That retry key already identifies another pitch event.")
  return { id: String(row.id), offerRevisionId: String(row.offer_revision_id), pitchedAt: String(row.pitched_at) }
}

export async function requestRenewalDocuments(actor: DealActor, input: { dealId: string; sourceAdvanceId: string; idempotencyKey: string; documentCategories?: Array<"statement" | "voided_check"> }): Promise<StipulationTask[]> {
  const categories = [...new Set(input.documentCategories?.length ? input.documentCategories : ["statement", "voided_check"])]
  const labels: Record<string, string> = { statement: "Current bank statements for renewal", voided_check: "Current voided check for renewal" }
  return Promise.all(categories.map((documentCategory) => createStipulation(actor, {
    dealId: input.dealId,
    documentCategory,
    label: labels[documentCategory],
    idempotencyKey: `renewal:${contentHash({ sourceAdvanceId: required(input.sourceAdvanceId, "sourceAdvanceId", 160), key: idempotency(input.idempotencyKey), documentCategory })}`,
  })))
}
