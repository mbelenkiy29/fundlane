import "server-only"

import { assertTrustedMutation, requireWorkspaceAccess } from "../auth"
import { listChecks } from "../datamerch/repository"
import { newId, recordAuditEvent, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import type { DocumentSummary } from "../documents/contracts"
import { listSubmissionDocuments } from "../documents/service"
import { AppError } from "../errors"
import { listFunders } from "../funders/directory"
import { requestCorrelationId } from "../http"
import { backgroundJobsEnabled } from "../jobs/queue"
import { checkCompleteness } from "../underwriting/completeness"
import { evaluateUnderwritingSendGates, underwritingSendGateError } from "../underwriting/send-gates"
import type { QueueSubmissionsInput, QueueSubmissionsResult, QueuedJobSummary, SubmissionJob } from "./contracts"
import { enqueueSubmissionDelivery } from "./delivery-job"
import { assertDuplicatePolicy, privilegedOverrideAllowed } from "./duplicate-policy"
import { eligibleAtFromReason } from "./duplicate-rules"
import { packageFingerprint, submissionMerchantIdentityKey } from "./identity"
import { checklistForRoute, freezeDocumentVersions, toQueuedSummary, reasonFromErrors } from "./jobs"
import { processJobDelivery } from "./outbox"
import { loadFunderForDestination, preflightDestination, probeSubmissionSender, type SenderProbe } from "./preflight"
import { listJobsForDeal, persistNewDestination } from "./repository"

let completenessReadyForTests: boolean | undefined

export function setSubmissionCompletenessForTests(ready?: boolean): void {
  completenessReadyForTests = ready
}

async function assertSubmissionSendGates(actor: DealActor, dealId: string): Promise<void> {
  if (completenessReadyForTests === true) return
  await checkCompleteness(actor, dealId)
  const gate = await evaluateUnderwritingSendGates(actor, dealId)
  if (!gate.ok) throw underwritingSendGateError(gate)
}

async function latestDataMerch(workspaceId: string, dealId: string) {
  const check = (await listChecks(workspaceId, dealId))[0]
  if (!check) return null
  return { status: check.status, resultSummary: check.resultSummary }
}

export interface SubmissionSelectionFunder {
  id: string
  legalName: string
  nickname?: string
  active: boolean
  route: SubmissionJob["route"] | null
  preflightErrors: Array<{ field: string; message: string }>
  preflightWarnings: Array<{ field: string; message: string; severity: "warning" }>
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
  autoSubmitted?: boolean
}

export interface SubmissionSelection {
  dealId: string
  dealVersion: number
  documents: Array<{ id: string; filename: string; category: string; checksum: string; byteLength: number }>
  funders: SubmissionSelectionFunder[]
  jobs: SubmissionJobView[]
  autoDecisions?: Array<{ funder_id: string; score: number; outcome: string; reason: string; submission_job_id: string | null; created_at: string }>
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

function withEligibleAt(summary: QueuedJobSummary, eligibleAt?: string): QueuedJobSummary {
  const next = eligibleAt
    ?? (summary.state === "blocked_duplicate" ? eligibleAtFromReason(summary.reason) : undefined)
  return next ? { ...summary, eligibleAt: next } : summary
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
  approvedPackage?: SubmissionJob["approvedPackage"]
  deferDelivery?: boolean
  dealVersion: number
  expectedDealVersion?: number
  expectedAutoApiRoute?: SubmissionJob["route"]
  dealEin?: string | null
  merchantId?: string | null
  documents: DocumentSummary[]
  sender: SenderProbe
  dataMerch?: { status?: string; resultSummary?: string } | null
}): Promise<QueuedJobSummary> {
  const funder = await loadFunderForDestination(input.actor, input.funderId)
  const preflight = preflightDestination({
    funder,
    documents: input.documents,
    sender: input.sender,
    dataMerch: input.dataMerch,
  })
  if (!funder) {
    return {
      jobId: newId(),
      funderId: input.funderId,
      state: "preflight_failed",
      reason: reasonFromErrors(preflight.errors, "The requested funder was not found."),
    }
  }
  if (input.expectedAutoApiRoute && (!funder.active || preflight.route.kind !== "api"
    || JSON.stringify(preflight.route) !== JSON.stringify(input.expectedAutoApiRoute))) {
    return { jobId: newId(), funderId: input.funderId, state: "preflight_failed", reason: "The approved API route changed before automatic submission." }
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
  let eligibleAt: string | undefined
  if (preflight.errors.length) {
    state = "preflight_failed"
    reason = reasonFromErrors(preflight.errors, "Preflight failed.")
  } else if (!duplicate.allowed) {
    state = "blocked_duplicate"
    reason = duplicate.reason ?? "A duplicate submission is blocked."
    eligibleAt = duplicate.eligibleAt
  }

  const saved = await persistNewDestination({
    workspaceId: input.actor.workspaceId,
    dealId: input.dealId,
    funderId: funder.id,
    displayFunderName: preflight.displayName,
    routeKind: (input.approvedPackage?.route ?? preflight.route).kind,
    route: input.approvedPackage?.route ?? preflight.route,
    state,
    confirmationKey: input.confirmationKey,
    attemptKey: input.confirmationKey,
    analysisRunId: input.analysisRunId,
    dealVersion: input.dealVersion,
    expectedDealVersion: input.expectedDealVersion,
    expectedAutoApiRoute: input.expectedAutoApiRoute,
    approvedPackage: input.approvedPackage,
    documentVersions: input.approvedPackage?.originalVersions ?? freezeDocumentVersions(input.documents),
    packageDocumentIds: preflight.originals.map((document) => document.documentId),
    preflightErrors: preflight.errors,
    merchantIdentityKey,
    packageFingerprint: fingerprint,
    reason,
    createdByUserId: input.actor.userId,
    actor: input.actor,
  })
  await audit(input.actor, saved.job, saved.created)
  if (saved.created) {
    await (await import("../comms/workflow-events")).emitSubmissionCreatedWebhook(input.actor, saved.job)
  }
  const summary = toQueuedSummary(saved.job)
  if (!saved.created) return withEligibleAt(summary, eligibleAt)
  if (saved.job.state !== "queued") return withEligibleAt(summary, eligibleAt)
  if (input.deferDelivery) {
    if (backgroundJobsEnabled()) await enqueueSubmissionDelivery(saved.job)
    return toQueuedSummary(saved.job)
  }
  if (backgroundJobsEnabled()) {
    await enqueueSubmissionDelivery(saved.job)
    return toQueuedSummary(saved.job)
  }
  return toQueuedSummary(await processJobDelivery(saved.job))
}

export async function queueSubmissions(input: QueueSubmissionsInput): Promise<QueueSubmissionsResult> {
  if (input.privilegedRetry === true && !privilegedOverrideAllowed(input.actor)) {
    throw new AppError(403, "privileged_retry_forbidden", "The 24-hour duplicate rule can be overridden only by someone who can submit this deal.")
  }
  const deal = await getDealForDocument(input.actor, input.dealId)
  if (input.expectedDealVersion !== undefined && deal.version !== input.expectedDealVersion) {
    throw new AppError(409, "deal_version_changed", "The deal changed before automatic submission.")
  }
  await assertSubmissionSendGates(input.actor, deal.id)
  const documents = await listSubmissionDocuments(input.actor, input.dealId)
  const sender = await probeSubmissionSender(input.actor)
  const dataMerch = await latestDataMerch(input.actor.workspaceId, deal.id)
  const jobs: QueuedJobSummary[] = []
  for (const funderId of uniqueIds(input.funderIds)) {
    try {
      const enqueue = () => queueDestination({
        actor: input.actor,
        dealId: deal.id,
        funderId,
        approvedPackage: input.approvedPackages?.[funderId],
        deferDelivery: input.deferDelivery,
        confirmationKey: input.confirmationKey,
        analysisRunId: input.analysisRunId,
        privilegedRetry: input.privilegedRetry,
        privilegedReason: input.privilegedReason,
        dealVersion: deal.version,
        expectedDealVersion: input.expectedDealVersion,
        expectedAutoApiRoute: input.expectedAutoApiRoute,
        dealEin: deal.ein,
        merchantId: deal.merchantId,
        documents,
        sender,
        dataMerch,
      })
      jobs.push(input.deferDelivery ? await withTransaction(async (db) => {
        await db.execute("SAVEPOINT application_destination")
        try {
          const result = await enqueue()
          await db.execute("RELEASE SAVEPOINT application_destination")
          return result
        } catch (error) {
          await db.execute("ROLLBACK TO SAVEPOINT application_destination")
          await db.execute("RELEASE SAVEPOINT application_destination")
          throw error
        }
      }) : await enqueue())
    } catch (error) {
      const approved = input.approvedPackages?.[funderId]
      if (input.deferDelivery && approved) {
        const saved = await persistNewDestination({
          workspaceId: input.actor.workspaceId, dealId: deal.id, funderId,
          displayFunderName: approved.email?.funderName ?? (await loadFunderForDestination(input.actor, funderId))?.legalName ?? funderId,
          routeKind: approved.route.kind, route: approved.route, state: "failed",
          confirmationKey: input.confirmationKey, attemptKey: input.confirmationKey, analysisRunId: input.analysisRunId,
          dealVersion: deal.version, documentVersions: approved.originalVersions,
          packageDocumentIds: approved.documents.map((document) => document.originalDocumentId), approvedPackage: approved,
          preflightErrors: [], merchantIdentityKey: submissionMerchantIdentityKey({workspaceId: input.actor.workspaceId, ein: deal.ein, merchantId: deal.merchantId, dealId: deal.id}),
          packageFingerprint: packageFingerprint(approved.documents.map((document) => document.checksum)),
          reason: independentReason(error), createdByUserId: input.actor.userId, actor: input.actor,
        })
        jobs.push(toQueuedSummary(saved.job))
        continue
      }
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
  const documents = await listSubmissionDocuments(actor, dealId)
  const funders = await listFunders(actor)
  const sender = await probeSubmissionSender(actor)
  const dataMerch = await latestDataMerch(actor.workspaceId, deal.id)
  const jobs = await listJobsForDeal(actor.workspaceId, deal.id)
  const autoDecisions = process.env.MCA_AUTO_SUBMIT_ENABLED === "true"
    ? await (await import("../underwriting/auto-submit")).listAutoSubmitDecisions(actor, deal.id) : []
  const autoJobIds = new Set(autoDecisions.map(decision => decision.submission_job_id))
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
      const preflight = preflightDestination({ funder, documents, sender, dataMerch })
      const route = funder.routes.find((item) => item.active) ?? null
      return {
        id: funder.id,
        legalName: funder.legalName,
        nickname: funder.nickname,
        active: funder.active,
        route,
        preflightErrors: preflight.errors,
        preflightWarnings: preflight.warnings,
        checklist: checklistForRoute(documents, route ?? preflight.route),
      }
    }),
    jobs: jobs.map(job => ({ ...toJobView(job), ...(autoJobIds.has(job.id) ? { autoSubmitted: true } : {}) })),
    ...(autoDecisions.length ? { autoDecisions } : {}),
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
