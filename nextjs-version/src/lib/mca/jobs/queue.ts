import { recordOperationalError } from "../operations/telemetry"
import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { getDatabase, newId, nowIso } from "../db"
import type { DealActor } from "../deals/schema"
import { actorForDeals, getDealForDocument } from "../deals/service"
import { AppError } from "../errors"
import { requireLiveSupabaseSession } from "../supabase-auth"
import { API_KEY_SCOPES, type ApiKeyScope, type Role } from "../types"
import { usesSupabaseStorage } from "../documents/storage"
import { artifactChecksum, putPrivateArtifact } from "./artifacts"

const execution = new AsyncLocalStorage<boolean>()
export function inBackgroundWorker(): boolean { return execution.getStore() === true }
export function runAsBackgroundWorker<T>(callback: () => Promise<T>): Promise<T> { return execution.run(true, callback) }
export function backgroundJobsEnabled(): boolean { return process.env.MCA_BACKGROUND_JOBS === "enabled" || Boolean(process.env.VERCEL) }

export type BackgroundJobKind = "application_invitation_email" | "intake_process" | "document_upload" | "document_scan" | "draft_scan" | "submission_delivery" | "export" | "export_create" | "import_commit" | "import_update_commit" | "draft_extract" | "multipart_task" | "assistant_scan" | "email_intake" | "intake_replay" | "drive_preview" | "drive_apply"
export interface BackgroundJob {
  id: string; workspace_id: string; kind: BackgroundJobKind; resource_id: string; actor_json: string; payload_json: string
  state: "queued" | "running" | "complete" | "failed"; attempts: number; lease_token: string | null
  result_json: string | null; error_code: string | null; created_at: string; updated_at: string
}

export async function enqueueBackgroundJob(input: { actor: DealActor; kind: BackgroundJobKind; resourceId: string; idempotencyKey: string; payload?: Record<string, unknown>; payloadHash?: string }): Promise<BackgroundJob> {
  const principal = [input.actor.source, input.actor.userId, input.actor.membershipId, input.actor.apiKeyId, input.actor.sessionId]
  const scopedKey = createHash("sha256").update(JSON.stringify(principal)).update(input.idempotencyKey).digest("hex")
  const payload = JSON.stringify(input.payload ?? {})
  const hash = input.payloadHash ?? createHash("sha256").update(payload).digest("hex")
  const row = await getDatabase().prepare<BackgroundJob>(`INSERT INTO mca_background_jobs
    (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,attempts,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'queued',0,?,?,?) ON CONFLICT (workspace_id,kind,idempotency_key)
    DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE mca_background_jobs.payload_hash=EXCLUDED.payload_hash
      AND mca_background_jobs.resource_id=EXCLUDED.resource_id RETURNING *`)
    .get(newId(), input.actor.workspaceId, input.kind, input.resourceId, scopedKey, JSON.stringify(input.actor), payload, hash, nowIso(), nowIso(), nowIso())
  if (!row) throw new AppError(409, "job_idempotency_conflict", "That retry key was used for another operation.")
  // A completed retry must pass the same current authorization as the status endpoint.
  return getBackgroundJob(input.actor, row.id)
}

export async function getBackgroundJob(actor: DealActor, id: string): Promise<BackgroundJob> {
  const row = await getDatabase().prepare<BackgroundJob>("SELECT * FROM mca_background_jobs WHERE workspace_id=? AND id=?").get(actor.workspaceId, id)
  if (!row) throw new AppError(404, "job_not_found", "The requested operation was not found.")
  const owner = JSON.parse(row.actor_json) as DealActor
  // Results may contain protected data: only the submitting principal can retrieve them.
  if (owner.userId !== actor.userId || owner.membershipId !== actor.membershipId || owner.source !== actor.source || owner.apiKeyId !== actor.apiKeyId) throw new AppError(404, "job_not_found", "The requested operation was not found.")
  if (actor.source === "api_key" && (!actor.apiKeyId || !owner.scopes?.length || owner.scopes.some(scope => !actor.scopes?.includes(scope)))) {
    throw new AppError(403, "job_permission_revoked", "The submitting API key no longer has the required access.")
  }
  const payload = JSON.parse(row.payload_json)
  if (["import_commit", "import_update_commit", "drive_preview", "drive_apply"].includes(row.kind) || (row.kind === "multipart_task" && payload.endpoint !== "/api/mca/assistant/files")) {
    if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "job_permission_revoked", "Administrator access is required for this operation.")
  }
  if (row.kind === "document_scan") await (await import("../documents/service")).getDocument(actor, row.resource_id)
  if (row.kind === "document_upload") {
    const upload = await getDatabase().prepare<{ purpose: string; payload_json: string }>("SELECT purpose,payload_json FROM mca_document_uploads WHERE workspace_id=? AND id=?").get(actor.workspaceId, row.resource_id)
    if (upload?.purpose === "document") await getDealForDocument(actor, JSON.parse(upload.payload_json).dealId)
  }
  if (row.kind === "submission_delivery") {
    const submission = await (await import("../submissions/repository")).findJobById(actor.workspaceId, row.resource_id)
    if (!submission) throw new AppError(404, "job_not_found", "The operation was not found.")
    await getDealForDocument(actor, submission.dealId)
  }
  if (row.kind === "export") await (await import("../exports/service")).getExportJob(actor, row.resource_id)
  if (row.kind === "export_create") {
    const { assertCanExportKind } = await import("../exports/service")
    const { getWorkspaceSettings } = await import("../workspaces")
    assertCanExportKind(actor, payload.kind, (await getWorkspaceSettings(actor.workspaceId)).actionVisibility)
  }
  if (row.kind === "multipart_task" && payload.endpoint === "/api/mca/assistant/files" && row.state === "complete") {
    const result = JSON.parse(row.result_json ?? "null")
    if (result?.file?.id) await (await import("../assistant/files")).getFile(actor, result.file.id)
  }
  return row
}

