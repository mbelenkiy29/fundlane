import "server-only"

import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { AppError } from "../errors"
import { getDatabase, newId, recordAuditEvent, withImmediateTransaction } from "../db"
import { actorForDeals, createDeal, getDeal, transitionDeal } from "../deals/service"
import type { DealTransactionCheckpoint } from "../deals/repository"
import { allowedTransitions } from "../deals/pipeline"
import type { DealActor, DealDetail, DealStatus } from "../deals/schema"
import type { AuthContext } from "../types"
import type { DocumentCategory, DocumentSummary } from "../documents/contracts"
import { storeDocument } from "../documents/service"
import { captureIntakeAnswers, sanitizeIntakeAnswers } from "./providers"
import type { IntakeResult, NormalizedIntakeInput } from "./contracts"
import {
  claimAttachmentJob,
  completeAttachmentJob,
  dueAttachmentJobs,
  findIntake,
  getIntegration,
  listAttachmentJobs,
  listIntakes,
  reserveIntake,
  updateAttachmentJob,
  updateIntake,
  upsertAttachmentJob,
  type AttachmentJob,
  type IntegrationRecord,
} from "./repository"

type LookupAll = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export function intakePayloadChecksum(input: NormalizedIntakeInput): string {
  return createHash("sha256").update(canonical({
    schemaVersion: input.schemaVersion,
    provider: input.provider,
    eventId: input.eventId,
    application: input.application,
    sourceReference: input.sourceReference,
    initialStatus: input.initialStatus,
  })).digest("hex")
}

function validateInput(input: NormalizedIntakeInput): void {
  const fieldErrors: Record<string, string[]> = {}
  if (input.schemaVersion !== 1) fieldErrors.schemaVersion = ["Only intake schema version 1 is supported."]
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(input.provider)) fieldErrors.provider = ["Use a stable lowercase provider key."]
  if (!input.eventId?.trim() || input.eventId.length > 200) fieldErrors.eventId = ["Provide a provider event ID of at most 200 characters."]
  if (!input.application || typeof input.application !== "object" || Array.isArray(input.application)) {
    fieldErrors.application = ["Provide an application object."]
  }
  if (input.answers !== undefined && (!Array.isArray(input.answers) || input.answers.some(answer => !answer || typeof answer.key !== "string" || typeof answer.label !== "string" || typeof answer.value !== "string"))) fieldErrors.answers = ["Provide question keys, labels, and answer values as strings."]
  if (input.sourceReference && input.sourceReference.length > 500) fieldErrors.sourceReference = ["Source references are limited to 500 characters."]
  if (Object.keys(fieldErrors).length) throw new AppError(422, "intake_validation_failed", "Review the intake fields.", fieldErrors)
}

function pathToStatus(from: DealStatus, to: DealStatus): DealStatus[] | undefined {
  if (from === to) return []
  const pending: Array<{ status: DealStatus; path: DealStatus[] }> = [{ status: from, path: [] }]
  const seen = new Set<DealStatus>([from])
  while (pending.length) {
    const item = pending.shift()!
    for (const next of allowedTransitions(item.status)) {
      if (seen.has(next)) continue
      const path = [...item.path, next]
      if (next === to) return path
      seen.add(next)
      pending.push({ status: next, path })
    }
  }
  return undefined
}

async function applyInitialStatus(actor: DealActor, deal: DealDetail, target: DealStatus | undefined): Promise<{ deal: DealDetail; warning?: string }> {
  if (!target || target === deal.status) return { deal }
  if (!["lead", "new_application", "missing_documents"].includes(target)) {
    return { deal, warning: `Configured intake status ${target} requires workflow review and was not applied automatically.` }
  }
  const path = pathToStatus(deal.status, target)
  if (!path) return { deal, warning: `The requested initial status ${target} is not reachable from ${deal.status}.` }
  let current = deal
  try {
    for (const status of path) {
      current = (await transitionDeal(actor, current.id, { status, expectedVersion: current.version, reason: "Configured intake initial status" })).deal
    }
    return { deal: current }
  } catch (error) {
    const message = error instanceof AppError ? error.message : "The configured initial status could not be applied."
    return { deal: current, warning: message }
  }
}

