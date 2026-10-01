import "server-only"

import { createHash } from "node:crypto"
import { getOutgoingDocumentBytes } from "./compress"
import { getDatabase, newId, recordAuditEvent, withTransaction } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { assertCompanyOperational } from "../company-access"
import type { AttemptState, DeliverResult, JobState, SubmissionAttempt, SubmissionJob } from "./contracts"
import { approvedEmailAttemptRef, isSubmissionEmailProduction, parseEmailAttemptRef } from "./email-templates"
import { submissionDeliveryActor } from "./delivery-job"
import { toAttemptState } from "./jobs"
import { deliverSubmission, prepareOutgoingPackage } from "./ports"
import { assertBrokerApprovedDelivery } from "./broker-approval"
import { getDealForDocument } from "../deals/service"
import { canManageWorkspace } from "../policy"
import { autoDeliveryBlockReason, recordAutoDeliveryCancellation } from "./auto-delivery-gate"
import {
  displayCacheStatus,
  findAttempt,
  findJobById,
  insertAttempt,
  insertDealSubmissionCache,
  markOutboxProcessed,
  updateAttempt,
  updateJobRecord,
} from "./repository"

function clip(value: string | undefined, max = 2_000): string | undefined {
  if (!value) return undefined
  return value.length > max ? value.slice(0, max) : value
}

function isCompletedAttempt(state: AttemptState): boolean {
  return state === "sent" || state === "failed" || state === "skipped"
}

