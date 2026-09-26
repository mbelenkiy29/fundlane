import "server-only"

import { createHash } from "node:crypto"
import { getOutgoingDocumentBytes } from "./compress"
import { newId } from "../db"
import { AppError } from "../errors"
import { assertCompanyOperational } from "../company-access"
import type { AttemptState, DeliverResult, JobState, SubmissionJob } from "./contracts"
import { isSubmissionEmailProduction, parseEmailAttemptRef } from "./email-templates"
import { toAttemptState } from "./jobs"
import { deliverSubmission, prepareOutgoingPackage } from "./ports"
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

export async function processJobDelivery(job: SubmissionJob, options: { observeGuardedAttemptOnly?: boolean } = {}): Promise<SubmissionJob> {
  if (options.observeGuardedAttemptOnly) {
    // A provider request has already begun. Observation must never initiate another send,
    // even if the row changes between the worker's lookup and this read.
    const current = await findJobById(job.workspaceId, job.id)
    if (!current || current.state !== "sending" || current.routeKind !== "api" || process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED !== "true") return current ?? job
    const attempt = await findAttempt(current.id, current.attemptKey)
    if (attempt?.state !== "sending") return current
    return Date.now() - Date.parse(attempt.createdAt) >= 10 * 60_000 ? settleUncertainDelivery(current) : current
  }
  await assertCompanyOperational(job.workspaceId)
  if (job.state !== "queued" && job.state !== "sending") {
    await markOutboxProcessed(job.id)
    return job
  }

  const existing = await findAttempt(job.id, job.attemptKey)
  const guardUnknownSend = job.routeKind === "api" && process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true"
  if (existing?.state === "sending" && (
    (guardUnknownSend && Date.now() - Date.parse(existing.createdAt) >= 10 * 60_000) ||
    (!guardUnknownSend && (job.autoSubmitDecisionId || process.env.MCA_JOB_RUNTIME === "vercel_cron"))
  )) {
    return settleUncertainDelivery(job)
  }
  if (existing && job.approvedPackage && existing.state === "sending" && Date.now() - Date.parse(existing.createdAt) >= 10 * 60_000) {
    return settleUncertainDelivery(job)
  }
  if (existing && (job.approvedPackage || isCompletedAttempt(existing.state))) {
    const current = await findJobById(job.workspaceId, job.id)
    if (isCompletedAttempt(existing.state)) await markOutboxProcessed(job.id)
    return current ?? job
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
    if (!reserved.created && (process.env.MCA_JOB_RUNTIME === "vercel_cron" || job.approvedPackage || isCompletedAttempt(reserved.attempt.state) || guardUnknownSend)) {
      const current = await findJobById(job.workspaceId, job.id)
      if (isCompletedAttempt(reserved.attempt.state)) await markOutboxProcessed(job.id)
      return current ?? job
    }
    await updateJobRecord(job.workspaceId, job.id, { state: "sending" })
  }

  try {
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
    await refreshCache(saved)
    await markOutboxProcessed(job.id)
    return saved
  } catch (error) {
    const message = error instanceof Error ? clip(error.message) : "Delivery failed."
    const errorCode = error instanceof AppError ? error.code : "delivery_failed"
    await updateAttempt(job.id, job.attemptKey, {
      state: "failed",
      errorCode,
      errorMessage: message ?? null,
    })
    const saved = await updateJobRecord(job.workspaceId, job.id, { state: "failed", reason: message ?? "Delivery failed." })
    await refreshCache(saved)
    await markOutboxProcessed(job.id, message ?? null)
    if (error instanceof AppError && ["company_paused", "company_outbound_reapproval_required"].includes(error.code)) throw error
    return saved
  }
}
