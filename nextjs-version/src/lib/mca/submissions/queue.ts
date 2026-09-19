import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { newId, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DocumentSummary } from "../documents/contracts"
import { listDocuments } from "../documents/service"
import { AppError } from "../errors"
import { listFunders } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { backgroundJobsEnabled } from "../jobs/queue"
import type { QueueSubmissionsInput, QueueSubmissionsResult, QueuedJobSummary, SubmissionJob } from "./contracts"
import { enqueueSubmissionDelivery } from "./delivery-job"
import { assertDuplicatePolicy, privilegedOverrideAllowed } from "./duplicate-policy"
import { packageFingerprint, submissionMerchantIdentityKey } from "./identity"
import { checklistForRoute, freezeDocumentVersions, toQueuedSummary, reasonFromErrors } from "./jobs"
import { processJobDelivery } from "./outbox"
import { loadFunderForDestination, preflightDestination, probeSubmissionSender, type SenderProbe } from "./preflight"
import { listJobsForDeal, persistNewDestination } from "./repository"

export interface SubmissionSelectionFunder {
  id: string
  legalName: string
  nickname?: string
  active: boolean
  route: SubmissionJob["route"] | null
  preflightErrors: Array<{ field: string; message: string }>
  checklist: Array<{ documentId: string; filename: string; category: string; checksum: string; excluded: boolean }>
}

export interface SubmissionJobView {
  jobId: string
  funderId: string
  displayFunderName: string
  routeKind: SubmissionJob["routeKind"]
  state: SubmissionJob["state"]
  reason?: string
  confirmationKey: string
  dealVersion: number
  createdAt: string
  updatedAt: string
}

export interface SubmissionSelection {
  dealId: string
  dealVersion: number
  documents: Array<{ id: string; filename: string; category: string; checksum: string; byteLength: number }>
  funders: SubmissionSelectionFunder[]
  jobs: SubmissionJobView[]
}

export interface ConfirmSubmissionsResult extends QueueSubmissionsResult {
  confirmationKey: string
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  return next
}

function asFunderIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(422, "validation_failed", "Select at least one funder.", { funderIds: ["Select at least one funder."] })
  }
  if (value.length > 200) {
    throw new AppError(422, "validation_failed", "Select fewer funders.", { funderIds: ["Use at most 200 funders."] })
  }
  const ids: string[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new AppError(422, "validation_failed", "Each funder ID must be present.", { funderIds: [`Funder ${index + 1} is invalid.`] })
    }
    ids.push(item.trim())
  }
  return uniqueIds(ids)
}

function asOptionalText(value: unknown, field: string, max: number): string | undefined {
  if (value == null || value === "") return undefined
  if (typeof value !== "string") {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`Enter a valid ${field}.`] })
  }
  const next = value.trim()
  if (!next) return undefined
  if (next.length > max) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`Use at most ${max} characters.`] })
  }
  return next
}

function independentReason(error: unknown): string {
  if (error instanceof AppError) return error.message
  return "This destination could not be queued."
}