export async function ingestApplication(actor: DealActor, input: NormalizedIntakeInput, checkpoint?: DealTransactionCheckpoint, integrationId?: string): Promise<IntakeResult> {
  validateInput(input)
  input = { ...input, answers: input.answers ? sanitizeIntakeAnswers(input.answers) : ["native", "fundlane", "jotform", "highlevel", "zoho", "custom", "fillout", "docuseal"].includes(input.provider) ? captureIntakeAnswers(input.application) : undefined }
  const checksum = intakePayloadChecksum(input)
  const reserved = await reserveIntake(actor.workspaceId, input, checksum, integrationId)
  if (reserved.record.payloadChecksum !== checksum) {
    throw new AppError(409, "intake_event_conflict", "This provider event ID was already used for a different application.")
  }
  if (reserved.record.dealId && ["created", "file_pending"].includes(reserved.record.state)) {
    await getDeal(actor, reserved.record.dealId)
    await (await import("./notifications")).syncApplicationNotifications(actor.workspaceId, reserved.record.intakeId)
    return {
      intakeId: reserved.record.intakeId,
      dealId: reserved.record.dealId,
      created: false,
      state: reserved.record.state,
      warnings: reserved.record.warnings,
    }
  }

  await updateIntake({ workspaceId: actor.workspaceId, intakeId: reserved.record.intakeId, state: "validated" })
  try {
    const created = await createDeal(actor, {
      ...input.application,
      idempotencyKey: `intake:${createHash("sha256").update(integrationId ? `${integrationId}\0${input.provider}\0${input.eventId}` : `${input.provider}\0${input.eventId}`).digest("hex")}`,
      fieldSource: input.application.fieldSource ?? "api",
    }, checkpoint)
    const status = await applyInitialStatus(actor, created.deal, input.initialStatus)
    const warnings = status.warning ? [status.warning] : []
    const final = await updateIntake({
      workspaceId: actor.workspaceId,
      intakeId: reserved.record.intakeId,
      state: "created",
      dealId: status.deal.id,
      warnings,
    })
    await (await import("./notifications")).syncApplicationNotifications(actor.workspaceId, final.intakeId)
    await recordAuditEvent({
      context: actor,
      action: "intake.created",
      resourceType: "intake",
      resourceId: final.intakeId,
      metadata: { provider: input.provider, dealId: status.deal.id, state: final.state },
      correlationId: actor.correlationId,
    })
    return { intakeId: final.intakeId, dealId: status.deal.id, created: created.created, state: final.state, warnings }
  } catch (error) {
    await updateIntake({
      workspaceId: actor.workspaceId,
      intakeId: reserved.record.intakeId,
      state: "error",
      errorCode: error instanceof AppError ? error.code : "deal_creation_failed",
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Deal creation failed.",
    })
    throw error
  }
}

export async function replayIntake(actor: DealActor, intakeId: string, appOrigin?: string): Promise<IntakeResult> {
  const record = await findIntake(actor.workspaceId, intakeId)
  if (!record) throw new AppError(404, "intake_not_found", "The intake record was not found.")
  if (record.dealId) await getDeal(actor, record.dealId)
  if (record.provider === "email") {
    if (!appOrigin) throw new AppError(422, "email_origin_required", "The application origin is required for email replay.")
    const { replayEmailIntake } = await import("./email")
    return await replayEmailIntake(actor, intakeId, { appOrigin }) as IntakeResult
  }
  return ingestApplication(actor, {
    schemaVersion: 1,
    provider: record.provider,
    eventId: record.eventId,
    application: record.application,
    answers: record.answers,
    sourceReference: record.sourceReference,
    initialStatus: record.initialStatus,
  }, undefined, record.eventNamespace)
}

