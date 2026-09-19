import "server-only"

import { newId } from "../db"
import { AppError } from "../errors"
import type { AttemptState, DeliverResult, JobState, SubmissionJob } from "./contracts"
import { isSubmissionEmailProduction, parseEmailAttemptRef } from "./email-templates"
import { toAttemptState } from "./jobs"
import { deliverSubmission, prepareOutgoingPackage } from "./ports"
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

export async function processJobDelivery(job: SubmissionJob): Promise<SubmissionJob> {
  if (job.state !== "queued" && job.state !== "sending") {
    await markOutboxProcessed(job.id)
    return job
  }

  const existing = await findAttempt(job.id, job.attemptKey)
  if (existing && isCompletedAttempt(existing.state)) {
    const current = await findJobById(job.workspaceId, job.id)
    await markOutboxProcessed(job.id)
    return current ?? job
  }

  if (!existing) {
    await updateJobRecord(job.workspaceId, job.id, { state: "sending" })
    const reserved = await insertAttempt({
      workspaceId: job.workspaceId,
      jobId: job.id,
      attemptKey: job.attemptKey,
      transport: job.routeKind,
      state: "sending",
      correlationId: newId(),
    })
    if (!reserved.created && isCompletedAttempt(reserved.attempt.state)) {
      const current = await findJobById(job.workspaceId, job.id)
      await markOutboxProcessed(job.id)
      return current ?? job
    }
  }

  try {
    const packaged = await prepareOutgoingPackage({
      originals: job.documentVersions.map((document) => ({
        documentId: document.documentId,
        originalDocumentId: document.documentId,
        checksum: document.checksum,
        byteLength: 0,
        stage: "original" as const,
      })).filter((document) => job.packageDocumentIds.includes(document.documentId)),
      funderId: job.funderId,
    })
    const sending: SubmissionJob = {
      ...job,
      state: "sending",
      packageDocumentIds: packaged.documents.map((document) => document.documentId),
    }
    const delivered = await deliverSubmission(sending, packaged.documents)
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
    return saved
  }
}
