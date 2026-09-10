import "server-only"

import { getDatabase, newId, recordAuditEvent } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { listDocuments } from "../documents/service"
import { AppError } from "../errors"
import type { DeliverResult, JobState, SubmissionAttempt, SubmissionJob } from "./contracts"
import {
  displayCacheStatus,
  findAttempt,
  findJobById,
  insertAttempt,
  insertDealSubmissionCache,
  listAttemptsForJob,
  listJobsForDeal,
  updateAttempt,
  updateJobRecord,
} from "./repository"
import { webhookSchemaPreview, type WebhookSchemaPreview } from "./webhook"

export interface PortalOperator {
  userId: string | null
  name: string
}

export interface PortalPackageDocument {
  documentId: string
  filename: string
  category: string
  checksum: string
}

export interface PortalAttemptLog {
  attemptKey: string
  transport: string
  state: string
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
  createdAt: string
}

export interface PortalTask {
  jobId: string
  funderId: string
  displayFunderName: string
  state: JobState
  reason?: string
  portalUrl: string
  assignedOperator: PortalOperator
  packageDocuments: PortalPackageDocument[]
  attempts: PortalAttemptLog[]
  externalRef?: string
  confirmationKey: string
  dealVersion: number
}

export interface WebhookJobView {
  jobId: string
  funderId: string
  displayFunderName: string
  state: JobState
  reason?: string
  destinationHost: string
  schemaPreview: WebhookSchemaPreview
  attempts: PortalAttemptLog[]
  responseSync: false
  confirmationKey: string
}

export interface PortalBoard {
  dealId: string
  dealVersion: number
  portals: PortalTask[]
  webhooks: WebhookJobView[]
}

export interface PortalOpenResult {
  ok: true
  jobId: string
  state: JobState
  portalUrl: string
}

export interface PortalCompleteResult {
  ok: true
  jobId: string
  state: JobState
  externalRef?: string
}

function asJobId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { jobId: ["Select a submission job."] })
  }
  const next = value.trim()
  if (next.length > 128) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { jobId: ["Use at most 128 characters."] })
  }
  return next
}

function asOptionalRef(value: unknown): string | undefined {
  if (value == null || value === "") return undefined
  if (typeof value !== "string") {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { externalRef: ["Enter a valid external reference."] })
  }
  const next = value.trim()
  if (!next) return undefined
  if (next.length > 200) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { externalRef: ["Use at most 200 characters."] })
  }
  return next
}

function toAttemptLog(attempt: SubmissionAttempt): PortalAttemptLog {
  return {
    attemptKey: attempt.attemptKey,
    transport: attempt.transport,
    state: attempt.state,
    correlationId: attempt.correlationId,
    externalRef: attempt.externalRef,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
    createdAt: attempt.createdAt,
  }
}

async function requireDealJob(actor: DealActor, dealId: string, jobId: string): Promise<SubmissionJob> {
  const deal = await getDealForDocument(actor, dealId)
  const job = await findJobById(actor.workspaceId, jobId)
  if (!job || job.dealId !== deal.id) {
    throw new AppError(404, "job_not_found", "The requested submission job was not found.")
  }
  return job
}

async function operatorsByJob(workspaceId: string, dealId: string): Promise<Map<string, PortalOperator>> {
  const rows = await getDatabase().prepare<{
    id: string
    created_by_user_id: string | null
    name: string | null
    email: string | null
  }>(`SELECT j.id, j.created_by_user_id, u.name, u.email
      FROM mca_submission_jobs j
      LEFT JOIN users u ON u.id = j.created_by_user_id
      WHERE j.workspace_id = ? AND j.deal_id = ?`).all(workspaceId, dealId)
  const next = new Map<string, PortalOperator>()
  for (const row of rows) {
    const name = row.name?.trim() || row.email?.trim() || (row.created_by_user_id ? "Assigned operator" : "Unassigned")
    next.set(row.id, { userId: row.created_by_user_id, name })
  }
  return next
}

function packageFor(job: SubmissionJob, documents: Array<{ id: string; displayFilename: string; category: string; checksum: string }>): PortalPackageDocument[] {
  const byId = new Map(documents.map((document) => [document.id, document]))
  return job.packageDocumentIds.map((documentId) => {
    const live = byId.get(documentId)
    const frozen = job.documentVersions.find((item) => item.documentId === documentId)
    return {
      documentId,
      filename: live?.displayFilename ?? "Document",
      category: live?.category ?? frozen?.category ?? "other_stip",
      checksum: frozen?.checksum ?? live?.checksum ?? "",
    }
  })
}

async function refreshCache(job: SubmissionJob): Promise<void> {
  await insertDealSubmissionCache({
    workspaceId: job.workspaceId,
    dealId: job.dealId,
    funderName: job.displayFunderName,
    status: displayCacheStatus(job.state),
    funderId: job.funderId,
    jobId: job.id,
    routeKind: job.routeKind,
  })
}

