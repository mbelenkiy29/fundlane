import "server-only"

import { createHash } from "node:crypto"
import { getDatabase, newId, nowIso, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { assertCompanyOperational } from "../company-access"
import { isDocumentReady, type DocumentSummary } from "../documents/contracts"
import { storeDocument } from "../documents/service"
import { createDocuSealContractSubmission, DOCUSEAL_CONTRACT_FIELD_KEYS, fetchDocuSealArtifact, verifyDocuSealCompletedWebhook, type DocuSealContractProviderConfig, type DocuSealProviderConfig, type DocuSealProviderDependencies } from "./docuseal-provider"
import { recordVerifiedExternalContractSignature } from "./service"
import { verifiedClosingFlowEnabled } from "./verified-flow"

interface Binding { submissionId: string; workflowId: string; offerRevisionId?: string }
interface Connection { workspaceId: string; webhookSecret: string; bindings: Binding[]; apiBaseUrl?: string; apiKey?: string; templateId?: number; signerRole?: string; fieldMap?: DocuSealContractProviderConfig["fieldMap"]; artifactAllowedHosts?: string[] }

export function contractDocuSealEnabled(): boolean {
  return verifiedClosingFlowEnabled() && process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_ENABLED === "true"
}

export function contractDocuSealSendEnabled(): boolean {
  return contractDocuSealEnabled() && process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_SEND_ENABLED === "true"
}

export function contractDocuSealVerificationEnabled(): boolean {
  return contractDocuSealEnabled() && process.env.MCA_CLOSING_DOCUSEAL_CONTRACT_VERIFY_ENABLED === "true"
}

function invalid(): never {
  throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal contract connections are invalid.")
}

function required(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 300
}

export function parseContractDocuSealConnections(raw = process.env.MCA_DOCUSEAL_CONTRACT_CONNECTIONS_JSON ?? "[]"): Connection[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) as unknown } catch { return invalid() }
  if (!Array.isArray(parsed)) return invalid()
  const workspaces = new Set<string>()
  const submissions = new Set<string>()
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
    const entry = value as Record<string, unknown>
    const allowed = new Set(["workspaceId", "webhookSecret", "bindings", "apiBaseUrl", "apiKey", "templateId", "signerRole", "fieldMap", "artifactAllowedHosts"])
    if (Object.keys(entry).some((key) => !allowed.has(key)) || !required(entry.workspaceId) || !required(entry.webhookSecret) || entry.webhookSecret.length < 32 || entry.webhookSecret.length > 500 || !Array.isArray(entry.bindings) || workspaces.has(entry.workspaceId)) return invalid()
    workspaces.add(entry.workspaceId)
    const bindings = entry.bindings.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return invalid()
      const binding = item as Record<string, unknown>
      if (Object.keys(binding).some((key) => !["submissionId", "workflowId", "offerRevisionId"].includes(key)) || !required(binding.submissionId) || !/^\d+$/.test(binding.submissionId) || !required(binding.workflowId) || submissions.has(binding.submissionId)) return invalid()
      submissions.add(binding.submissionId)
      if (binding.offerRevisionId === undefined) return { submissionId: binding.submissionId, workflowId: binding.workflowId }
      if (!required(binding.offerRevisionId)) return invalid()
      return { submissionId: binding.submissionId, workflowId: binding.workflowId, offerRevisionId: binding.offerRevisionId }
    })
    const hasApi = entry.apiBaseUrl !== undefined || entry.apiKey !== undefined || entry.artifactAllowedHosts !== undefined
      || entry.templateId !== undefined || entry.signerRole !== undefined || entry.fieldMap !== undefined
    let apiBaseUrl: string | undefined, apiKey: string | undefined, artifactAllowedHosts: string[] | undefined
    if (hasApi) {
      if (!required(entry.apiBaseUrl) || !required(entry.apiKey) || entry.apiKey.length > 500) return invalid()
      let api: URL
      try { api = new URL(entry.apiBaseUrl) } catch { return invalid() }
      if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash || entry.apiBaseUrl.includes("?") || entry.apiBaseUrl.includes("#")) return invalid()
      apiBaseUrl = api.toString().replace(/\/$/, "")
      apiKey = entry.apiKey
      if (entry.artifactAllowedHosts !== undefined) {
        if (!Array.isArray(entry.artifactAllowedHosts) || !entry.artifactAllowedHosts.length || entry.artifactAllowedHosts.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith("."))) return invalid()
        artifactAllowedHosts = [...new Set(entry.artifactAllowedHosts)]
      } else artifactAllowedHosts = [api.hostname]
    }
    const hasSend = entry.templateId !== undefined || entry.signerRole !== undefined || entry.fieldMap !== undefined
    let send: Partial<Pick<Connection, "templateId" | "signerRole" | "fieldMap">> = {}
    if (hasSend) {
      if (!Number.isSafeInteger(entry.templateId) || Number(entry.templateId) <= 0 || !required(entry.signerRole) || !entry.fieldMap || typeof entry.fieldMap !== "object" || Array.isArray(entry.fieldMap)) return invalid()
      const map = entry.fieldMap as Record<string, unknown>
      if (Object.keys(map).length !== DOCUSEAL_CONTRACT_FIELD_KEYS.length || DOCUSEAL_CONTRACT_FIELD_KEYS.some((key) => !required(map[key])) || new Set(Object.values(map)).size !== DOCUSEAL_CONTRACT_FIELD_KEYS.length) return invalid()
      send = { templateId: Number(entry.templateId), signerRole: entry.signerRole, fieldMap: map as unknown as DocuSealContractProviderConfig["fieldMap"] }
    }
    return { workspaceId: entry.workspaceId, webhookSecret: entry.webhookSecret, bindings, ...(apiBaseUrl ? { apiBaseUrl, apiKey, artifactAllowedHosts } : {}), ...send }
  })
}

