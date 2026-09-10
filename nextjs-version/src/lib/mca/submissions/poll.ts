import "server-only"

import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import {
  assertStatusPollAllowed,
  getStatusViaAdapter,
  redactAdapterSecrets,
} from "./adapters/framework"
import {
  effectiveAdapterCapabilities,
  recordAdapterLastAction,
  resolveAdapterEnvironment,
  resolveAdapterSecrets,
} from "./adapters/credentials"
import type { AdapterLastAction } from "./adapters/contracts"
import { getAdapter } from "./adapters/registry"
import type { AdapterStatusResult, SubmissionJob } from "./contracts"
import { listApiOffersForDeal, reconcileProviderStatus, type ReconciledOfferView, type ReconcileProviderStatusResult } from "./reconciliation"
import { findJobById, listAttemptsForJob, listJobsForDeal } from "./repository"

const POLL_BATCH = 100

export interface SubmissionStatusView {
  jobId: string
  dealId: string
  funderId: string
  displayFunderName: string
  routeKind: SubmissionJob["routeKind"]
  jobState: SubmissionJob["state"]
  submissionStatus?: string
  capabilities: { statusPoll: boolean; webhooks: boolean }
  lastRawStatus?: string
  lastNormalized?: ReconcileProviderStatusResult["normalized"]
  unknown?: boolean
}

export interface SubmissionStatusBoard {
  state: "empty" | "ready"
  dealId: string
  jobs: SubmissionStatusView[]
  offers: ReconciledOfferView[]
  message?: string
}

function adapterSlug(job: SubmissionJob): string {
  return job.route.destination
}

async function requireDealJob(actor: DealActor, jobId: string): Promise<SubmissionJob> {
  if (!jobId.trim()) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { jobId: ["Select a submission job."] })
  }
  const job = await findJobById(actor.workspaceId, jobId.trim())
  if (!job) throw new AppError(404, "job_not_found", "The requested submission job was not found.")
  await getDealForDocument(actor, job.dealId)
  return job
}

function unsupportedPoll(): never {
  throw new AppError(409, "capability_unsupported", "This adapter cannot check status.")
}

function assertPollable(job: SubmissionJob): void {
  if (job.routeKind !== "api") unsupportedPoll()
  const slug = adapterSlug(job)
  const adapter = getAdapter(slug)
  const capabilities = effectiveAdapterCapabilities(slug)
  assertStatusPollAllowed(capabilities, adapter)
}

async function lastExternalRef(jobId: string): Promise<string | undefined> {
  const attempts = await listAttemptsForJob(jobId)
  return attempts.map((attempt) => attempt.externalRef).find(Boolean)
}

async function rememberPollAction(job: SubmissionJob, status: AdapterStatusResult, ok: boolean, error?: { code?: string; message?: string }): Promise<void> {
  const resolved = await resolveAdapterSecrets({
    workspaceId: job.workspaceId,
    funderId: job.funderId,
    environment: resolveAdapterEnvironment(),
    adapterSlug: adapterSlug(job),
  })
  if (!resolved) return
  const lastAction: AdapterLastAction = {
    action: "status",
    correlationId: status.correlationId,
    externalRef: status.eventId,
    errorCode: ok ? undefined : error?.code,
    errorMessage: ok ? undefined : error?.message,
    rawStatus: status.rawStatus,
    at: new Date().toISOString(),
  }
  await recordAdapterLastAction(job.workspaceId, resolved.credentialId, redactAdapterSecrets(lastAction, resolved.secrets))
}

export async function refreshSubmissionStatus(actor: DealActor, jobId: string): Promise<ReconcileProviderStatusResult> {
  const job = await requireDealJob(actor, jobId)
  assertPollable(job)
  const status = await getStatusViaAdapter(job, {
    correlationId: actor.correlationId,
    externalRef: await lastExternalRef(job.id),
  })
  const result = await reconcileProviderStatus({ job, status, source: "poll", eventKey: status.eventId ? `poll:${status.eventId}` : undefined, actor })
  await rememberPollAction(job, status, true)
  return result
}

