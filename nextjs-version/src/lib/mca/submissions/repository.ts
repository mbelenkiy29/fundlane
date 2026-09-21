import "server-only"

import { encryptSensitive, decryptSensitive } from "../crypto"
import { getDatabase, newId, parseJson, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealActor } from "../deals/schema"
import type { FunderRoute, FunderRouteKind } from "../funders/contracts"
import { nowIso } from "./clock"
import type { AttemptState, JobState, SubmissionAttempt, SubmissionJob } from "./contracts"

function db(): DbExecutor {
  return getDatabase()
}

type JobRow = {
  id: string
  workspace_id: string
  deal_id: string
  funder_id: string
  display_funder_name: string
  route_kind: string
  route_json: string
  state: string
  confirmation_key: string
  attempt_key: string
  analysis_run_id: string | null
  deal_version: number
  document_versions_json: string
  package_json: string
  preflight_errors_json: string
  merchant_identity_key: string
  package_fingerprint: string
  approved_package_cipher: string | null
  reason: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

type AttemptRow = {
  id: string
  workspace_id: string
  job_id: string
  attempt_key: string
  transport: string
  state: string
  correlation_id: string
  external_ref: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
}

type OutboxRow = {
  id: string
  workspace_id: string
  job_id: string
  payload_json: string
  available_at: string
  attempts: number
  processed_at: string | null
  last_error: string | null
  created_at: string
}

export interface JobInsert {
  workspaceId: string
  dealId: string
  funderId: string
  displayFunderName: string
  routeKind: FunderRouteKind
  route: FunderRoute
  state: JobState
  confirmationKey: string
  attemptKey: string
  analysisRunId?: string
  dealVersion: number
  documentVersions: SubmissionJob["documentVersions"]
  packageDocumentIds: string[]
  preflightErrors: Array<{ field: string; message: string }>
  merchantIdentityKey: string
  packageFingerprint: string
  approvedPackage?: SubmissionJob["approvedPackage"]
  reason?: string
  createdByUserId: string | null
  actor?: DealActor
}

export interface OutboxRecord {
  id: string
  workspaceId: string
  jobId: string
  payload: Record<string, unknown>
  availableAt: string
  attempts: number
  processedAt?: string
  lastError?: string
  createdAt: string
}

function fromJobRow(row: JobRow): SubmissionJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    funderId: row.funder_id,
    displayFunderName: row.display_funder_name,
    routeKind: row.route_kind as FunderRouteKind,
    route: parseJson<FunderRoute>(row.route_json, {
      id: "missing-route",
      kind: row.route_kind as FunderRouteKind,
      label: "Missing route",
      destination: "",
      documentExceptions: [],
      active: false,
    }),
    state: row.state as JobState,
    confirmationKey: row.confirmation_key,
    attemptKey: row.attempt_key,
    analysisRunId: row.analysis_run_id ?? undefined,
    dealVersion: Number(row.deal_version),
    documentVersions: parseJson(row.document_versions_json, []),
    packageDocumentIds: parseJson<{ documentIds?: string[] }>(row.package_json, {}).documentIds ?? parseJson<string[]>(row.package_json, []),
    preflightErrors: parseJson(row.preflight_errors_json, []),
    merchantIdentityKey: row.merchant_identity_key,
    packageFingerprint: row.package_fingerprint,
    approvedPackage: row.approved_package_cipher ? JSON.parse(decryptSensitive(row.approved_package_cipher, row.workspace_id)) : undefined,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function fromAttemptRow(row: AttemptRow): SubmissionAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    attemptKey: row.attempt_key,
    transport: row.transport as FunderRouteKind,
    state: row.state as AttemptState,
    correlationId: row.correlation_id,
    externalRef: row.external_ref ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  }
}

function fromOutboxRow(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobId: row.job_id,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    availableAt: row.available_at,
    attempts: Number(row.attempts),
    processedAt: row.processed_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
  }
}

export async function findJobById(workspaceId: string, jobId: string, executor: DbExecutor = db()): Promise<SubmissionJob | undefined> {
  const row = await executor.prepare<JobRow>("SELECT * FROM mca_submission_jobs WHERE workspace_id = ? AND id = ?").get(workspaceId, jobId)
  return row ? fromJobRow(row) : undefined
}

export async function findJobByConfirmation(
  workspaceId: string,
  confirmationKey: string,
  funderId: string,
  executor: DbExecutor = db(),
): Promise<SubmissionJob | undefined> {
  const row = await executor.prepare<JobRow>(
    "SELECT * FROM mca_submission_jobs WHERE workspace_id = ? AND confirmation_key = ? AND funder_id = ?",
  ).get(workspaceId, confirmationKey, funderId)
  return row ? fromJobRow(row) : undefined
}

export async function listJobsForDeal(workspaceId: string, dealId: string, executor: DbExecutor = db()): Promise<SubmissionJob[]> {
  const rows = await executor.prepare<JobRow>(
    "SELECT * FROM mca_submission_jobs WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at DESC, id DESC",
  ).all(workspaceId, dealId)
  return rows.map(fromJobRow)
}