export type ContractDocuSealSendResult = { state: "sent"; submissionId: string; replayed: boolean } | { state: "delivery_uncertain"; replayed: boolean }

export async function sendContractWithDocuSeal(actor: DealActor, workflowId: string, dependencies: { connectionJson?: string; provider?: DocuSealProviderDependencies } = {}): Promise<ContractDocuSealSendResult> {
  if (!contractDocuSealSendEnabled()) throw new AppError(404, "not_found", "Not found.")
  const connection = parseContractDocuSealConnections(dependencies.connectionJson).find((item) => item.workspaceId === actor.workspaceId)
  if (!connection?.apiBaseUrl || !connection.apiKey || !connection.templateId || !connection.signerRole || !connection.fieldMap) throw new AppError(503, "docuseal_unconfigured", "DocuSeal contract sending is not configured for this workspace.")
  const database = getDatabase()
  const workflow = await database.prepare<Record<string, string | number | null>>("SELECT * FROM mca_contract_workflows WHERE workspace_id=? AND id=?").get(actor.workspaceId, workflowId)
  if (!workflow) throw new AppError(404, "contract_workflow_not_found", "The contract workflow was not found.")
  const deal = await getDealForDocument(actor, String(workflow.deal_id))
  const revision = await database.prepare<{ amount_cents: number | null; factor_rate_millionths: number | null; payment_frequency: string | null }>("SELECT amount_cents,factor_rate_millionths,payment_frequency FROM mca_offer_revisions WHERE workspace_id=? AND id=? AND offer_id=?").get(actor.workspaceId, workflow.offer_revision_id, workflow.offer_id)
  if (!revision?.amount_cents || !revision.factor_rate_millionths || !revision.payment_frequency || !deal.legalName || !deal.contactName || !deal.contactEmail) throw new AppError(422, "contract_data_incomplete", "Complete the merchant signer and offer terms before sending the contract.")
  const payloadHash = createHash("sha256").update(JSON.stringify([workflow.offer_revision_id, deal.legalName, deal.contactName, deal.contactEmail, workflow.funder_name, revision])).digest("hex")
  const now = nowIso(), reservationId = newId()
  const inserted = await database.prepare<{ id: string }>(`INSERT INTO mca_closing_deliveries(id,workspace_id,deal_id,kind,record_id,attempt_key,channel,state,recipient_cipher,payload_hash,correlation_id,external_id,error_code,error_message,created_at,updated_at)
    VALUES(?,?,?,'contract_docuseal',?,?,'webhook','pending',NULL,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(workspace_id,kind,record_id,attempt_key) DO NOTHING RETURNING id`).get(reservationId, actor.workspaceId, workflow.deal_id, workflowId, workflow.offer_revision_id, payloadHash, actor.correlationId, now, now)
  const existing = await database.prepare<{ id: string; state: string; external_id: string | null; payload_hash: string }>("SELECT id,state,external_id,payload_hash FROM mca_closing_deliveries WHERE workspace_id=? AND kind='contract_docuseal' AND record_id=? AND attempt_key=?").get(actor.workspaceId, workflowId, workflow.offer_revision_id)
  if (!existing || existing.payload_hash !== payloadHash) throw new AppError(409, "contract_delivery_conflict", "This offer revision is already bound to different contract data.")
  if (!inserted) return existing.state === "sent" && existing.external_id ? { state: "sent", submissionId: existing.external_id, replayed: true } : { state: "delivery_uncertain", replayed: true }
  if (workflow.state !== "contract_requested") {
    await database.prepare("UPDATE mca_closing_deliveries SET state='failed',error_code='contract_state_invalid',error_message='Contract must be requested before sending.',updated_at=? WHERE id=?").run(nowIso(), reservationId)
    throw new AppError(409, "contract_not_requested", "Request the contract before sending it for signature.")
  }
  await assertCompanyOperational(actor.workspaceId)
  try {
    const result = await createDocuSealContractSubmission({ apiBaseUrl: connection.apiBaseUrl, apiKey: connection.apiKey, templateId: connection.templateId, signerRole: connection.signerRole, fieldMap: connection.fieldMap }, {
      externalId: `contract:${actor.workspaceId}:${workflow.offer_revision_id}`, workspaceId: actor.workspaceId, workflowId, offerRevisionId: String(workflow.offer_revision_id), merchantLegalName: deal.legalName,
      signerEmail: deal.contactEmail, signerName: deal.contactName, funderName: String(workflow.funder_name), fundedAmountCents: revision.amount_cents,
      paybackAmountCents: Math.round(revision.amount_cents * revision.factor_rate_millionths / 1_000_000), factorRate: revision.factor_rate_millionths / 1_000_000, paymentFrequency: revision.payment_frequency,
    }, dependencies.provider)
    const changed = await database.prepare("UPDATE mca_contract_workflows SET state='contract_sent',contract_sent_at=?,updated_at=? WHERE workspace_id=? AND id=? AND state='contract_requested' RETURNING id").get(nowIso(), nowIso(), actor.workspaceId, workflowId)
    if (!changed) throw new AppError(409, "contract_state_changed", "The contract workflow changed while the submission was being created; reconcile it manually.")
    await database.prepare("UPDATE mca_closing_deliveries SET state='sent',external_id=?,updated_at=? WHERE id=?").run(result.submissionId, nowIso(), reservationId)
    await recordAuditEvent({ context: actor, action: "closing.contract_docuseal_sent", resourceType: "contract_workflow", resourceId: workflowId, metadata: { offerRevisionId: workflow.offer_revision_id, submissionId: result.submissionId }, correlationId: actor.correlationId })
    return { state: "sent", submissionId: result.submissionId, replayed: false }
  } catch (error) {
    await database.prepare("UPDATE mca_closing_deliveries SET state='blocked',error_code='docuseal_outcome_unknown',error_message='DocuSeal delivery requires manual reconciliation before retrying.',updated_at=? WHERE id=? AND state='pending'").run(nowIso(), reservationId)
    if (error instanceof AppError && error.code !== "docuseal_outcome_unknown") throw error
    return { state: "delivery_uncertain", replayed: false }
  }
}

