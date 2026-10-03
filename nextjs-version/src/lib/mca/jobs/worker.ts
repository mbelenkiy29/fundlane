import "server-only"

import { getDatabase, nowIso, parseJson } from "../db"
import { enqueueSubmissionDelivery } from "../submissions/delivery-job"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { getDealForDocument } from "../deals/service"
import { processDirectUpload } from "../documents/direct-uploads"
import { findDocumentById } from "../documents/repository"
import { documentScanActor } from "../documents/scan-job"
import { retryDocumentScan } from "../documents/service"
import { extractApplicationDraft, retryApplicationDraftScan } from "../documents/application-drafts"
import { findJobById } from "../submissions/repository"
import { processJobDelivery } from "../submissions/outbox"
import { createExportJob, processExportJob } from "../exports/service"
import type { CreateExportInput } from "../exports/contracts"
import { commitCsvUpdate, commitSpreadsheetImport } from "../imports/service"
import { claimBackgroundJob, completeBackgroundJob, currentJobActor, deferBackgroundJob, failBackgroundJob, heartbeatBackgroundJob, runAsBackgroundWorker, type BackgroundJob, type BackgroundJobKind } from "./queue"
import { processMultipartTask } from "./multipart"
import { quarantineBucket, storageClient, validateStorageKey } from "../documents/storage"
import { documentScanner } from "../documents/scanner"
import { processQueuedEmail, replayEmailIntake } from "../intake/email"
import { replayIntake } from "../intake/service"
import { previewDrivePackage, applyDriveDocuments } from "../imports/drive-service"
import { assertCompanyOperational, getCompanyAccess } from "../company-access"
import { assertOutboundFresh } from "../outbound-freshness"
import { withOutboundApproval } from "../outbound-approval"
import { executionSignal, outsideExecutionScope, withExecutionDeadline } from "./execution"
import { documentRuntimeEnabled } from "./document-runtime"