export async function insertJob(input: JobInsert, executor: DbExecutor = db()): Promise<{ job: SubmissionJob; created: boolean }> {
  const now = nowIso()
  const id = newId()
  const row = await executor.prepare<{ id: string }>(`INSERT INTO mca_submission_jobs
    (id, workspace_id, deal_id, funder_id, display_funder_name, route_kind, route_json, state, confirmation_key, attempt_key,
     analysis_run_id, deal_version, document_versions_json, package_json, preflight_errors_json, merchant_identity_key, package_fingerprint,
     reason, created_by_user_id, created_at, updated_at, approved_package_cipher)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, confirmation_key, funder_id) DO NOTHING
    RETURNING id`).get(
    id,
    input.workspaceId,
    input.dealId,
    input.funderId,
    input.displayFunderName,
    input.routeKind,
    JSON.stringify(input.route),
    input.state,
    input.confirmationKey,
    input.attemptKey,
    input.analysisRunId ?? null,
    input.dealVersion,
    JSON.stringify(input.documentVersions),
    JSON.stringify({ documentIds: input.packageDocumentIds }),
    JSON.stringify(input.preflightErrors),
    input.merchantIdentityKey,
    input.packageFingerprint,
    input.reason ?? null,
    input.createdByUserId,
    now,
    now,
    input.approvedPackage ? encryptSensitive(JSON.stringify(input.approvedPackage), input.workspaceId) : null,
  )
  if (!row) {
    const existing = await findJobByConfirmation(input.workspaceId, input.confirmationKey, input.funderId, executor)
    if (!existing) throw new Error("Submission job insert conflicted but no idempotent record was found")
    return { job: existing, created: false }
  }
  const job = await findJobById(input.workspaceId, row.id, executor)
  if (!job) throw new Error("Submission job insert did not return a persisted row")
  return { job, created: true }
}