type Submission = { id?: unknown; status?: unknown; completed_at?: unknown; submitters?: unknown; documents?: unknown; audit_log_url?: unknown }
export interface ContractVerificationDependencies {
  fetchImpl?: typeof fetch
  provider?: DocuSealProviderDependencies
  storeDocument?: (actor: DealActor, input: Parameters<typeof storeDocument>[1]) => Promise<DocumentSummary>
  recordSignature?: typeof recordVerifiedExternalContractSignature
  audit?: typeof recordAuditEvent
}

function systemActor(workspaceId: string, correlationId: string): DealActor {
  return { workspaceId, userId: null, membershipId: null, role: "super_admin", managedMembershipIds: [], activeMembershipIds: [], source: "system", correlationId }
}

async function fetchSubmission(connection: Connection, submissionId: string, fetchImpl: typeof fetch): Promise<Submission> {
  const response = await fetchImpl(`${connection.apiBaseUrl}/submissions/${encodeURIComponent(submissionId)}`, { headers: { "X-Auth-Token": connection.apiKey! } })
  if (!response.ok) throw new AppError(502, "docuseal_request_failed", "DocuSeal submission verification failed.")
  return await response.json() as Submission
}

async function resolveBinding(connection: Connection, submissionId: string): Promise<Binding | undefined> {
  const staticBinding = connection.bindings.find((item) => item.submissionId === submissionId)
  const stored = await getDatabase().prepare<{ record_id: string; attempt_key: string }>("SELECT record_id,attempt_key FROM mca_closing_deliveries WHERE workspace_id=? AND kind='contract_docuseal' AND state='sent' AND external_id=?").get(connection.workspaceId, submissionId)
  if (staticBinding && stored && (staticBinding.workflowId !== stored.record_id || (staticBinding.offerRevisionId && staticBinding.offerRevisionId !== stored.attempt_key))) throw new AppError(409, "docuseal_contract_binding_invalid", "Static and stored DocuSeal contract bindings conflict.")
  return staticBinding ?? (stored ? { submissionId, workflowId: stored.record_id, offerRevisionId: stored.attempt_key } : undefined)
}

