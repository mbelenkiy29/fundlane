import "server-only"

import { createOpaqueToken, hashOpaqueToken } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction } from "../db"
import type { DealActor, DealFilters } from "../deals/schema"
import { AppError } from "../errors"
import { isActionAllowed } from "../policy"
import type { ActionVisibility } from "../types"
import { getWorkspaceSettings } from "../workspaces"
import {
  EXPORT_ASYNC_ROW_THRESHOLD,
  EXPORT_CORRELATION_MAX,
  EXPORT_DOWNLOAD_TTL_MS,
  EXPORT_KIND_LABELS,
  isExportKind,
  isWorkspaceExportKind,
  exportFilename,
  type CreateExportInput,
  type ExportCapabilities,
  type ExportDownload,
  type ExportJobView,
  type ExportKind,
  type ExportSnapshot,
  type MintExportDownloadInput,
} from "./contracts"
import { csvChecksum, serializeCsv } from "./csv"
import { manifestFor } from "./manifests"
import { captureExportSnapshot } from "./query"
import { assertExecutionActive } from "../jobs/execution"

type JobRow = {
  id: string
  workspace_id: string
  kind: string
  filter_snapshot_json: string
  field_manifest_json: string
  state: string
  checksum: string | null
  row_count: number | null
  actor_user_id: string | null
  correlation_id: string
  created_at: string
  updated_at: string
}

function actorKey(actor: DealActor): string {
  return actor.userId ?? `key:${actor.source}`
}

function exportEnabled(actor: DealActor, actions: ActionVisibility): boolean {
  return actor.role ? isActionAllowed(actor.role, "exportDeals", actions) : actions.exportDeals
}

function workspaceExporter(actor: DealActor): boolean {
  return actor.source === "api_key" || actor.role === "admin" || actor.role === "super_admin"
}

export function allowedExportKinds(actor: DealActor, actions: ActionVisibility): ExportKind[] {
  if (!exportEnabled(actor, actions)) return []
  if (workspaceExporter(actor)) return ["deals", "offers", "all_deals_owners", "funded_deals"]
  return ["deals", "offers"]
}

export function assertCanExportKind(actor: DealActor, kind: ExportKind, actions: ActionVisibility): void {
  if (!exportEnabled(actor, actions)) {
    throw new AppError(403, "action_disabled", "Deal exports are disabled for this workspace.")
  }
  if (isWorkspaceExportKind(kind) && !workspaceExporter(actor)) {
    throw new AppError(403, "permission_denied", "Only workspace administrators can run all-deals and funded-deals exports.")
  }
}

function sanitizeFilters(input?: DealFilters): DealFilters {
  const filters: DealFilters = {}
  if (input?.search?.trim()) filters.search = input.search.trim()
  if (input?.assignee?.trim()) filters.assignee = input.assignee.trim()
  if (input?.funder?.trim()) filters.funder = input.funder.trim()
  if (input?.createdFrom) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.createdFrom)) throw new AppError(422, "invalid_filter", "from must use YYYY-MM-DD.", { createdFrom: ["Use YYYY-MM-DD."] })
    filters.createdFrom = input.createdFrom
  }
  if (input?.createdTo) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.createdTo)) throw new AppError(422, "invalid_filter", "to must use YYYY-MM-DD.", { createdTo: ["Use YYYY-MM-DD."] })
    filters.createdTo = input.createdTo
  }
  if (input?.statuses?.length) {
    const allowed = new Set<string>(["lead", "new_application", "missing_documents", "ready_to_submit", "submitted", "resubmitting", "offer", "repricing", "contract", "funded", "renewed", "closed", "default", "missed_payments"])
    if (input.statuses.some((status) => !allowed.has(status))) {
      throw new AppError(422, "invalid_filter", "One or more status filters are invalid.", { statuses: ["Choose a supported deal status."] })
    }
    filters.statuses = input.statuses
  }
  return filters
}

function snapshotOf(row: JobRow): ExportSnapshot {
  return parseJson<ExportSnapshot>(row.filter_snapshot_json, { version: 1, filters: {}, capturedAt: row.created_at, rowKeys: [], rows: [] })
}