export async function pollActiveSubmissions(actor: DealActor, dealId?: string): Promise<{
  state: "empty" | "success"
  results: ReconcileProviderStatusResult[]
  skipped: Array<{ jobId: string; reason: "capability_unsupported" | "not_active" }>
  failures: Array<{ jobId: string; code: string; message: string }>
}> {
  const jobs = dealId
    ? await listJobsForDeal((await getDealForDocument(actor, dealId)).workspaceId, dealId)
    : await listActiveApiJobs(actor.workspaceId)
  const active = jobs.filter((job) => job.routeKind === "api" && job.state === "sent").slice(0, POLL_BATCH)
  if (active.length === 0) {
    return { state: "empty", results: [], skipped: [], failures: [] }
  }
  const results: ReconcileProviderStatusResult[] = []
  const skipped: Array<{ jobId: string; reason: "capability_unsupported" | "not_active" }> = []
  const failures: Array<{ jobId: string; code: string; message: string }> = []
  for (const job of active) {
    const adapter = getAdapter(adapterSlug(job))
    const capabilities = effectiveAdapterCapabilities(adapterSlug(job))
    if (!capabilities.statusPoll || !adapter?.getStatus) {
      skipped.push({ jobId: job.id, reason: "capability_unsupported" })
      continue
    }
    try {
      const status = await getStatusViaAdapter(job, {
        correlationId: actor.correlationId,
        externalRef: await lastExternalRef(job.id),
      })
      const result = await reconcileProviderStatus({
        job,
        status,
        source: "poll",
        eventKey: status.eventId ? `poll:${status.eventId}` : undefined,
        actor,
      })
      await rememberPollAction(job, status, true)
      results.push(result)
    } catch (error) {
      const code = error instanceof AppError ? error.code : "provider_unavailable"
      const message = error instanceof Error ? error.message : "The funder adapter could not check status."
      failures.push({ jobId: job.id, code, message })
      await rememberPollAction(job, { rawStatus: "", correlationId: actor.correlationId, unknown: true }, false, { code, message }).catch(() => undefined)
    }
  }
  return { state: results.length || failures.length || skipped.length ? "success" : "empty", results, skipped, failures }
}

async function listActiveApiJobs(workspaceId: string): Promise<SubmissionJob[]> {
  const rows = await getDatabase().prepare<{ id: string }>(
    "SELECT id FROM mca_submission_jobs WHERE workspace_id = ? AND route_kind = 'api' AND state = 'sent' ORDER BY updated_at ASC, id ASC LIMIT ?",
  ).all(workspaceId, POLL_BATCH)
  const jobs: SubmissionJob[] = []
  for (const row of rows) {
    const job = await findJobById(workspaceId, row.id)
    if (job) jobs.push(job)
  }
  return jobs
}

export async function getSubmissionStatusBoard(actor: DealActor, dealId: string): Promise<SubmissionStatusBoard> {
  if (!dealId.trim()) {
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { dealId: ["Select a deal."] })
  }
  const deal = await getDealForDocument(actor, dealId.trim())
  const jobs = await listJobsForDeal(actor.workspaceId, deal.id)
  const apiJobs = jobs.filter((job) => job.routeKind === "api")
  const submissions = await getDatabase().prepare<{ id: string; job_id: string | null; status: string }>(
    "SELECT id, job_id, status FROM deal_submissions WHERE workspace_id = ? AND deal_id = ?",
  ).all(actor.workspaceId, deal.id)
  const byJob = new Map(submissions.filter((row) => row.job_id).map((row) => [row.job_id as string, row]))
  const offers = await listApiOffersForDeal(actor.workspaceId, deal.id)
  const offerRows = await getDatabase().prepare<{ id: string; submission_id: string; raw_status: string | null; status: string }>(
    "SELECT id, submission_id, raw_status, status FROM deal_offers WHERE workspace_id = ? AND deal_id = ? AND COALESCE(source, 'api') = 'api'",
  ).all(actor.workspaceId, deal.id)
  const offerBySubmission = new Map(offerRows.map((row) => [row.submission_id, row]))
  const views: SubmissionStatusView[] = apiJobs.map((job) => {
    const capabilities = effectiveAdapterCapabilities(adapterSlug(job))
    const submission = byJob.get(job.id)
    const offer = submission ? offerBySubmission.get(submission.id) : undefined
    return {
      jobId: job.id,
      dealId: job.dealId,
      funderId: job.funderId,
      displayFunderName: job.displayFunderName,
      routeKind: job.routeKind,
      jobState: job.state,
      submissionStatus: submission?.status,
      capabilities: { statusPoll: capabilities.statusPoll === true, webhooks: capabilities.webhooks === true },
      lastRawStatus: offer?.raw_status ?? (submission?.status && !["queued", "sent", "errored", "approved", "declined"].includes(submission.status) ? submission.status : undefined),
      lastNormalized: offer?.status === "accepted" ? "funded" : offer?.status === "declined" ? "declined" : offer?.status === "presented" ? "approved" : undefined,
      unknown: Boolean(submission?.status && !["queued", "sent", "errored", "approved", "declined", "draft"].includes(submission.status)),
    }
  })
  if (apiJobs.length === 0) {
    return {
      state: "empty",
      dealId: deal.id,
      jobs: [],
      offers: [],
      message: "No API submissions are ready to poll.",
    }
  }
  return { state: "ready", dealId: deal.id, jobs: views, offers }
}
