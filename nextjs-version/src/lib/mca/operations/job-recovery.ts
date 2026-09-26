import "server-only"
import { z } from "zod"
import { getDatabase, nowIso, recordAuditEvent, withImmediateTransaction } from "../db"
import { AppError } from "../errors"
import { safeIdentifier } from "./contracts"

export const recoveryActionSchema = z.object({
  action: z.enum(["replay", "external_effect_confirmed", "external_effect_absent"]),
})

// These stages have no outbound message, payment, or lender submission side effect.
const replayable = new Set(["document_scan", "draft_scan", "assistant_scan", "document_upload", "export", "export_create"])

export async function failedJobs(workspaceId: string) {
  return getDatabase().prepare<{ id: string; kind: string; resource_id: string; attempts: number; error_code: string | null; updated_at: string }>(
    "SELECT id,kind,resource_id,attempts,error_code,updated_at FROM mca_background_jobs WHERE workspace_id=? AND state='failed' ORDER BY updated_at DESC,id LIMIT 100"
  ).all(workspaceId)
}

export async function recoverFailedJob(workspaceId: string, jobId: string, actorUserId: string, action: z.infer<typeof recoveryActionSchema>["action"]) {
  return withImmediateTransaction(async db => {
    const job = await db.prepare<{ id: string; kind: string; state: string; error_code: string | null }>(
      "SELECT id,kind,state,error_code FROM mca_background_jobs WHERE workspace_id=? AND id=? FOR UPDATE"
    ).get(workspaceId, jobId)
    if (!job) throw new AppError(404, "job_not_found", "Job not found in this company.")
    if (job.state !== "failed") throw new AppError(409, "job_not_failed", "Only failed jobs can be reviewed.")
    if (action === "replay") {
      if (!replayable.has(job.kind) || job.error_code === "company_paused")
        throw new AppError(409, "replay_requires_review", "This job requires a new reviewed request or provider reconciliation.")
      await db.prepare("UPDATE mca_background_jobs SET state='queued',attempts=0,error_code=NULL,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='failed'")
        .run(nowIso(), nowIso(), workspaceId, jobId)
    } else {
      // Retain the failed intent and idempotency key. A provider receipt or confirmed
      // absence is evidence for the operator; neither decision initiates a send.
      await db.prepare("UPDATE mca_background_jobs SET error_code=?,updated_at=? WHERE workspace_id=? AND id=? AND state='failed'")
        .run(action, nowIso(), workspaceId, jobId)
    }
    await recordAuditEvent({ context: { workspaceId, userId: actorUserId }, action: `jobs.platform_${action}`, resourceType: "background_job", resourceId: jobId, metadata: { kind: safeIdentifier(job.kind), previousErrorCode: safeIdentifier(job.error_code) }, executor: db })
    return { jobId, kind: job.kind, state: action === "replay" ? "queued" : "failed", resolution: action }
  })
}