export function backgroundJobView(job: BackgroundJob): { jobId: string; state: BackgroundJob["state"]; result?: unknown; resultUrl?: string; error?: { message: string } } {
  const result = job.state === "complete" ? JSON.parse(job.result_json ?? "null") : null
  return { jobId: job.id, state: job.state, ...(job.state === "complete" ? (result?._resultObjectKey
    ? { resultUrl: `/api/mca/jobs/${job.id}/result` } : { result }) : {}),
    ...(job.state === "failed" ? { error: { message: "Processing failed. Retry the operation or contact your administrator." } } : {}) }
}

export async function currentJobActor(actor: DealActor): Promise<DealActor> {
  if (actor.source === "api_key") {
    if (!actor.apiKeyId) throw new AppError(403, "job_permission_revoked", "The original API key identity is unavailable; an authorized user must requeue this operation.")
    const key = await getDatabase().prepare<{ scopes: string }>("SELECT scopes FROM api_keys WHERE workspace_id=? AND id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)").get(actor.workspaceId, actor.apiKeyId, nowIso())
    if (!key) throw new AppError(403, "job_permission_revoked", "The submitting API key no longer has access.")
    const priorScopes = actor.scopes
    const liveScopes: unknown = JSON.parse(key.scopes)
    if (!Array.isArray(priorScopes) || !priorScopes.length || !Array.isArray(liveScopes) ||
      priorScopes.some((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope) || !liveScopes.includes(scope))) {
      throw new AppError(403, "job_permission_revoked", "The submitting API key's access changed or its original scopes are unavailable.")
    }
    return actorForDeals({ authType: "api_key", apiKeyId: actor.apiKeyId, userId: null, membershipId: null,
      workspaceId: actor.workspaceId, role: null, scopes: [...priorScopes], sessionId: null })
  }
  if (actor.source === "system") return actor
  if (actor.source !== "user") throw new AppError(403, "job_permission_revoked", "The original operation identity is unavailable.")
  if (!actor.userId || !actor.membershipId || !actor.sessionId) throw new AppError(403, "job_permission_revoked", "The original session is unavailable; sign in and retry this operation.")
  const member = await getDatabase().prepare<{ role: Role; supabase_user_id: string }>("SELECT m.role,u.supabase_user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.id=? AND m.user_id=? AND m.status='active'")
    .get(actor.workspaceId, actor.membershipId, actor.userId)
  if (!member?.supabase_user_id) throw new AppError(403, "job_permission_revoked", "The submitting member no longer has access.")
  await requireLiveSupabaseSession(actor.sessionId, member.supabase_user_id)
  return actorForDeals({ authType: "session", userId: actor.userId, membershipId: actor.membershipId, workspaceId: actor.workspaceId, role: member.role, scopes: [...actor.scopes ?? []], sessionId: actor.sessionId })
}

export async function claimBackgroundJob(): Promise<BackgroundJob | undefined> {
  const now = nowIso()
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='failed',error_code='retry_limit',updated_at=? WHERE state='running' AND lease_expires_at<? AND attempts>=3").run(now, now)
  return getDatabase().prepare<BackgroundJob>(`WITH candidate AS (
    SELECT id FROM mca_background_jobs WHERE ((state='queued' AND available_at<=?) OR (state='running' AND lease_expires_at<?)) AND attempts<3
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE mca_background_jobs j SET state='running',attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
    FROM candidate c WHERE j.id=c.id RETURNING j.*`).get(now, now, newId(), new Date(Date.now() + 600_000).toISOString(), now)
}

export async function heartbeatBackgroundJob(job: BackgroundJob): Promise<void> {
  const result = await getDatabase().prepare("UPDATE mca_background_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
    .run(new Date(Date.now() + 600_000).toISOString(), nowIso(), job.id, job.lease_token)
  if (!result.changes) throw new Error("background_job_lease_lost")
}

export async function completeBackgroundJob(job: BackgroundJob, result: unknown): Promise<void> {
  let serialized = JSON.stringify(result ?? null)
  if (usesSupabaseStorage() && Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
    const bytes = Buffer.from(serialized), checksum = artifactChecksum(bytes)
    const key = `${job.workspace_id}/jobs/${job.id}/${checksum}`
    await putPrivateArtifact(key, bytes, "application/json")
    serialized = JSON.stringify({ _resultObjectKey: key, checksum })
  }
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete',result_json=?,lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
    .run(serialized, nowIso(), job.id, job.lease_token)
}

export async function failBackgroundJob(job: BackgroundJob, error: unknown): Promise<void> {
  const permanent = error instanceof AppError && error.status < 500
  const state = permanent || job.attempts >= 3 ? "failed" : "queued"
  const saved = await getDatabase().prepare("UPDATE mca_background_jobs SET state=?,error_code=?,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?")
    .run(state, error instanceof AppError ? error.code : "processing_failed", new Date(Date.now() + 30_000 * job.attempts).toISOString(), nowIso(), job.id, job.lease_token)
  if (saved.changes > 0 && state === "failed") await recordOperationalError("worker", "job_failed")
}