export interface IntakeListItem {
  intakeId: string
  provider: string
  eventId: string
  sourceReference?: string
  dealId: string | null
  state: IntakeResult["state"]
  warnings: string[]
  errorCode?: string
  errorMessage?: string
  attachmentStates: Record<string, number>
  merchantName: string
  requestedAmount?: number
  assignedReps: string[]
  receivedAt: string
  automaticProcessing: boolean
  canRetry: boolean
  progress?: import("./processing-contracts").IntakeProgress
  updatedAt: string
}

export async function listIntakeSummaries(actor: DealActor): Promise<IntakeListItem[]> {
  const output: IntakeListItem[] = []
  const members = await getDatabase().prepare<{ id: string; name: string }>("SELECT m.id,u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=?").all(actor.workspaceId)
  for (const record of await listIntakes(actor.workspaceId)) {
    let deal: DealDetail | undefined
    if (record.dealId) {
      try { deal = await getDeal(actor, record.dealId) } catch { continue }
    } else if (actor.role !== "admin" && actor.role !== "super_admin") continue
    const jobs = await listAttachmentJobs(actor.workspaceId, record.intakeId)
    const integration = record.integrationId ? await getIntegration(actor.workspaceId, record.integrationId) : undefined
    const progress = await (await import("./processing")).intakeProgress(actor.workspaceId, record.intakeId)
    output.push({
      merchantName: deal?.legalName ?? record.application.legalName ?? "Application needs review",
      requestedAmount: deal?.requestedAmount ?? record.application.requestedAmount,
      assignedReps: (deal?.assignments ?? []).map(a => members.find(m => m.id === a.membershipId)?.name ?? "Former team member"),
      receivedAt: record.createdAt, automaticProcessing: Boolean(integration?.automaticProcessing), progress,
      canRetry: Boolean(deal && integration?.enabled && integration.automaticProcessing && (actor.source !== "api_key" || actor.scopes?.includes("deals:write"))),
      intakeId: record.intakeId, provider: record.provider, eventId: record.eventId,
      sourceReference: record.sourceReference, dealId: record.dealId, state: record.state,
      warnings: record.warnings, errorCode: record.errorCode, errorMessage: record.errorMessage,
      attachmentStates: jobs.reduce<Record<string, number>>((counts, job) => {
        counts[job.state] = (counts[job.state] ?? 0) + 1; return counts
      }, {}),
      updatedAt: record.updatedAt,
    })
  }
  return output
}

async function recomputeIntakeReadiness(workspaceId: string, intakeId: string): Promise<IntakeResult> {
  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM intake_events WHERE id = ? AND workspace_id = ? FOR UPDATE").get(intakeId, workspaceId)
    const record = await findIntake(workspaceId, intakeId)
    if (!record) throw new AppError(404, "intake_not_found", "The intake record was not found.")
    const jobs = await listAttachmentJobs(workspaceId, intakeId)
    const unresolved = jobs.filter((job) => job.state !== "stored")
    const warnings = record.warnings.filter((warning) => !warning.startsWith("Attachments pending:"))
    if (unresolved.length) warnings.push(`Attachments pending: ${unresolved.length}.`)
    const next = await updateIntake({
      workspaceId,
      intakeId,
      state: unresolved.length ? "file_pending" : record.dealId ? "created" : record.state,
      warnings,
    })
    return { intakeId: next.intakeId, dealId: next.dealId, created: false, state: next.state, warnings: next.warnings }
  })
}