function toView(row: JobRow, replayed = false): ExportJobView {
  const snapshot = snapshotOf(row)
  const kind = row.kind as ExportKind
  const manifest = manifestFor(kind)
  return {
    id: row.id,
    kind,
    kindLabel: EXPORT_KIND_LABELS[kind],
    state: row.state as ExportJobView["state"],
    rowCount: row.row_count === null ? null : Number(row.row_count),
    checksum: row.checksum,
    filename: exportFilename(kind, snapshot.capturedAt),
    fieldManifest: manifest.fields.map((field) => ({ key: field.key, header: field.header, ...(field.identifier ? { identifier: true } : {}) })),
    isPaymentExport: false,
    replayed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    correlationId: row.correlation_id,
    ...(snapshot.error ? { error: snapshot.error } : {}),
  }
}

function canSeeJob(actor: DealActor, row: JobRow): boolean {
  if (row.workspace_id !== actor.workspaceId) return false
  if (workspaceExporter(actor)) return true
  return (row.actor_user_id ?? "") === (actor.userId ?? "")
}

async function loadJob(actor: DealActor, jobId: string): Promise<JobRow> {
  const row = await getDatabase().prepare<JobRow>("SELECT * FROM mca_export_jobs WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, jobId)
  if (!row || !canSeeJob(actor, row)) throw new AppError(404, "export_job_not_found", "The requested export was not found.")
  return row
}

function csvFor(row: JobRow): string {
  const kind = row.kind as ExportKind
  return serializeCsv(manifestFor(kind).fields, snapshotOf(row).rows, assertExecutionActive)
}

function lockKey(actor: DealActor, kind: ExportKind, correlationId: string): string {
  return `export:${actor.workspaceId}:${kind}:${actorKey(actor)}:${correlationId}`
}

async function findByCorrelation(actor: DealActor, kind: ExportKind, correlationId: string): Promise<JobRow | undefined> {
  return getDatabase().prepare<JobRow>(
    `SELECT * FROM mca_export_jobs WHERE workspace_id = ? AND kind = ? AND correlation_id = ? AND coalesce(actor_user_id, '') = coalesce(?, '')`,
  ).get(actor.workspaceId, kind, correlationId, actor.userId)
}

export async function getExportCapabilities(actor: DealActor): Promise<ExportCapabilities> {
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  const kinds = allowedExportKinds(actor, actions)
  return {
    exportEnabled: exportEnabled(actor, actions),
    roleScoped: kinds.includes("deals"),
    workspace: kinds.includes("all_deals_owners"),
    kinds,
    isPaymentExport: false,
    asyncThreshold: EXPORT_ASYNC_ROW_THRESHOLD,
  }
}

export async function listExportJobs(actor: DealActor): Promise<{ capabilities: ExportCapabilities; jobs: ExportJobView[] }> {
  const capabilities = await getExportCapabilities(actor)
  if (!capabilities.exportEnabled) return { capabilities, jobs: [] }
  const rows = workspaceExporter(actor)
    ? await getDatabase().prepare<JobRow>("SELECT * FROM mca_export_jobs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 50").all(actor.workspaceId)
    : await getDatabase().prepare<JobRow>("SELECT * FROM mca_export_jobs WHERE workspace_id = ? AND coalesce(actor_user_id, '') = coalesce(?, '') ORDER BY created_at DESC, id DESC LIMIT 50").all(actor.workspaceId, actor.userId)
  return { capabilities, jobs: rows.filter((row) => canSeeJob(actor, row)).map((row) => toView(row)) }
}

export async function getExportJob(actor: DealActor, jobId: string): Promise<ExportJobView> {
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  if (!exportEnabled(actor, actions)) throw new AppError(403, "action_disabled", "Deal exports are disabled for this workspace.")
  return toView(await loadJob(actor, jobId))
}

export async function createExportJob(actor: DealActor, input: CreateExportInput): Promise<{ job: ExportJobView; download: ExportDownload | null }> {
  assertExecutionActive()
  if (!isExportKind(input.kind)) throw new AppError(422, "validation_failed", "Choose a supported export kind.", { kind: ["Choose deals, offers, all deals and owners, or funded deals."] })
  const correlationId = input.correlationId?.trim() ?? ""
  if (!correlationId || correlationId.length > EXPORT_CORRELATION_MAX) {
    throw new AppError(422, "validation_failed", "A stable retry key is required.", { correlationId: ["Provide a correlation id of at most 128 characters."] })
  }
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  assertCanExportKind(actor, input.kind, actions)
  const filters = sanitizeFilters(input.filters)
  const capturedAt = input.nowIso ?? nowIso()

  const existing = await withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(lockKey(actor, input.kind, correlationId))
    return findByCorrelation(actor, input.kind, correlationId)
  })
  if (existing) {
    const job = toView(existing, true)
    const download = existing.state === "ready" ? await mintExportDownload(actor, existing.id, { nowIso: capturedAt }) : null
    await recordAuditEvent({
      context: actor, action: "export.replayed", resourceType: "export_job", resourceId: existing.id,
      metadata: { kind: existing.kind, state: existing.state, rowCount: existing.row_count, isPaymentExport: false },
      correlationId,
    })
    return { job, download }
  }

  const snapshot = await captureExportSnapshot(actor, input.kind, filters, capturedAt)
  assertExecutionActive()
  const asyncJob = Boolean(input.async) || snapshot.rows.length >= EXPORT_ASYNC_ROW_THRESHOLD
  const id = newId()
  const manifest = manifestFor(input.kind)
  const queued: JobRow = {
    id,
    workspace_id: actor.workspaceId,
    kind: input.kind,
    filter_snapshot_json: JSON.stringify(snapshot),
    field_manifest_json: JSON.stringify(manifest),
    state: "queued",
    checksum: null,
    row_count: snapshot.rows.length,
    actor_user_id: actor.userId,
    correlation_id: correlationId,
    created_at: capturedAt,
    updated_at: capturedAt,
  }

  await withImmediateTransaction(async (database) => {
    assertExecutionActive()
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(lockKey(actor, input.kind, correlationId))
    const replay = await findByCorrelation(actor, input.kind, correlationId)
    if (replay) {
      queued.id = replay.id
      Object.assign(queued, replay)
      return
    }
    await database.prepare(`INSERT INTO mca_export_jobs
      (id, workspace_id, kind, filter_snapshot_json, field_manifest_json, state, checksum, row_count, actor_user_id, correlation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      queued.id, queued.workspace_id, queued.kind, queued.filter_snapshot_json, queued.field_manifest_json,
      queued.state, queued.checksum, queued.row_count, queued.actor_user_id, queued.correlation_id, queued.created_at, queued.updated_at,
    )
  })

  const persisted = await findByCorrelation(actor, input.kind, correlationId)
  if (!persisted) throw new Error("Export job was not persisted.")
  await recordAuditEvent({
    context: actor, action: "export.created", resourceType: "export_job", resourceId: persisted.id,
    metadata: { kind: persisted.kind, state: persisted.state, rowCount: persisted.row_count, async: asyncJob, isPaymentExport: false },
    correlationId,
  })
  if (asyncJob) return { job: toView(persisted, persisted.id !== id), download: null }
  return { job: await processExportJob(actor, persisted.id, { nowIso: capturedAt }), download: await mintExportDownload(actor, persisted.id, { nowIso: capturedAt }) }
}

export async function processExportJob(actor: DealActor, jobId: string, options: { nowIso?: string } = {}): Promise<ExportJobView> {
  assertExecutionActive()
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  if (!exportEnabled(actor, actions)) throw new AppError(403, "action_disabled", "Deal exports are disabled for this workspace.")
  const current = await loadJob(actor, jobId)
  assertCanExportKind(actor, current.kind as ExportKind, actions)
  if (current.state === "ready") return toView(current)
  if (current.state === "expired") throw new AppError(410, "export_expired", "This export has expired. Create a new export.")
  const now = options.nowIso ?? nowIso()
  try {
    const csv = csvFor(current)
    assertExecutionActive()
    const checksum = csvChecksum(csv)
    const snapshot = snapshotOf(current)
    if (snapshot.rows.length !== (current.row_count ?? snapshot.rows.length)) {
      throw new Error("Export snapshot row count does not match persisted row_count.")
    }
    await getDatabase().prepare(
      `UPDATE mca_export_jobs SET state = 'ready', checksum = ?, row_count = ?, updated_at = ?, filter_snapshot_json = ? WHERE workspace_id = ? AND id = ?`,
    ).run(checksum, snapshot.rows.length, now, JSON.stringify({ ...snapshot, error: undefined }), actor.workspaceId, jobId)
    await recordAuditEvent({
      context: actor, action: "export.ready", resourceType: "export_job", resourceId: jobId,
      metadata: { kind: current.kind, rowCount: snapshot.rows.length, checksum, isPaymentExport: false },
      correlationId: current.correlation_id,
    })
  } catch (error) {
    assertExecutionActive()
    const message = error instanceof Error ? error.message : "Export failed."
    const snapshot = { ...snapshotOf(current), error: { code: "export_failed", message } }
    await getDatabase().prepare(
      `UPDATE mca_export_jobs SET state = 'failed', updated_at = ?, filter_snapshot_json = ? WHERE workspace_id = ? AND id = ?`,
    ).run(now, JSON.stringify(snapshot), actor.workspaceId, jobId)
    await recordAuditEvent({
      context: actor, action: "export.failed", resourceType: "export_job", resourceId: jobId,
      metadata: { kind: current.kind, code: "export_failed", isPaymentExport: false },
      correlationId: current.correlation_id,
    })
    throw new AppError(500, "export_failed", "The export could not be generated.")
  }
  return toView(await loadJob(actor, jobId))
}

export async function mintExportDownload(actor: DealActor, jobId: string, options: MintExportDownloadInput = {}): Promise<ExportDownload> {
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  const job = await loadJob(actor, jobId)
  assertCanExportKind(actor, job.kind as ExportKind, actions)
  if (job.state === "queued") throw new AppError(409, "export_not_ready", "This export is still preparing.")
  if (job.state === "failed") throw new AppError(409, "export_failed", job.state === "failed" ? (snapshotOf(job).error?.message ?? "This export failed.") : "This export failed.")
  if (job.state !== "ready") throw new AppError(410, "export_expired", "This export has expired. Create a new export.")
  const now = options.nowIso ?? nowIso()
  const ttl = options.ttlMs ?? EXPORT_DOWNLOAD_TTL_MS
  const expiresAt = new Date(Date.parse(now) + ttl).toISOString()
  const token = createOpaqueToken()
  const id = newId()
  await getDatabase().prepare(
    `INSERT INTO mca_export_download_tokens (id, workspace_id, job_id, token_hash, expires_at, downloaded_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, actor.workspaceId, job.id, hashOpaqueToken(token), expiresAt, now)
  await recordAuditEvent({
    context: actor, action: "export.download_token_created", resourceType: "export_job", resourceId: job.id,
    metadata: { tokenId: id, expiresAt, isPaymentExport: false },
    correlationId: job.correlation_id,
  })
  return { url: `/api/mca/exports/download/${token}`, expiresAt }
}

export async function redeemExportDownload(actor: DealActor, token: string, options: { nowIso?: string } = {}): Promise<{ csv: string; filename: string; checksum: string; job: ExportJobView }> {
  const actions = (await getWorkspaceSettings(actor.workspaceId)).actionVisibility
  if (!token?.trim()) throw new AppError(404, "export_download_not_found", "The download link is invalid or has expired.")
  const now = options.nowIso ?? nowIso()
  const row = await getDatabase().prepare<{
    id: string; workspace_id: string; job_id: string; expires_at: string; downloaded_at: string | null
  }>("SELECT id, workspace_id, job_id, expires_at, downloaded_at FROM mca_export_download_tokens WHERE token_hash = ?").get(hashOpaqueToken(token))
  if (!row || row.workspace_id !== actor.workspaceId) throw new AppError(404, "export_download_not_found", "The download link is invalid or has expired.")
  if (row.expires_at <= now) throw new AppError(410, "export_download_expired", "This download link has expired.")
  const job = await loadJob(actor, row.job_id)
  assertCanExportKind(actor, job.kind as ExportKind, actions)
  if (job.state !== "ready") throw new AppError(409, "export_not_ready", "This export is not available to download.")
  const csv = csvFor(job)
  const checksum = job.checksum ?? csvChecksum(csv)
  if (csvChecksum(csv) !== checksum) throw new AppError(500, "export_checksum_mismatch", "The export file failed an integrity check.")
  if (!row.downloaded_at) {
    await getDatabase().prepare("UPDATE mca_export_download_tokens SET downloaded_at = ? WHERE id = ? AND downloaded_at IS NULL").run(now, row.id)
  }
  await recordAuditEvent({
    context: actor, action: "export.downloaded", resourceType: "export_job", resourceId: job.id,
    metadata: { tokenId: row.id, rowCount: job.row_count, checksum, isPaymentExport: false },
    correlationId: job.correlation_id,
  })
  return { csv, filename: exportFilename(job.kind as ExportKind, snapshotOf(job).capturedAt), checksum, job: toView(job) }
}