export async function createPortalTask(job: SubmissionJob): Promise<DeliverResult> {
  return {
    ok: true,
    state: "pending_portal",
    correlationId: newId(),
    errorMessage: `Open the ${job.displayFunderName} portal and confirm completion. Opening the URL does not mark this destination submitted.`,
  }
}

export async function listPortalBoard(actor: DealActor, dealId: string): Promise<PortalBoard> {
  const deal = await getDealForDocument(actor, dealId)
  const [jobs, documents, operators] = await Promise.all([
    listJobsForDeal(actor.workspaceId, deal.id),
    listDocuments(actor, deal.id),
    operatorsByJob(actor.workspaceId, deal.id),
  ])
  const portals: PortalTask[] = []
  const webhooks: WebhookJobView[] = []
  for (const job of jobs) {
    const attempts = (await listAttemptsForJob(job.id)).map(toAttemptLog)
    const externalRef = attempts.map((item) => item.externalRef).find(Boolean)
    if (job.routeKind === "manual_portal") {
      portals.push({
        jobId: job.id,
        funderId: job.funderId,
        displayFunderName: job.displayFunderName,
        state: job.state,
        reason: job.reason,
        portalUrl: job.route.destination,
        assignedOperator: operators.get(job.id) ?? { userId: null, name: "Unassigned" },
        packageDocuments: packageFor(job, documents),
        attempts,
        externalRef,
        confirmationKey: job.confirmationKey,
        dealVersion: job.dealVersion,
      })
      continue
    }
    if (job.routeKind === "custom_webhook") {
      const preview = webhookSchemaPreview(job)
      webhooks.push({
        jobId: job.id,
        funderId: job.funderId,
        displayFunderName: job.displayFunderName,
        state: job.state,
        reason: job.reason,
        destinationHost: preview.destinationHost,
        schemaPreview: preview,
        attempts,
        responseSync: false,
        confirmationKey: job.confirmationKey,
      })
    }
  }
  return { dealId: deal.id, dealVersion: deal.version, portals, webhooks }
}

export async function openPortalTask(actor: DealActor, dealId: string, jobId: unknown): Promise<PortalOpenResult> {
  const job = await requireDealJob(actor, dealId, asJobId(jobId))
  if (job.routeKind !== "manual_portal") {
    throw new AppError(422, "validation_failed", "Only manual portal destinations can be opened.", { jobId: ["This job is not a manual portal task."] })
  }
  if (job.state === "pending_portal") {
    await updateJobRecord(actor.workspaceId, job.id, {
      state: "pending_portal",
      reason: "Portal URL opened. Completion is still required.",
    })
  }
  await recordAuditEvent({
    context: actor,
    action: "submission.portal_opened",
    resourceType: "submission_job",
    resourceId: job.id,
    metadata: { dealId: job.dealId, funderId: job.funderId, state: job.state },
    correlationId: actor.correlationId,
  })
  const current = await findJobById(actor.workspaceId, job.id) ?? job
  return {
    ok: true,
    jobId: current.id,
    state: current.state,
    portalUrl: current.route.destination,
  }
}

export async function completePortalTask(actor: DealActor, dealId: string, input: {
  jobId?: unknown
  externalRef?: unknown
}): Promise<PortalCompleteResult> {
  const job = await requireDealJob(actor, dealId, asJobId(input.jobId))
  if (job.routeKind !== "manual_portal") {
    throw new AppError(422, "validation_failed", "Only manual portal destinations can be confirmed.", { jobId: ["This job is not a manual portal task."] })
  }
  const externalRef = asOptionalRef(input.externalRef)
  if (job.state === "sent") {
    const attempt = await findAttempt(job.id, job.attemptKey)
    return { ok: true, jobId: job.id, state: "sent", externalRef: attempt?.externalRef }
  }
  if (job.state !== "pending_portal") {
    throw new AppError(422, "validation_failed", "This portal task is not waiting for completion.", { jobId: ["Confirm only pending portal tasks."] })
  }

  const existing = await findAttempt(job.id, job.attemptKey)
  if (existing) {
    await updateAttempt(job.id, job.attemptKey, {
      state: "sent",
      correlationId: existing.correlationId,
      externalRef,
      errorCode: null,
      errorMessage: null,
    })
  } else {
    await insertAttempt({
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptKey: job.attemptKey,
      transport: job.routeKind,
      state: "sent",
      correlationId: actor.correlationId || newId(),
      externalRef,
    })
  }

  const saved = await updateJobRecord(actor.workspaceId, job.id, {
    state: "sent",
    reason: externalRef ? `Portal completion confirmed (${externalRef}).` : "Portal completion confirmed.",
  })
  await refreshCache(saved)
  await recordAuditEvent({
    context: actor,
    action: "submission.portal_completed",
    resourceType: "submission_job",
    resourceId: saved.id,
    metadata: { dealId: saved.dealId, funderId: saved.funderId, state: saved.state, externalRef: externalRef ?? null },
    correlationId: actor.correlationId,
  })
  return { ok: true, jobId: saved.id, state: saved.state, externalRef }
}