async function dispatch(job: BackgroundJob, observeGuardedAttemptOnly = false): Promise<unknown> {
  await assertCompanyOperational(job.workspace_id)
  if (!observeGuardedAttemptOnly && ["auto_submit", "submission_delivery", "application_invitation_email", "application_invitation_reminder"].includes(job.kind)) assertOutboundFresh(job.created_at)
  if (job.kind === "intake_process") return (await import("../intake/processing")).processIntakeJob(job)
  if (job.kind === "application_invitation_reminder") return (await import("../applications/reminders")).processInvitationReminder(job)
  if (job.kind === "document_scan") {
    const record = await findDocumentById(job.workspace_id, job.resource_id)
    if (!record) throw new AppError(404, "document_not_found", "The requested document was not found.")
    const result = await retryDocumentScan(documentScanActor(record), job.resource_id)
    if (documentRuntimeEnabled() && (result.processingState === "pending_scan" || result.processingState === "scan_failed")) throw new AppError(503, "scanner_unavailable", "The scanner could not verify this document. Retry after restoring the scanner.")
    return result
  }
  const actor = await currentJobActor(JSON.parse(job.actor_json) as DealActor)
  const payload = JSON.parse(job.payload_json)
  switch (job.kind) {
    case "auto_submit": return (await import("../underwriting/auto-submit")).processAutoSubmit(actor, job.resource_id, payload.completenessVersion, payload.mode, payload.dealVersion)
    case "deal_agent": return (await import("../deal-agent/run")).processDealAgentJob(job, actor)
    case "application_invitation_email": return (await import("../applications/service")).processInvitationEmail(actor, job)
    case "drive_preview":
    case "drive_apply": {
      if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "job_permission_revoked", "Administrator access is required for imports.")
      return job.kind === "drive_preview" ? previewDrivePackage(actor, payload) : applyDriveDocuments(actor, payload)
    }
    case "email_intake": return processQueuedEmail(actor, job.resource_id, payload)
    case "intake_replay": return payload.reviewedApplication ? replayEmailIntake(actor, job.resource_id, { appOrigin: payload.appOrigin, reviewedApplication: payload.reviewedApplication }) : replayIntake(actor, job.resource_id, payload.appOrigin)
    case "assistant_scan": {
      if (!job.resource_id.startsWith(`${job.workspace_id}/scans/`)) throw new AppError(403, "scan_scope_invalid", "The scan object is outside its company.")
      const { data, error } = await storageClient().storage.from(quarantineBucket()).download(validateStorageKey(job.resource_id))
      if (error || !data) throw new AppError(503, "scanner_unavailable", "The staged file could not be read.")
      if (data.size > 25 * 1024 * 1024) throw new AppError(413, "file_limit", "The staged file exceeds the size limit.")
      const result = await documentScanner().scan(new Uint8Array(await data.arrayBuffer()), payload.filename)
      if (documentRuntimeEnabled() && (result.status === "unavailable" || result.status === "error")) throw new AppError(503, "scanner_unavailable", "The scanner could not verify this file. Retry after restoring the scanner.")
      return result
    }
    case "multipart_task": return processMultipartTask(actor, payload)
    case "document_upload": {
      const result = await processDirectUpload(job.workspace_id, job.resource_id)
      if (documentRuntimeEnabled() && result && typeof result === "object" && "processingState" in result && ["pending_scan", "scan_failed"].includes(String(result.processingState))) throw new AppError(503, "scanner_unavailable", "The scanner could not verify this upload. Retry after restoring the scanner.")
      return result
    }
    case "draft_scan": {
      const result = await retryApplicationDraftScan(actor, job.resource_id)
      if (documentRuntimeEnabled() && ["pending_scan", "scan_failed"].includes(result.processingState)) throw new AppError(503, "scanner_unavailable", "The scanner could not verify this draft. Retry after restoring the scanner.")
      return result
    }
    case "draft_extract": return extractApplicationDraft(actor, job.resource_id, payload.approvedFields)
    case "export_create": return createExportJob(actor, payload as CreateExportInput)
    case "export": return { job: await processExportJob(actor, job.resource_id) }
    case "import_commit":
    case "import_update_commit": {
      if (!actor.role || !["admin", "super_admin"].includes(actor.role)) throw new AppError(403, "job_permission_revoked", "Administrator access is required for imports.")
      const fn = job.kind === "import_commit" ? commitSpreadsheetImport : commitCsvUpdate
      return fn(actor, { runId: job.resource_id, expectedPreviewRevision: payload.expectedPreviewRevision })
    }
    case "submission_delivery": {
      const submission = await findJobById(job.workspace_id, job.resource_id)
      if (!submission) throw new AppError(404, "submission_not_found", "Submission not found.")
      await getDealForDocument(actor, submission.dealId)
      return processJobDelivery(submission, { observeGuardedAttemptOnly })
    }
  }
}

const reportedLegacySubmissions = new Set<string>()
/** New outbox/job inserts are atomic. Older rows lack durable session/key provenance and require review. */
export async function recoverSubmissionOutbox(): Promise<number> {
  const rows = await getDatabase().prepare<{ id: string; workspace_id: string; deal_id: string; payload_json: string }>(`SELECT j.id, j.workspace_id, j.deal_id, o.payload_json FROM mca_submission_jobs j
    JOIN mca_submission_outbox o ON o.job_id=j.id WHERE o.processed_at IS NULL AND j.state IN ('queued','sending')
    AND NOT EXISTS (SELECT 1 FROM mca_background_jobs b WHERE b.kind='submission_delivery' AND b.resource_id=j.id) ORDER BY o.created_at LIMIT 20`).all()
  let enqueued = 0
  for (const row of rows) {
    if (!(await getCompanyAccess(row.workspace_id)).allowed) continue
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
    const actor = payload.actor
    const actorWorkspaceId = actor && typeof actor === "object" && !Array.isArray(actor)
      ? (actor as { workspaceId?: unknown }).workspaceId
      : undefined
    if (typeof actorWorkspaceId !== "string" || actorWorkspaceId !== row.workspace_id) {
      if (reportedLegacySubmissions.has(row.id)) continue
      reportedLegacySubmissions.add(row.id)
      console.error(JSON.stringify({ event: "legacy_submission_requires_review", jobId: row.id, code: "original_authority_unavailable" }))
      continue
    }
    await enqueueSubmissionDelivery({ workspaceId: row.workspace_id, dealId: row.deal_id, id: row.id })
    enqueued += 1
  }
  return enqueued
}