export async function attachIntakeDocument(
  actor: DealActor,
  input: {
    intakeId: string
    attachmentId: string
    filename: string
    mimeType: string
    bytes: Uint8Array
    category: DocumentCategory
  },
  options: { deferJobCompletion?: boolean } = {},
): Promise<DocumentSummary> {
  const intake = await findIntake(actor.workspaceId, input.intakeId)
  if (!intake?.dealId) throw new AppError(404, "intake_not_found", "The intake record was not found or does not have a deal yet.")
  await getDeal(actor, intake.dealId)
  const summary = await storeDocument(actor, {
    dealId: intake.dealId,
    idempotencyKey: `intake-attachment:${createHash("sha256").update(`${input.intakeId}\0${input.attachmentId}`).digest("hex")}`,
    filename: input.filename,
    mimeType: input.mimeType,
    bytes: input.bytes,
    category: input.category,
    source: "intake",
    sourceReference: `${intake.provider}:${input.attachmentId}`,
  })
  const job = (await listAttachmentJobs(actor.workspaceId, input.intakeId)).find((item) => item.attachmentId === input.attachmentId)
  if (job && !options.deferJobCompletion) await updateAttachmentJob(actor.workspaceId, job.id, { state: "stored", documentId: summary.id, lastError: undefined })
  await recomputeIntakeReadiness(actor.workspaceId, input.intakeId)
  await recordAuditEvent({
    context: actor,
    action: "intake.document_attached",
    resourceType: "intake",
    resourceId: input.intakeId,
    metadata: { attachmentId: input.attachmentId, documentId: summary.id },
    correlationId: actor.correlationId,
  })
  return summary
}

export async function scheduleAttachment(input: {
  actor: DealActor
  intakeId: string
  attachmentId: string
  sourceUrl: string
  filename: string
  mimeType: string
  category: DocumentCategory
}): Promise<AttachmentJob> {
  const intake = await findIntake(input.actor.workspaceId, input.intakeId)
  if (!intake?.dealId) throw new AppError(404, "intake_not_found", "Create the intake deal before scheduling attachments.")
  const job = await upsertAttachmentJob({
    workspaceId: input.actor.workspaceId, intakeId: input.intakeId, attachmentId: input.attachmentId,
    sourceUrl: input.sourceUrl, filename: input.filename, mimeType: input.mimeType, category: input.category,
  })
  await recomputeIntakeReadiness(input.actor.workspaceId, input.intakeId)
  return job
}

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address
  if (isIP(mapped) !== 4) return false
  const [a, b] = mapped.split(".").map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

async function assertSafeAttachmentUrl(rawUrl: string, integration: IntegrationRecord, lookupImpl: LookupAll = lookup): Promise<URL> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new AppError(422, "attachment_url_invalid", "Attachment URL is invalid.") }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AppError(422, "attachment_url_denied", "Attachment URLs must use HTTPS without embedded credentials.")
  }
  const allowed = new Set(integration.allowedHosts.map((host) => host.toLowerCase()))
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new AppError(422, "attachment_host_denied", "The attachment host is not on this integration's allowlist.")
  }
  if (isIP(url.hostname) && isPrivateIp(url.hostname)) throw new AppError(422, "attachment_address_denied", "Private attachment addresses are not allowed.")
  const addresses = await lookupImpl(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new AppError(422, "attachment_address_denied", "The attachment host resolves to a private or unavailable address.")
  }
  return url
}

function providerHeaders(integration: IntegrationRecord): HeadersInit {
  const credential = integration.credential
  if (!credential) throw new AppError(503, "provider_unavailable", `${integration.displayName} needs a private read credential.`)
  if (integration.credentialExpiresAt && integration.credentialExpiresAt <= new Date().toISOString()) {
    throw new AppError(503, "provider_credential_expired", `${integration.displayName} credential expired. Rotate it and retry the attachment.`)
  }
  switch (integration.provider) {
    case "jotform": return { APIKEY: credential }
    case "docuseal": return { "X-Auth-Token": credential }
    case "zoho": return { Authorization: `Bearer ${credential}` }
    default: return { Authorization: `Bearer ${credential}` }
  }
}