export function assertProductionDeliveryNotPreview(delivered: DeliverResult): void {
  if (!isSubmissionEmailProduction()) return
  const ref = parseEmailAttemptRef(delivered.externalRef)
  if (ref?.delivery === "preview") {
    throw new AppError(409, "preview_not_sent", "Preview deliveries cannot be recorded as sent in production.")
  }
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

async function settleUncertainDelivery(job: SubmissionJob): Promise<SubmissionJob> {
  const reason = "Delivery status is uncertain after an interrupted attempt. Check with the lender before creating another submission."
  await updateAttempt(job.id, job.attemptKey, { state: "failed", errorCode: "delivery_uncertain", errorMessage: reason })
  const saved = await updateJobRecord(job.workspaceId, job.id, { state: "failed", reason })
  if (job.autoSubmitDecisionId) await recordAutoDeliveryCancellation(job, "manual_retry_required")
  await refreshCache(saved)
  await markOutboxProcessed(job.id, reason)
  return saved
}

async function recoverCompletedAttempt(job: SubmissionJob, attempt: SubmissionAttempt): Promise<SubmissionJob> {
  if (!isCompletedAttempt(attempt.state)) throw new Error("Submission attempt is not complete")
  const reason = attempt.errorMessage ?? (attempt.state === "sent" ? null : job.reason ?? (attempt.state === "skipped" ? "Delivery skipped." : "Delivery failed."))
  const saved = await updateJobRecord(job.workspaceId, job.id, { state: attempt.state, reason })
  if (attempt.state === "skipped" && attempt.errorCode === "auto_submit_cancelled") {
    await recordAutoDeliveryCancellation(job, reason ?? "Automatic delivery was cancelled.")
  }
  await recordAuditEvent({ context: submissionDeliveryActor(job), action: "submission.delivery_recovered", resourceType: "submission_job", resourceId: job.id,
    metadata: { state: attempt.state, errorCode: attempt.errorCode, attemptKey: job.attemptKey, providerCorrelationId: attempt.correlationId, funderId: job.funderId }, correlationId: attempt.correlationId })
  await refreshCache(saved)
  await markOutboxProcessed(job.id)
  return saved
}

async function finishCompletedAttempt(job: SubmissionJob, attempt: SubmissionAttempt): Promise<SubmissionJob> {
  if (job.approvedPackage || process.env.MCA_SUBMISSION_COMPLETED_ATTEMPT_RECOVERY_ENABLED === "true") return recoverCompletedAttempt(job, attempt)
  const current = await findJobById(job.workspaceId, job.id)
  await markOutboxProcessed(job.id)
  return current ?? job
}

function submissionCronEnabled(): boolean {
  return process.env.MCA_JOB_RUNTIME === "vercel_cron" &&
    (process.env.MCA_JOB_RUNTIME_KINDS ?? "").split(",").some(kind => kind.trim() === "submission_delivery")
}

export async function processJobDelivery(job: SubmissionJob, options: { observeGuardedAttemptOnly?: boolean } = {}): Promise<SubmissionJob> {
  if (options.observeGuardedAttemptOnly) {
    // A provider request has already begun. Observation must never initiate another send,
    // even if the row changes between the worker's lookup and this read.
    const current = await findJobById(job.workspaceId, job.id)
    if (!current || current.state !== "sending" || !["api", "email", "custom_webhook"].includes(current.routeKind) || (!current.approvedPackage && process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED !== "true")) return current ?? job
    const attempt = await findAttempt(current.id, current.attemptKey)
    if (attempt?.state !== "sending") return current
    return Date.now() - Date.parse(attempt.createdAt) >= 10 * 60_000 ? settleUncertainDelivery(current) : current
  }
  await assertCompanyOperational(job.workspaceId)
  const existing = await findAttempt(job.id, job.attemptKey)
  if (job.state !== "queued" && job.state !== "sending") {
    // An earlier provider result may be durable while audit/cache bookkeeping is unfinished.
    // Do not replace later lender states (offered/declined/funded) with a transport receipt.
    if (job.approvedPackage && existing && isCompletedAttempt(existing.state) && job.state === existing.state) {
      const pending = await getDatabase().prepare<{ job_id: string }>("SELECT job_id FROM mca_submission_outbox WHERE job_id=? AND processed_at IS NULL").get(job.id)
      if (pending) return finishCompletedAttempt(job, existing)
    }
    await markOutboxProcessed(job.id)
    return job
  }

  const guardUnknownSend = ["api", "email", "custom_webhook"].includes(job.routeKind) && Boolean(job.approvedPackage || process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true")
  if (existing?.state === "sending" && (
    (guardUnknownSend && Date.now() - Date.parse(existing.createdAt) >= 10 * 60_000) ||
    (!guardUnknownSend && (job.autoSubmitDecisionId || submissionCronEnabled()))
  )) {
    return settleUncertainDelivery(job)
  }
  if (existing && job.approvedPackage && existing.state === "sending" && Date.now() - Date.parse(existing.createdAt) >= 10 * 60_000) {
    return settleUncertainDelivery(job)
  }
  if (existing && (job.approvedPackage || isCompletedAttempt(existing.state))) {
    if (isCompletedAttempt(existing.state)) return finishCompletedAttempt(job, existing)
    return await findJobById(job.workspaceId, job.id) ?? job
  }
  if (existing?.state === "sending" && guardUnknownSend) return await findJobById(job.workspaceId, job.id) ?? job

  const autoBlock = await autoDeliveryBlockReason(job)
  if (autoBlock) {
    if (existing) await updateAttempt(job.id, job.attemptKey, { state: "skipped", errorCode: "auto_submit_cancelled", errorMessage: autoBlock })
    const saved = await updateJobRecord(job.workspaceId, job.id, { state: "skipped", reason: autoBlock })
    await recordAutoDeliveryCancellation(job, autoBlock)
    await refreshCache(saved)
    await markOutboxProcessed(job.id, autoBlock)
    return saved
  }

  if (!existing) {
    const reserved = await insertAttempt({
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptKey: job.attemptKey,
      transport: job.routeKind,
      state: "sending",
      correlationId: newId(),
    })
    if (!reserved.created && (submissionCronEnabled() || job.approvedPackage || isCompletedAttempt(reserved.attempt.state) || guardUnknownSend)) {
      if (isCompletedAttempt(reserved.attempt.state)) return finishCompletedAttempt(job, reserved.attempt)
      return await findJobById(job.workspaceId, job.id) ?? job
    }
    await updateJobRecord(job.workspaceId, job.id, { state: "sending" })
  }

  let providerOutcomeReceived = false
  try {
    await assertBrokerApprovedDelivery(job)
    const packaged = job.approvedPackage ? { documents: job.approvedPackage.documents } : await prepareOutgoingPackage({
      originals: job.documentVersions.map((document) => ({
        documentId: document.documentId,
        originalDocumentId: document.documentId,
        checksum: document.checksum,
        byteLength: 0,
        stage: "original" as const,
      })).filter((document) => job.packageDocumentIds.includes(document.documentId)),
      funderId: job.funderId,
    })
    if (job.approvedPackage) {
      for (const document of packaged.documents) {
        const bytes = await getOutgoingDocumentBytes(document)
        if (createHash("sha256").update(bytes).digest("hex") !== document.checksum) {
          throw new AppError(409, "approved_package_changed", "The approved attachment changed. Prepare a new preview.")
        }
      }
    }
    const sending: SubmissionJob = {
      ...job,
      state: "sending",
      ...(job.approvedPackage ? { documentVersions: packaged.documents.map((document) => ({ documentId: document.documentId, checksum: document.checksum, category: job.approvedPackage!.originalVersions.find((original) => original.documentId === document.originalDocumentId)?.category ?? "other_stip" })) } : {}),
      packageDocumentIds: packaged.documents.map((document) => document.documentId),
    }
    const delivered = await deliverSubmission(sending, packaged.documents)
    if (delivered.errorCode === "company_paused" || delivered.errorCode === "company_outbound_reapproval_required") throw new AppError(delivered.errorCode === "company_paused" ? 402 : 409, delivered.errorCode, "Review this submission after company recovery.")
    assertProductionDeliveryNotPreview(delivered)
    providerOutcomeReceived = true
    const nextState: JobState = delivered.state
    const reason = clip(delivered.errorMessage) ?? (delivered.ok ? undefined : "Delivery failed.")
    await updateAttempt(job.id, job.attemptKey, {
      state: toAttemptState(nextState),
      correlationId: delivered.correlationId,
      externalRef: delivered.externalRef,
      errorCode: delivered.errorCode ?? null,
      errorMessage: clip(delivered.errorMessage) ?? null,
    })
    const saved = await updateJobRecord(job.workspaceId, job.id, {
      state: nextState,
      reason: reason ?? null,
      packageDocumentIds: packaged.documents.map((document) => document.documentId),
    })
    if (nextState === "skipped" && delivered.errorCode === "auto_submit_cancelled") await recordAutoDeliveryCancellation(job, reason ?? "Automatic delivery was cancelled.")
    await recordAuditEvent({ context: submissionDeliveryActor(job), action: "submission.delivery_recorded", resourceType: "submission_job", resourceId: job.id,
      metadata: { state: nextState, errorCode: delivered.errorCode, attemptKey: job.attemptKey, providerCorrelationId: delivered.correlationId, funderId: job.funderId }, correlationId: delivered.correlationId })
    await refreshCache(saved)
    await markOutboxProcessed(job.id)
    return saved
  } catch (error) {
    // Never erase a provider receipt or an uncertain outcome because local bookkeeping failed.
    // The reserved attempt remains sending if persistence failed, or complete for recovery.
    if (providerOutcomeReceived) throw error
    const message = error instanceof Error ? clip(error.message) : "Delivery failed."
    const errorCode = error instanceof AppError ? error.code : "delivery_failed"
    await updateAttempt(job.id, job.attemptKey, {
      state: "failed",
      errorCode,
      errorMessage: message ?? null,
    })
    const saved = await updateJobRecord(job.workspaceId, job.id, { state: "failed", reason: message ?? "Delivery failed." })
    await recordAuditEvent({ context: submissionDeliveryActor(job), action: "submission.delivery_failed", resourceType: "submission_job", resourceId: job.id,
      metadata: { errorCode, attemptKey: job.attemptKey, funderId: job.funderId }, correlationId: job.id })
    await refreshCache(saved)
    await markOutboxProcessed(job.id, message ?? null)
    if (error instanceof AppError && ["company_paused", "company_outbound_reapproval_required"].includes(error.code)) throw error
    return saved
  }
}

export async function reconcileUncertainDelivery(actor: DealActor, jobId: string, input: { outcome?: unknown; evidence?: unknown }): Promise<SubmissionJob> {
  if (actor.source !== "user" || !actor.userId || !actor.role || !canManageWorkspace(actor.role)) {
    throw new AppError(403, "broker_review_required", "A broker administrator must reconcile uncertain delivery.")
  }
  if (input.outcome !== "accepted" && input.outcome !== "not_sent") throw new AppError(422, "validation_failed", "Choose an accepted or not-sent outcome.")
  if (typeof input.evidence !== "string" || !input.evidence.trim() || input.evidence.length > 500) throw new AppError(422, "validation_failed", "Record a short provider receipt or not-sent confirmation.")
  const evidence = input.evidence.trim()
  return withTransaction(async executor => {
    await executor.prepare("SELECT id FROM mca_submission_jobs WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, jobId)
    const job = await findJobById(actor.workspaceId, jobId, executor)
    if (!job || !["email", "api", "custom_webhook"].includes(job.routeKind)) throw new AppError(404, "resource_not_found", "The requested resource was not found.")
    await getDealForDocument(actor, job.dealId)
    const attempt = await findAttempt(job.id, job.attemptKey, executor)
    if (!attempt || attempt.errorCode !== "delivery_uncertain") throw new AppError(409, "delivery_not_uncertain", "This submission has no uncertain delivery to reconcile.")
    const accepted = input.outcome === "accepted"
    const ref = parseEmailAttemptRef(attempt.externalRef) ?? approvedEmailAttemptRef(job, attempt.correlationId)
    await updateAttempt(job.id, job.attemptKey, {
      state: accepted ? "sent" : "failed",
      externalRef: accepted && ref?.delivery === "uncertain" ? JSON.stringify({ ...ref, delivery: "sent" }) : attempt.externalRef,
      errorCode: accepted ? null : "delivery_not_sent",
      errorMessage: null,
    }, executor)
    const saved = await updateJobRecord(actor.workspaceId, job.id, {
      state: accepted ? "sent" : "failed",
      reason: accepted ? null : "Provider confirmed the submission was not sent.",
    }, executor)
    await insertDealSubmissionCache({ workspaceId: job.workspaceId, dealId: job.dealId, funderName: job.displayFunderName,
      status: displayCacheStatus(saved.state), funderId: job.funderId, jobId: job.id, routeKind: job.routeKind }, executor)
    await recordAuditEvent({ context: actor, action: "submission.delivery_reconciled", resourceType: "submission_job", resourceId: job.id,
      metadata: { outcome: input.outcome, evidence, correlationId: attempt.correlationId }, correlationId: actor.correlationId, executor })
    return saved
  })
}

/** Backward-compatible email endpoint; the common reconciler also covers API/webhook attempts. */
export const reconcileUncertainEmailDelivery = reconcileUncertainDelivery