export async function updateJobRecord(
  workspaceId: string,
  jobId: string,
  patch: { state: JobState; reason?: string | null; packageDocumentIds?: string[] },
  executor: DbExecutor = db(),
): Promise<SubmissionJob> {
  const current = await findJobById(workspaceId, jobId, executor)
  if (!current) throw new Error("Submission job not found")
  const packageJson = patch.packageDocumentIds
    ? JSON.stringify({ documentIds: patch.packageDocumentIds })
    : JSON.stringify({ documentIds: current.packageDocumentIds })
  await executor.prepare(`UPDATE mca_submission_jobs
    SET state = ?, reason = ?, package_json = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    patch.state,
    patch.reason === undefined ? current.reason ?? null : patch.reason,
    packageJson,
    nowIso(),
    workspaceId,
    jobId,
  )
  const saved = await findJobById(workspaceId, jobId, executor)
  if (!saved) throw new Error("Submission job not found after update")
  return saved
}

export async function findAttempt(jobId: string, attemptKey: string, executor: DbExecutor = db()): Promise<SubmissionAttempt | undefined> {
  const row = await executor.prepare<AttemptRow>(
    "SELECT * FROM mca_submission_attempts WHERE job_id = ? AND attempt_key = ?",
  ).get(jobId, attemptKey)
  return row ? fromAttemptRow(row) : undefined
}

export async function listAttemptsForJob(jobId: string, executor: DbExecutor = db()): Promise<SubmissionAttempt[]> {
  const rows = await executor.prepare<AttemptRow>(
    "SELECT * FROM mca_submission_attempts WHERE job_id = ? ORDER BY created_at ASC, id ASC",
  ).all(jobId)
  return rows.map(fromAttemptRow)
}

export async function insertAttempt(input: {
  workspaceId: string
  jobId: string
  attemptKey: string
  transport: FunderRouteKind
  state: AttemptState
  correlationId: string
  externalRef?: string
  errorCode?: string
  errorMessage?: string
}, executor: DbExecutor = db()): Promise<{ attempt: SubmissionAttempt; created: boolean }> {
  const now = nowIso()
  const id = newId()
  const row = await executor.prepare<{ id: string }>(`INSERT INTO mca_submission_attempts
    (id, workspace_id, job_id, attempt_key, transport, state, correlation_id, external_ref, error_code, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (job_id, attempt_key) DO NOTHING
    RETURNING id`).get(
    id,
    input.workspaceId,
    input.jobId,
    input.attemptKey,
    input.transport,
    input.state,
    input.correlationId,
    input.externalRef ?? null,
    input.errorCode ?? null,
    input.errorMessage ?? null,
    now,
  )
  if (!row) {
    const existing = await findAttempt(input.jobId, input.attemptKey, executor)
    if (!existing) throw new Error("Submission attempt insert conflicted but no idempotent record was found")
    return { attempt: existing, created: false }
  }
  const attempt = await findAttempt(input.jobId, input.attemptKey, executor)
  if (!attempt) throw new Error("Submission attempt insert did not return a persisted row")
  return { attempt, created: true }
}

export async function updateAttempt(
  jobId: string,
  attemptKey: string,
  patch: {
    state: AttemptState
    correlationId?: string
    externalRef?: string
    errorCode?: string | null
    errorMessage?: string | null
  },
  executor: DbExecutor = db(),
): Promise<SubmissionAttempt> {
  await executor.prepare(`UPDATE mca_submission_attempts
    SET state = ?, correlation_id = COALESCE(?, correlation_id), external_ref = ?, error_code = ?, error_message = ?
    WHERE job_id = ? AND attempt_key = ?`).run(
    patch.state,
    patch.correlationId ?? null,
    patch.externalRef ?? null,
    patch.errorCode === undefined ? null : patch.errorCode,
    patch.errorMessage === undefined ? null : patch.errorMessage,
    jobId,
    attemptKey,
  )
  const saved = await findAttempt(jobId, attemptKey, executor)
  if (!saved) throw new Error("Submission attempt not found after update")
  return saved
}

export async function insertOutbox(input: {
  workspaceId: string
  jobId: string
  payload: Record<string, unknown>
  processedAt?: string
}, executor: DbExecutor = db()): Promise<OutboxRecord> {
  const now = nowIso()
  const id = newId()
  const row = await executor.prepare<{ id: string }>(`INSERT INTO mca_submission_outbox
    (id, workspace_id, job_id, payload_json, available_at, attempts, processed_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)
    ON CONFLICT (job_id) DO NOTHING
    RETURNING id`).get(
    id,
    input.workspaceId,
    input.jobId,
    JSON.stringify(input.payload),
    now,
    input.processedAt ?? null,
    now,
  )
  const saved = await findOutboxByJob(input.jobId, executor)
  if (!saved) throw new Error(row ? "Submission outbox insert did not return a persisted row" : "Submission outbox conflicted but no row was found")
  return saved
}

export async function findOutboxByJob(jobId: string, executor: DbExecutor = db()): Promise<OutboxRecord | undefined> {
  const row = await executor.prepare<OutboxRow>("SELECT * FROM mca_submission_outbox WHERE job_id = ?").get(jobId)
  return row ? fromOutboxRow(row) : undefined
}

export async function markOutboxProcessed(jobId: string, lastError?: string | null, executor: DbExecutor = db()): Promise<void> {
  await executor.prepare(`UPDATE mca_submission_outbox
    SET processed_at = ?, attempts = attempts + 1, last_error = ?
    WHERE job_id = ?`).run(nowIso(), lastError ?? null, jobId)
}

export async function insertDealSubmissionCache(input: {
  workspaceId: string
  dealId: string
  funderName: string
  status: string
  funderId: string
  jobId: string
  routeKind: FunderRouteKind
}, executor: DbExecutor = db()): Promise<void> {
  const existing = await executor.prepare<{ id: string }>(
    "SELECT id FROM deal_submissions WHERE workspace_id = ? AND job_id = ?",
  ).get(input.workspaceId, input.jobId)
  if (existing) {
    await executor.prepare(`UPDATE deal_submissions
      SET funder_name = ?, status = ?, funder_id = ?, route_kind = ?
      WHERE workspace_id = ? AND job_id = ?`).run(
      input.funderName, input.status, input.funderId, input.routeKind, input.workspaceId, input.jobId,
    )
    return
  }
  await executor.prepare(`INSERT INTO deal_submissions
    (id, workspace_id, deal_id, funder_name, status, funder_id, job_id, route_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId(), input.workspaceId, input.dealId, input.funderName, input.status, input.funderId, input.jobId, input.routeKind,
  )
}

export async function persistNewDestination(input: JobInsert): Promise<{ job: SubmissionJob; created: boolean }> {
  return withImmediateTransaction(async (executor) => {
    const saved = await insertJob(input, executor)
    if (!saved.created) return saved
    const processedAt = input.state === "queued" ? undefined : nowIso()
    await insertOutbox({
      workspaceId: input.workspaceId,
      jobId: saved.job.id,
      payload: {
        jobId: saved.job.id,
        dealId: input.dealId,
        funderId: input.funderId,
        confirmationKey: input.confirmationKey,
        attemptKey: input.attemptKey,
        ...(input.actor ? { actor: input.actor } : {}),
      },
      processedAt,
    }, executor)
    await insertDealSubmissionCache({
      workspaceId: input.workspaceId,
      dealId: input.dealId,
      funderName: input.displayFunderName,
      status: displayCacheStatus(input.state),
      funderId: input.funderId,
      jobId: saved.job.id,
      routeKind: input.routeKind,
    }, executor)
    return saved
  })
}

export function displayCacheStatus(state: JobState): string {
  if (state === "sent") return "sent"
  if (state === "declined") return "declined"
  if (state === "funded") return "approved"
  if (state === "preflight_failed" || state === "failed" || state === "blocked_duplicate") return "errored"
  return "queued"
}