export async function fetchPrivateAttachment(
  job: AttachmentJob,
  integration: IntegrationRecord,
  options: { maxBytes?: number; timeoutMs?: number; fetchImpl?: typeof fetch; lookupImpl?: LookupAll } = {},
): Promise<Uint8Array> {
  if (!job.sourceUrl) throw new AppError(422, "attachment_url_missing", "The attachment does not have a retrieval URL.")
  const url = await assertSafeAttachmentUrl(job.sourceUrl, integration, options.lookupImpl)
  if (integration.provider === "zoho" && url.hostname !== "www.googleapis.com") {
    throw new AppError(422, "attachment_host_denied", "Zoho Drive credentials may be sent only to the Google Drive download host.")
  }
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: providerHeaders(integration), redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000), cache: "no-store",
  })
  if (response.status >= 300 && response.status < 400) throw new AppError(502, "attachment_redirect_denied", "Attachment redirects are not followed. Add the final host and URL explicitly.")
  if (response.status === 401 || response.status === 403) throw new AppError(503, "provider_credential_rejected", "The provider rejected the private attachment credential. Rotate it and retry.")
  if (!response.ok || !response.body) throw new AppError(502, "attachment_fetch_failed", `The provider returned HTTP ${response.status}.`)
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > maxBytes) throw new AppError(413, "attachment_too_large", "Attachment exceeds the configured size limit.")
  const chunks: Uint8Array[] = []; let received = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel()
      throw new AppError(413, "attachment_too_large", "Attachment exceeds the configured size limit.")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(received); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

async function actorForIntegration(integration: IntegrationRecord): Promise<DealActor> {
  const context: AuthContext = {
    authType: "api_key", userId: null, membershipId: null, workspaceId: integration.workspaceId,
    role: null, scopes: ["intake:write"], sessionId: null,
  }
  return { ...await actorForDeals(context), correlationId: newId() }
}

export async function processAttachmentJob(job: AttachmentJob, options: { fetchImpl?: typeof fetch; lookupImpl?: LookupAll } = {}): Promise<AttachmentJob> {
  const claim = await claimAttachmentJob(job.workspaceId, job.id)
  if (!claim.acquired || !claim.job.leaseToken) return claim.job
  const claimed = claim.job
  const leaseToken = claimed.leaseToken!
  const intake = await findIntake(claimed.workspaceId, claimed.intakeId)
  if (!intake?.integrationId) return (await completeAttachmentJob(claimed.workspaceId, claimed.id, leaseToken, { state: "failed", lastError: "No integration is associated with this attachment." })).job
  const integration = await getIntegration(job.workspaceId, intake.integrationId, true)
  if (!integration || !integration.enabled) return (await completeAttachmentJob(claimed.workspaceId, claimed.id, leaseToken, { state: "failed", lastError: "Integration is disabled or missing." })).job
  try {
    const bytes = await fetchPrivateAttachment(claimed, integration, { fetchImpl: options.fetchImpl, lookupImpl: options.lookupImpl })
    const live = await getIntegration(job.workspaceId, integration.id)
    if (!live?.enabled || live.approvalState !== "approved" || live.credentialVersion !== integration.credentialVersion) throw new AppError(403, "integration_changed", "The connection changed during file retrieval. Retry with its current settings.")
    const document = await attachIntakeDocument(await actorForIntegration(integration), {
      intakeId: claimed.intakeId, attachmentId: claimed.attachmentId, filename: claimed.filename,
      mimeType: claimed.mimeType, bytes, category: claimed.category as DocumentCategory,
    }, { deferJobCompletion: true })
    const completed = await completeAttachmentJob(claimed.workspaceId, claimed.id, leaseToken, { state: "stored", documentId: document.id })
    await recomputeIntakeReadiness(claimed.workspaceId, claimed.intakeId)
    return completed.job
  } catch (error) {
    const attempts = claimed.attemptCount
    const final = attempts >= 5
    const delay = Math.min(60, 2 ** attempts) * 60_000
    const message = error instanceof Error ? error.message.slice(0, 500) : "Attachment retrieval failed."
    const failed = (await completeAttachmentJob(claimed.workspaceId, claimed.id, leaseToken, {
      state: final ? "failed" : "retryable", nextAttemptAt: final ? undefined : new Date(Date.now() + delay).toISOString(), lastError: message,
    })).job
    await recomputeIntakeReadiness(claimed.workspaceId, claimed.intakeId)
    return failed
  }
}

export async function runDueAttachmentJobs(limit = 25, workspaceId?: string): Promise<AttachmentJob[]> {
  const results: AttachmentJob[] = []
  for (const job of await dueAttachmentJobs(limit, workspaceId)) results.push(await processAttachmentJob(job))
  return results
}