/** Bounded, idempotent completion processor; safe for a webhook or existing job consumer. */
export async function verifyContractDocuSealCompletion(workspaceId: string, submissionId: string, dependencies: ContractVerificationDependencies = {}): Promise<{ state: "signed"; replayed: boolean; evidenceDocumentId: string }> {
  if (!contractDocuSealVerificationEnabled()) throw new AppError(503, "contract_signature_provider_unavailable", "Verified DocuSeal contract processing is disabled.")
  const connection = parseContractDocuSealConnections().find((item) => item.workspaceId === workspaceId)
  if (!connection?.apiBaseUrl || !connection.apiKey || !connection.artifactAllowedHosts) throw new AppError(503, "docuseal_configuration_invalid", "DocuSeal contract API verification is not configured for this workspace.")
  const binding = await resolveBinding(connection, submissionId)
  if (!binding) throw new AppError(409, "docuseal_contract_binding_invalid", "DocuSeal contract binding does not match this submission.")
  const database = getDatabase()
  const receipt = await database.prepare<{ metadata: string }>("SELECT metadata FROM audit_events WHERE workspace_id=? AND action='contract.docuseal_completion_received' AND resource_id=? ORDER BY created_at DESC LIMIT 1").get(workspaceId, binding.workflowId)
  if (!receipt) throw new AppError(409, "docuseal_contract_receipt_missing", "An authenticated DocuSeal completion receipt is required.")
  let receiptSubmission: unknown
  try { receiptSubmission = (JSON.parse(receipt.metadata) as { submissionId?: unknown }).submissionId } catch { /* rejected below */ }
  if (receiptSubmission !== submissionId) throw new AppError(409, "docuseal_submission_binding_invalid", "The stored receipt does not match this submission.")
  const workflow = await database.prepare<{ deal_id: string; offer_revision_id: string; state: string; signature_external_id: string | null; signature_evidence_document_id: string | null }>("SELECT deal_id,offer_revision_id,state,signature_external_id,signature_evidence_document_id FROM mca_contract_workflows WHERE workspace_id=? AND id=?").get(workspaceId, binding.workflowId)
  if (!workflow || (binding.offerRevisionId && binding.offerRevisionId !== workflow.offer_revision_id)) throw new AppError(409, "docuseal_contract_binding_invalid", "DocuSeal contract binding does not match this workspace workflow.")
  if (["signed", "final_review"].includes(workflow.state) && workflow.signature_external_id === submissionId && workflow.signature_evidence_document_id) return { state: "signed", replayed: true, evidenceDocumentId: workflow.signature_evidence_document_id }
  if (workflow.state !== "contract_sent") throw new AppError(409, "contract_not_sent", "The bound contract is not awaiting a signature.")
  const actor = systemActor(workspaceId, `docuseal-contract:${submissionId}`)
  try {
    const submission = await fetchSubmission(connection, submissionId, dependencies.fetchImpl ?? fetch)
    if (String(submission.id) !== submissionId) throw new AppError(409, "docuseal_submission_binding_invalid", "DocuSeal returned a different submission.")
    if (submission.status !== "completed" || !Array.isArray(submission.submitters) || !submission.submitters.length || submission.submitters.some((item) => !item || typeof item !== "object" || (item as { status?: unknown }).status !== "completed")) throw new AppError(409, "docuseal_submission_incomplete", "Not every DocuSeal submitter completed the contract.")
    const documents = Array.isArray(submission.documents) ? submission.documents as Array<{ name?: unknown; url?: unknown }> : []
    if (!documents.length || documents.some((document) => typeof document.url !== "string") || typeof submission.audit_log_url !== "string") throw new AppError(502, "docuseal_artifact_missing", "DocuSeal completed without required signed and audit evidence.")
    const fieldBindings = Object.fromEntries(["amount", "bankName", "routingNumber", "accountNumber", "businessName", "contactName", "contactEmail"].map((key) => [key, { name: `unused_${key}`, type: "text" }])) as DocuSealProviderConfig["fieldBindings"]
    const providerConfig = { apiBaseUrl: connection.apiBaseUrl, apiToken: connection.apiKey, webhookSecret: connection.webhookSecret, templateId: 1, signerRole: "contract", fieldBindings, sendEmail: false, requireEmail2fa: false, artifactAllowedHosts: connection.artifactAllowedHosts }
    const save = dependencies.storeDocument ?? storeDocument
    const persist = async (url: string, filename: string, kind: "signed" | "audit", index = 0) => {
      const artifact = await fetchDocuSealArtifact(providerConfig, url, dependencies.provider)
      return save(actor, { dealId: workflow.deal_id, idempotencyKey: `docuseal-contract:${binding.workflowId}:${submissionId}:${kind}:${index}`, filename, mimeType: artifact.mimeType, bytes: artifact.bytes, category: "closing_document", source: kind === "signed" ? "docuseal_signed_contract" : "docuseal_audit_log", sourceReference: `docuseal-contract:${submissionId}:${kind}:${index}` })
    }
    const signedDocuments = await Promise.all(documents.map((document, index) => persist(document.url as string, typeof document.name === "string" ? document.name : `signed-contract-${index + 1}.pdf`, "signed", index)))
    const audit = await persist(submission.audit_log_url, "docuseal-audit-log.pdf", "audit")
    if (signedDocuments.some((document) => !isDocumentReady(document.processingState)) || !isDocumentReady(audit.processingState)) throw new AppError(423, "docuseal_artifact_not_clean", "DocuSeal contract evidence must be scan-clean before signing.")
    await (dependencies.recordSignature ?? recordVerifiedExternalContractSignature)(actor, { workflowId: binding.workflowId, externalId: submissionId, evidenceDocumentId: signedDocuments[0].id })
    await (dependencies.audit ?? recordAuditEvent)({ context: actor, action: "contract.docuseal_signature_verified", resourceType: "mca_contract_workflow", resourceId: binding.workflowId, metadata: { submissionId, evidenceDocumentId: signedDocuments[0].id, signedDocumentIds: signedDocuments.map((document) => document.id), auditDocumentId: audit.id, evidenceScanState: "clean" }, correlationId: actor.correlationId })
    return { state: "signed", replayed: false, evidenceDocumentId: signedDocuments[0].id }
  } catch (error) {
    await (dependencies.audit ?? recordAuditEvent)({ context: actor, action: "contract.docuseal_verification_failed", resourceType: "mca_contract_workflow", resourceId: binding.workflowId, metadata: { submissionId, errorCode: error instanceof AppError ? error.code : "docuseal_verification_failed" }, correlationId: actor.correlationId })
    throw error
  }
}