export async function touchDocumentWorkerHeartbeat(): Promise<void> {
  await getDatabase().prepare("UPDATE mca_private.ops_control SET document_worker_heartbeat_at=? WHERE id").run(nowIso())
}

async function guardedSendingAttempt(job: BackgroundJob): Promise<{ created_at: string } | undefined> {
  if (job.kind !== "submission_delivery") return undefined
  return getDatabase().prepare<{ created_at: string }>(`SELECT a.created_at FROM mca_submission_jobs s
    JOIN mca_submission_attempts a ON a.job_id=s.id AND a.attempt_key=s.attempt_key AND a.state='sending'
    JOIN mca_submission_outbox o ON o.job_id=s.id AND o.processed_at IS NULL
    WHERE s.id=? AND s.workspace_id=? AND s.route_kind IN ('api','email','custom_webhook') AND s.state='sending'
      AND (s.approved_package_cipher IS NOT NULL OR ?)`)
    .get(job.resource_id, job.workspace_id, process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED === "true")
}

export async function runNextBackgroundJob(kinds?: readonly BackgroundJobKind[]): Promise<boolean> {
  const job = await claimBackgroundJob(kinds)
  if (!job) return false
  const heartbeat = setInterval(() => { void (async () => {
    await heartbeatBackgroundJob(job)
    if (["document_upload", "document_scan", "draft_scan", "draft_extract", "assistant_scan", "intake_process"].includes(job.kind)) await touchDocumentWorkerHeartbeat()
  })().catch(() => { console.error(JSON.stringify({ event: "worker_heartbeat_failed", jobId: job.id })) }) }, 30_000)
  try {
    if (job.kind === "application_invitation_email" || job.kind === "application_invitation_reminder") {
      job.result_json = await (await import("../applications/service")).markVercelInvitationClaim(job)
    }
    const outbound = ["auto_submit", "submission_delivery", "application_invitation_email", "application_invitation_reminder"].includes(job.kind)
    const observeOnly = Boolean(await guardedSendingAttempt(job))
    const result = await runAsBackgroundWorker(() => outbound && !observeOnly ? withOutboundApproval(job.workspace_id, job.created_at, () => dispatch(job)) : dispatch(job, observeOnly))
    if (job.kind === "submission_delivery") {
      const pending = await guardedSendingAttempt(job)
      if (pending) {
        const dueAt = new Date(Math.max(Date.now() + 1_000, Date.parse(pending.created_at) + 10 * 60_000)).toISOString()
        await deferBackgroundJob(job, dueAt)
        return true
      }
      // If an observation raced with another state change, revisit through the
      // ordinary dispatch path instead of completing an unprocessed outbox.
      if (observeOnly && result && typeof result === "object" && "state" in result && ["queued", "sending"].includes(String(result.state))) {
        await deferBackgroundJob(job, new Date(Date.now() + 1_000).toISOString())
        return true
      }
    }
    await completeBackgroundJob(job, result)
    console.info(JSON.stringify({ event: "worker_job_completed", jobId: job.id, kind: job.kind }))
  } catch (error) {
    // Give lease cleanup its own short deadline after the work deadline expires.
    // The original scope would reject every cleanup write once it is aborted.
    const boundedCleanup = Boolean(executionSignal())
    await outsideExecutionScope(() => boundedCleanup
      ? withExecutionDeadline(() => failBackgroundJob(job, error), undefined, 10_000)
      : failBackgroundJob(job, error))
    console.error(JSON.stringify({ event: "worker_job_failed", jobId: job.id, kind: job.kind, code: error instanceof AppError ? error.code : "processing_failed" }))
  } finally { clearInterval(heartbeat) }
  return true
}