function toJobView(job: SubmissionJob): SubmissionJobView {
  return {
    jobId: job.id,
    funderId: job.funderId,
    displayFunderName: job.displayFunderName,
    routeKind: job.routeKind,
    state: job.state,
    reason: job.reason,
    confirmationKey: job.confirmationKey,
    dealVersion: job.dealVersion,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

async function audit(actor: DealActor, job: SubmissionJob, created: boolean): Promise<void> {
  await recordAuditEvent({
    context: actor,
    action: created ? "submission.queued" : "submission.replayed",
    resourceType: "submission_job",
    resourceId: job.id,
    metadata: {
      dealId: job.dealId,
      funderId: job.funderId,
      state: job.state,
      routeKind: job.routeKind,
      confirmationKey: job.confirmationKey,
      created,
    },
    correlationId: actor.correlationId,
  })
}

async function queueDestination(input: {
  actor: DealActor
  dealId: string
  funderId: string
  confirmationKey: string
  analysisRunId?: string
  privilegedRetry?: boolean
  privilegedReason?: string
  dealVersion: number
  dealEin?: string | null
  merchantId?: string | null
  documents: DocumentSummary[]
  sender: SenderProbe
}): Promise<QueuedJobSummary> {
  const funder = await loadFunderForDestination(input.actor, input.funderId)
  const preflight = preflightDestination({ funder, documents: input.documents, sender: input.sender })
  if (!funder) {
    return {
      jobId: newId(),
      funderId: input.funderId,
      state: "preflight_failed",
      reason: reasonFromErrors(preflight.errors, "The requested funder was not found."),
    }
  }

  const merchantIdentityKey = submissionMerchantIdentityKey({
    workspaceId: input.actor.workspaceId,
    ein: input.dealEin,
    merchantId: input.merchantId,
    dealId: input.dealId,
  })
  const fingerprint = packageFingerprint(preflight.originals.map((document) => document.checksum))
  const duplicate = await assertDuplicatePolicy({
    actor: input.actor,
    dealId: input.dealId,
    funderId: input.funderId,
    merchantIdentityKey,
    packageFingerprint: fingerprint,
    privilegedRetry: input.privilegedRetry,
    privilegedReason: input.privilegedReason,
  })

  let state: SubmissionJob["state"] = "queued"
  let reason: string | undefined
  if (preflight.errors.length) {
    state = "preflight_failed"
    reason = reasonFromErrors(preflight.errors, "Preflight failed.")
  } else if (!duplicate.allowed) {
    state = "blocked_duplicate"
    reason = duplicate.reason ?? "A duplicate submission is blocked."
  }

  const saved = await persistNewDestination({
    workspaceId: input.actor.workspaceId,
    dealId: input.dealId,
    funderId: funder.id,
    displayFunderName: preflight.displayName,
    routeKind: preflight.route.kind,
    route: preflight.route,
    state,
    confirmationKey: input.confirmationKey,
    attemptKey: input.confirmationKey,
    analysisRunId: input.analysisRunId,
    dealVersion: input.dealVersion,
    documentVersions: freezeDocumentVersions(input.documents),
    packageDocumentIds: preflight.originals.map((document) => document.documentId),
    preflightErrors: preflight.errors,
    merchantIdentityKey,
    packageFingerprint: fingerprint,
    reason,
    createdByUserId: input.actor.userId,
    actor: input.actor,
  })
  await audit(input.actor, saved.job, saved.created)
  if (!saved.created) return toQueuedSummary(saved.job)
  if (saved.job.state !== "queued") return toQueuedSummary(saved.job)
  if (backgroundJobsEnabled()) {
    await enqueueSubmissionDelivery(saved.job)
    return toQueuedSummary(saved.job)
  }
  return toQueuedSummary(await processJobDelivery(saved.job))
}

export async function queueSubmissions(input: QueueSubmissionsInput): Promise<QueueSubmissionsResult> {
  if (input.privilegedRetry === true && !privilegedOverrideAllowed(input.actor)) {
    throw new AppError(403, "privileged_retry_forbidden", "Privileged retry requires a workspace administrator session.")
  }
  const deal = await getDealForDocument(input.actor, input.dealId)
  const documents = await listDocuments(input.actor, input.dealId)
  const sender = await probeSubmissionSender(input.actor)
  const jobs: QueuedJobSummary[] = []
  for (const funderId of uniqueIds(input.funderIds)) {
    try {
      jobs.push(await queueDestination({
        actor: input.actor,
        dealId: deal.id,
        funderId,
        confirmationKey: input.confirmationKey,
        analysisRunId: input.analysisRunId,
        privilegedRetry: input.privilegedRetry,
        privilegedReason: input.privilegedReason,
        dealVersion: deal.version,
        dealEin: deal.ein,
        merchantId: deal.merchantId,
        documents,
        sender,
      }))
    } catch (error) {
      jobs.push({
        jobId: newId(),
        funderId,
        state: "failed",
        reason: independentReason(error),
      })
    }
  }
  return { ok: true, jobs }
}

export async function getSubmissionSelection(actor: DealActor, dealId: string): Promise<SubmissionSelection> {
  const deal = await getDealForDocument(actor, dealId)
  const documents = await listDocuments(actor, dealId)
  const funders = await listFunders(actor)
  const sender = await probeSubmissionSender(actor)
  const jobs = await listJobsForDeal(actor.workspaceId, deal.id)
  return {
    dealId: deal.id,
    dealVersion: deal.version,
    documents: documents.map((document) => ({
      id: document.id,
      filename: document.displayFilename,
      category: document.category,
      checksum: document.checksum,
      byteLength: document.byteLength,
    })),
    funders: funders.map((funder) => {
      const preflight = preflightDestination({ funder, documents, sender })
      const route = funder.routes.find((item) => item.active) ?? null
      return {
        id: funder.id,
        legalName: funder.legalName,
        nickname: funder.nickname,
        active: funder.active,
        route,
        preflightErrors: preflight.errors,
        checklist: checklistForRoute(documents, route ?? preflight.route),
      }
    }),
    jobs: jobs.map(toJobView),
  }
}

export async function confirmSubmissions(actor: DealActor, dealId: string, input: {
  funderIds?: unknown
  confirmationKey?: unknown
  analysisRunId?: unknown
  privilegedRetry?: unknown
  privilegedReason?: unknown
}): Promise<ConfirmSubmissionsResult> {
  const analysisRunId = asOptionalText(input.analysisRunId, "analysisRunId", 128)
  const confirmationKey = asOptionalText(input.confirmationKey, "confirmationKey", 128) ?? analysisRunId ?? newId()
  const privilegedRetry = input.privilegedRetry === true
  const privilegedReason = asOptionalText(input.privilegedReason, "privilegedReason", 500)
  const queued = await queueSubmissions({
    actor,
    dealId,
    funderIds: asFunderIds(input.funderIds),
    analysisRunId,
    confirmationKey,
    privilegedRetry,
    privilegedReason,
  })
  return { ...queued, confirmationKey }
}

export async function requireSubmissionActor(request: Request, mode: "read" | "write"): Promise<DealActor> {
  if (mode === "write") assertTrustedMutation(request)
  const auth = await requireWorkspaceAccess(request, { scopes: [mode === "read" ? "deals:read" : "deals:write"] })
  return { ...await actorForDeals(auth), correlationId: requestCorrelationId(request) }
}