export async function recordContractDocuSealWebhook(workspaceId: string, rawBody: string, signature: string | null): Promise<{ state: "ignored" } | { state: "received"; replayed: boolean }> {
  const connection = parseContractDocuSealConnections().find((item) => item.workspaceId === workspaceId)
  if (!connection) throw new AppError(503, "docuseal_unconfigured", "DocuSeal contract callback is not configured for this workspace.")
  const completed = verifyDocuSealCompletedWebhook(rawBody, signature, connection.webhookSecret)
  const database = getDatabase()
  const binding = await resolveBinding(connection, completed.submissionId)
  if (!binding) return { state: "ignored" }
  const id = createHash("sha256").update(JSON.stringify(["docuseal_contract_receipt", workspaceId, completed.submissionId])).digest("hex")
  const assertReplay = async (): Promise<{ state: "received"; replayed: true } | null> => {
    const existing = await database.prepare<{ workspace_id: string; action: string; resource_id: string; metadata: string }>("SELECT workspace_id,action,resource_id,metadata FROM audit_events WHERE id=?").get(id)
    if (!existing) return null
    let prior: { workflowId?: unknown; submissionId?: unknown; offerRevisionId?: unknown } = {}
    try { prior = (JSON.parse(existing.metadata) as typeof prior | null) ?? {} } catch { /* conflict below */ }
    if (existing.workspace_id !== workspaceId || existing.action !== "contract.docuseal_completion_received" || existing.resource_id !== binding.workflowId || prior.workflowId !== binding.workflowId || prior.submissionId !== completed.submissionId || (binding.offerRevisionId !== undefined && prior.offerRevisionId !== binding.offerRevisionId)) {
      throw new AppError(409, "docuseal_contract_receipt_conflict", "DocuSeal contract receipt binding conflicts with the stored receipt.")
    }
    return { state: "received", replayed: true }
  }
  // A duplicate delivery of an already-recorded completion is acknowledged as a replay even if the
  // workflow has since moved past contract_sent, so DocuSeal stops retrying.
  const replay = await assertReplay()
  if (replay) return replay
  const workflow = await database.prepare<{ offer_revision_id: string }>("SELECT offer_revision_id FROM mca_contract_workflows WHERE workspace_id=? AND id=? AND state='contract_sent'").get(workspaceId, binding.workflowId)
  if (!workflow || (binding.offerRevisionId && workflow.offer_revision_id !== binding.offerRevisionId)) throw new AppError(409, "docuseal_contract_binding_invalid", "DocuSeal contract binding does not match a sent contract.")
  const metadata = { workflowId: binding.workflowId, submissionId: completed.submissionId, offerRevisionId: workflow.offer_revision_id, bodyHash: createHash("sha256").update(rawBody).digest("hex") }
  const inserted = await database.prepare(`INSERT INTO audit_events(id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES(?,?,NULL,'system','contract.docuseal_completion_received','mca_contract_workflow',?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`)
    .get(id, workspaceId, binding.workflowId, JSON.stringify(metadata), id, nowIso())
  if (inserted) return { state: "received", replayed: false }
  const raced = await assertReplay()
  if (raced) return raced
  throw new AppError(409, "docuseal_contract_receipt_conflict", "DocuSeal contract receipt binding conflicts with the stored receipt.")
}
