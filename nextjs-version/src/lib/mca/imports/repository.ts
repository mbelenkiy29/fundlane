import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, nowIso, parseJson, withImmediateTransaction, type DbExecutor } from "../db"
import type { ImportCommitResult, ImportPreview, ImportRowPreview, ImportSource, LeadBatch, MappingProfile, UpdatePreview, UpdateRowPreview } from "./contracts"
import type { DriveCredential } from "./drive"

type Row = Record<string, string | number | null>
function db(): DbExecutor { return getDatabase() }
function sourceFrom(row: Row): ImportSource { return { id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), kind: row.kind as ImportSource["kind"], active: Boolean(row.active), createdAt: String(row.created_at) } }
function batchFrom(row: Row): LeadBatch { return { id: String(row.id), workspaceId: String(row.workspace_id), sourceId: String(row.source_id), name: String(row.name), createdAt: String(row.created_at) } }

export async function insertSource(workspaceId: string, name: string, kind: ImportSource["kind"]): Promise<ImportSource> {
  const item = { id: newId(), workspaceId, name, kind, active: true, createdAt: nowIso() }
  await db().prepare("INSERT INTO import_sources (id,workspace_id,name,kind,active,created_at) VALUES (?,?,?,?,1,?)").run(item.id, item.workspaceId, item.name, item.kind, item.createdAt)
  return item
}
export async function sourcesFor(workspaceId: string): Promise<ImportSource[]> { return (await db().prepare<Row>("SELECT * FROM import_sources WHERE workspace_id = ? ORDER BY created_at").all(workspaceId)).map(sourceFrom) }
export async function findSource(workspaceId: string, id: string): Promise<ImportSource | undefined> { const row = await db().prepare<Row>("SELECT * FROM import_sources WHERE workspace_id = ? AND id = ?").get(workspaceId, id); return row ? sourceFrom(row) : undefined }

export async function insertBatch(workspaceId: string, sourceId: string, name: string): Promise<LeadBatch> {
  const item = { id: newId(), workspaceId, sourceId, name, createdAt: nowIso() }
  await db().prepare("INSERT INTO lead_batches (id,workspace_id,source_id,name,created_at) VALUES (?,?,?,?,?)").run(item.id, workspaceId, sourceId, name, item.createdAt)
  return item
}
export async function batchesFor(workspaceId: string): Promise<LeadBatch[]> { return (await db().prepare<Row>("SELECT * FROM lead_batches WHERE workspace_id = ? ORDER BY created_at").all(workspaceId)).map(batchFrom) }
export async function findBatch(workspaceId: string, id: string): Promise<LeadBatch | undefined> { const row = await db().prepare<Row>("SELECT * FROM lead_batches WHERE workspace_id = ? AND id = ?").get(workspaceId, id); return row ? batchFrom(row) : undefined }

export async function upsertProfile(workspaceId: string, name: string, mapping: MappingProfile["mapping"], originatorMapping: Record<string, string> = {}): Promise<MappingProfile> {
  const timestamp = nowIso()
  const row = await db().prepare<Row>(`INSERT INTO import_mapping_profiles (id,workspace_id,name,mapping_json,originator_mapping_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET mapping_json=excluded.mapping_json,
    originator_mapping_json=excluded.originator_mapping_json,updated_at=excluded.updated_at RETURNING id,created_at`)
    .get(newId(), workspaceId, name, JSON.stringify(mapping), JSON.stringify(originatorMapping), timestamp, timestamp)
  return { id: String(row!.id), workspaceId, name, mapping, originatorMapping, createdAt: String(row!.created_at), updatedAt: timestamp }
}
export async function profilesFor(workspaceId: string): Promise<MappingProfile[]> {
  const rows = await db().prepare<Row>("SELECT * FROM import_mapping_profiles WHERE workspace_id=? ORDER BY name").all(workspaceId)
  return rows.map((row) => ({ id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), mapping: parseJson(row.mapping_json, {}), originatorMapping: parseJson(row.originator_mapping_json, {}), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }))
}

export async function insertPreview(preview: ImportPreview): Promise<void> {
  await withImmediateTransaction(async (database) => {
    await database.prepare(`INSERT INTO import_runs (id,workspace_id,source_id,batch_id,mode,filename,format,state,preview_revision,mapping_json,confidence_json,mapping_provider,mapping_warnings_json,assignment_pool_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(preview.runId, preview.workspaceId, preview.sourceId, preview.batchId, "create", preview.filename, preview.format, preview.state, preview.previewRevision, JSON.stringify(preview.mapping), JSON.stringify(preview.mappingConfidence), preview.mappingProvider, JSON.stringify(preview.mappingWarnings), JSON.stringify(preview.assignmentPool), preview.createdAt, preview.createdAt)
    const insert = database.prepare(`INSERT INTO import_rows (id,workspace_id,run_id,row_number,application_json,source_values_json,assignment_membership_id,errors_json,warnings_json,duplicate_ids_json,originator_source_value_cipher,duplicate_decision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    for (const row of preview.rows) await insert.run(row.id, preview.workspaceId, preview.runId, row.rowNumber, encryptSensitive(JSON.stringify(row.application), preview.workspaceId), encryptSensitive(JSON.stringify(row.sourceValues), preview.workspaceId), row.assignmentMembershipId, JSON.stringify(row.errors), JSON.stringify(row.warnings), JSON.stringify(row.duplicateDealIds), row.originatorSourceValue ? encryptSensitive(row.originatorSourceValue, preview.workspaceId) : null, row.duplicateDecision)
  })
}

function protectedJson<T>(value: unknown, workspaceId: string, fallback: T): T { if (typeof value !== "string") return fallback; try { return parseJson<T>(decryptSensitive(value, workspaceId), fallback) } catch { return parseJson<T>(value, fallback) } }
function previewRow(row: Row): ImportRowPreview { const workspaceId = String(row.workspace_id); return { id: String(row.id), rowNumber: Number(row.row_number), application: protectedJson(row.application_json, workspaceId, {}), sourceValues: protectedJson(row.source_values_json, workspaceId, {}), assignmentMembershipId: row.assignment_membership_id ? String(row.assignment_membership_id) : null, errors: parseJson(row.errors_json, []), warnings: parseJson(row.warnings_json, []), duplicateDealIds: parseJson(row.duplicate_ids_json, []), originatorSourceValue: row.originator_source_value_cipher ? decryptSensitive(String(row.originator_source_value_cipher), workspaceId) : null, duplicateDecision: row.duplicate_decision as ImportRowPreview["duplicateDecision"] ?? null } }
export async function findPreview(workspaceId: string, runId: string): Promise<ImportPreview | undefined> {
  const run = await db().prepare<Row>("SELECT * FROM import_runs WHERE workspace_id=? AND id=? AND mode='create'").get(workspaceId, runId)
  if (!run) return undefined
  const rows = (await db().prepare<Row>("SELECT * FROM import_rows WHERE workspace_id=? AND run_id=? ORDER BY row_number").all(workspaceId, runId)).map(previewRow)
  return { runId: String(run.id), workspaceId: String(run.workspace_id), sourceId: String(run.source_id), batchId: String(run.batch_id), filename: String(run.filename), format: run.format as ImportPreview["format"], state: run.state as ImportPreview["state"], previewRevision: Number(run.preview_revision), mapping: parseJson(run.mapping_json, {}), mappingConfidence: parseJson(run.confidence_json, {}), mappingProvider: String(run.mapping_provider), mappingWarnings: parseJson(run.mapping_warnings_json, []), assignmentPool: parseJson(run.assignment_pool_json, []), rows, createdAt: String(run.created_at) }
}

export async function beginCommit(workspaceId: string, runId: string, expectedRevision: number): Promise<string | null> {
  return withImmediateTransaction(async (database) => {
    const now = nowIso(); const token = newId(); const expiresAt = new Date(Date.now() + 120_000).toISOString()
    const claimed = await database.prepare<Row>(`UPDATE import_runs SET state='committing',commit_token=?,lease_expires_at=?,updated_at=?
      WHERE workspace_id=? AND id=? AND preview_revision=? AND cancellation_requested=0
      AND (state IN ('preview','failed') OR (state='committing' AND (lease_expires_at IS NULL OR lease_expires_at<=?))) RETURNING id`)
      .get(token, expiresAt, now, workspaceId, runId, expectedRevision, now)
    if (claimed) return token
    await database.prepare(`UPDATE import_runs SET state='cancelled',commit_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE workspace_id=? AND id=? AND preview_revision=? AND cancellation_requested<>0 AND state IN ('preview','failed','committing')`).run(now, workspaceId, runId, expectedRevision)
    return null
  })
}
export async function requestCancellation(workspaceId: string, runId: string): Promise<boolean> { return (await db().prepare("UPDATE import_runs SET cancellation_requested=1,state='cancelled',updated_at=? WHERE workspace_id=? AND id=? AND state='preview'").run(nowIso(), workspaceId, runId)).changes > 0 }
export async function cancellationRequested(workspaceId: string, runId: string): Promise<boolean> { const row = await db().prepare<Row>("SELECT cancellation_requested FROM import_runs WHERE workspace_id=? AND id=?").get(workspaceId, runId); return Boolean(row?.cancellation_requested) }

export async function recordRowResultInTransaction(database: DbExecutor, workspaceId: string, runId: string, rowId: string, state: string, dealId: string | null, message: string | null, commitToken?: string): Promise<boolean> {
  if (commitToken) {
    const run = await database.prepare<Row>("SELECT commit_token FROM import_runs WHERE workspace_id=? AND id=? AND state='committing' FOR UPDATE").get(workspaceId, runId)
    if (run?.commit_token !== commitToken) return false
  }
  const updated = await database.prepare("UPDATE import_rows SET state=?,deal_id=?,message=?,checkpoint=1 WHERE workspace_id=? AND run_id=? AND id=?").run(state, dealId, message, workspaceId, runId, rowId)
  if (updated.changes !== 1) return false
  const now = nowIso()
  if (commitToken) return (await database.prepare("UPDATE import_runs SET updated_at=?,lease_expires_at=? WHERE workspace_id=? AND id=? AND state='committing' AND commit_token=?").run(now, new Date(Date.now() + 120_000).toISOString(), workspaceId, runId, commitToken)).changes === 1
  await database.prepare("UPDATE import_runs SET updated_at=? WHERE workspace_id=? AND id=?").run(now, workspaceId, runId)
  return true
}
export async function recordRowResult(workspaceId: string, runId: string, rowId: string, state: string, dealId: string | null, message: string | null, commitToken?: string): Promise<boolean> { return withImmediateTransaction((database) => recordRowResultInTransaction(database, workspaceId, runId, rowId, state, dealId, message, commitToken)) }
export async function finishRun(workspaceId: string, runId: string, result: ImportCommitResult, commitToken?: string): Promise<boolean> {
  const sql = commitToken ? "UPDATE import_runs SET state=?,results_csv=?,commit_token=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND state='committing' AND commit_token=?" : "UPDATE import_runs SET state=?,results_csv=?,commit_token=NULL,lease_expires_at=NULL,updated_at=? WHERE workspace_id=? AND id=?"
  const values = commitToken ? [result.state, result.resultsCsv, nowIso(), workspaceId, runId, commitToken] : [result.state, result.resultsCsv, nowIso(), workspaceId, runId]
  return (await db().prepare(sql).run(...values)).changes === 1
}
export async function rowResultsForRun(workspaceId: string, runId: string): Promise<Map<string, { state: string; dealId: string | null; message: string | null }>> { const rows = await db().prepare<Row>("SELECT id,state,deal_id,message FROM import_rows WHERE workspace_id=? AND run_id=?").all(workspaceId, runId); return new Map(rows.map((row) => [String(row.id), { state: String(row.state), dealId: row.deal_id ? String(row.deal_id) : null, message: row.message ? String(row.message) : null }])) }
export async function storedRunResult(workspaceId: string, runId: string): Promise<ImportCommitResult | undefined> { const run = await db().prepare<Row>("SELECT state,results_csv FROM import_runs WHERE workspace_id=? AND id=?").get(workspaceId, runId); if (!run?.results_csv) return undefined; const checkpoints = [...(await rowResultsForRun(workspaceId, runId)).values()]; return { runId, state: String(run.state) as ImportCommitResult["state"], created: checkpoints.filter((row) => ["created", "updated"].includes(row.state)).length, skipped: checkpoints.filter((row) => ["retried", "skipped"].includes(row.state)).length, failed: checkpoints.filter((row) => ["failed", "updated_fields_pending_transition"].includes(row.state)).length, resultsCsv: String(run.results_csv) } }

export async function applyCreateReview(workspaceId: string, runId: string, expectedRevision: number, decisions: Array<{ rowId: string; duplicateDecision?: "create" | "skip"; assignmentMembershipId?: string | null }>): Promise<ImportPreview | undefined> {
  return withImmediateTransaction(async (database) => {
    const run = await database.prepare<Row>("SELECT state,preview_revision FROM import_runs WHERE workspace_id=? AND id=? AND mode='create' FOR UPDATE").get(workspaceId, runId)
    if (!run || run.state !== "preview" || Number(run.preview_revision) !== expectedRevision) return undefined
    const update = database.prepare("UPDATE import_rows SET duplicate_decision=COALESCE(?,duplicate_decision),assignment_membership_id=COALESCE(?,assignment_membership_id) WHERE workspace_id=? AND run_id=? AND id=?")
    for (const decision of decisions) await update.run(decision.duplicateDecision ?? null, decision.assignmentMembershipId ?? null, workspaceId, runId, decision.rowId)
    await database.prepare("UPDATE import_runs SET preview_revision=preview_revision+1,updated_at=? WHERE workspace_id=? AND id=?").run(nowIso(), workspaceId, runId)
    return findPreview(workspaceId, runId)
  })
}

export async function insertUpdatePreview(input: { workspaceId: string; sourceId: string; batchId: string; filename: string; mapping: Record<string, string>; headers: string[]; rows: UpdateRowPreview[] }): Promise<UpdatePreview> {
  const runId = newId(); const timestamp = nowIso(); const revision = 1
  await withImmediateTransaction(async (database) => {
    await database.prepare(`INSERT INTO import_runs (id,workspace_id,source_id,batch_id,mode,filename,format,state,preview_revision,mapping_json,confidence_json,mapping_provider,mapping_warnings_json,assignment_pool_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'csv','preview',?,?,?,'manual','[]','[]',?,?)`).run(runId, input.workspaceId, input.sourceId, input.batchId, "update", input.filename, revision, JSON.stringify(input.mapping), JSON.stringify({ headers: input.headers }), timestamp, timestamp)
    const insert = database.prepare(`INSERT INTO import_rows (id,workspace_id,run_id,row_number,application_json,source_values_json,assignment_membership_id,errors_json,warnings_json,duplicate_ids_json,update_json) VALUES (?,?,?,?,'{}','{}',NULL,?,'[]','[]',?)`)
    for (const row of input.rows) await insert.run(row.id, input.workspaceId, runId, row.rowNumber, JSON.stringify(row.errors), encryptSensitive(JSON.stringify(row), input.workspaceId))
  })
  return { runId, previewRevision: revision, state: "preview", mapping: input.mapping, headers: input.headers, rows: input.rows }
}
export async function findUpdatePreview(workspaceId: string, runId: string): Promise<UpdatePreview | undefined> { const run = await db().prepare<Row>("SELECT * FROM import_runs WHERE workspace_id=? AND id=? AND mode='update'").get(workspaceId, runId); if (!run) return undefined; const rows = (await db().prepare<Row>("SELECT update_json FROM import_rows WHERE workspace_id=? AND run_id=? ORDER BY row_number").all(workspaceId, runId)).map((row) => protectedJson<UpdateRowPreview>(row.update_json, workspaceId, { id: "", rowNumber: 0, dealId: "", expectedVersion: 0, before: {}, changes: {}, clearFields: [], errors: [] })); return { runId, previewRevision: Number(run.preview_revision), state: run.state as UpdatePreview["state"], mapping: parseJson(run.mapping_json, {}), headers: parseJson<{ headers: string[] }>(run.confidence_json, { headers: [] }).headers, rows } }

export async function saveDriveConnection(workspaceId: string, folder: { id: string; name: string }, credential: DriveCredential, scope: string): Promise<void> { const timestamp = nowIso(); await db().prepare(`INSERT INTO drive_connections (id,workspace_id,folder_id,folder_name,access_token_cipher,refresh_token_cipher,expires_at,scope,connected_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(workspace_id) DO UPDATE SET folder_id=excluded.folder_id,folder_name=excluded.folder_name,access_token_cipher=excluded.access_token_cipher,refresh_token_cipher=excluded.refresh_token_cipher,expires_at=excluded.expires_at,scope=excluded.scope,connected_at=excluded.connected_at,revoked_at=NULL`).run(newId(), workspaceId, folder.id, folder.name, encryptSensitive(credential.accessToken, workspaceId), credential.refreshToken ? encryptSensitive(credential.refreshToken, workspaceId) : null, credential.expiresAt ?? null, scope, timestamp) }
export async function loadDriveConnection(workspaceId: string): Promise<{ id: string; folderId: string; folderName: string; scope: string; credential: DriveCredential } | undefined> { const row = await db().prepare<Row>("SELECT * FROM drive_connections WHERE workspace_id=? AND revoked_at IS NULL").get(workspaceId); if (!row) return undefined; return { id: String(row.id), folderId: String(row.folder_id), folderName: String(row.folder_name), scope: String(row.scope), credential: { accessToken: decryptSensitive(String(row.access_token_cipher), workspaceId), ...(row.refresh_token_cipher ? { refreshToken: decryptSensitive(String(row.refresh_token_cipher), workspaceId) } : {}), ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}) } } }
export async function removeDriveConnection(workspaceId: string): Promise<void> { await db().prepare("DELETE FROM drive_connections WHERE workspace_id=?").run(workspaceId) }
export async function driveConnectionStatus(workspaceId: string): Promise<{ connected: boolean; folderId?: string; folderName?: string; scope?: string; expiresAt?: string }> { const row = await db().prepare<Row>("SELECT folder_id,folder_name,scope,expires_at FROM drive_connections WHERE workspace_id=? AND revoked_at IS NULL").get(workspaceId); return row ? { connected: true, folderId: String(row.folder_id), folderName: String(row.folder_name), scope: String(row.scope), ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}) } : { connected: false } }
export async function recordDriveTransfer(input: { workspaceId: string; runId: string; fileId: string; name: string; state: string; message?: string; checksum?: string | null; byteLength?: number }): Promise<void> { const timestamp = nowIso(); await db().prepare(`INSERT INTO drive_transfer_results (id,workspace_id,run_id,drive_file_id,name,state,message,checksum,byte_length,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,drive_file_id) DO UPDATE SET name=excluded.name,state=excluded.state,message=excluded.message,checksum=excluded.checksum,byte_length=excluded.byte_length,updated_at=excluded.updated_at WHERE drive_transfer_results.state <> 'downloaded'`).run(newId(), input.workspaceId, input.runId, input.fileId, input.name, input.state, input.message ?? null, input.checksum ?? null, input.byteLength ?? null, timestamp, timestamp) }
export async function driveTransfersForRun(workspaceId: string, runId: string): Promise<Map<string, { id: string; name: string; state: string; message?: string; checksum: string | null; byteLength: number | null }>> { const rows = await db().prepare<Row>("SELECT drive_file_id,name,state,message,checksum,byte_length FROM drive_transfer_results WHERE workspace_id=? AND run_id=?").all(workspaceId, runId); return new Map(rows.map((row) => [String(row.drive_file_id), { id: String(row.drive_file_id), name: String(row.name), state: String(row.state), ...(row.message ? { message: String(row.message) } : {}), checksum: row.checksum ? String(row.checksum) : null, byteLength: row.byte_length === null ? null : Number(row.byte_length) }])) }
export async function saveDriveOauthState(workspaceId: string, stateHash: string, folderId: string, expiresAt: string): Promise<void> { await withImmediateTransaction(async (database) => { await database.prepare("DELETE FROM drive_oauth_states WHERE workspace_id=? OR expires_at<?").run(workspaceId, nowIso()); await database.prepare("INSERT INTO drive_oauth_states (state_hash,workspace_id,folder_id,expires_at,created_at) VALUES (?,?,?,?,?)").run(stateHash, workspaceId, folderId, expiresAt, nowIso()) }) }
export async function consumeDriveOauthState(workspaceId: string, stateHash: string): Promise<{ folderId: string } | undefined> { return withImmediateTransaction(async (database) => { const row = await database.prepare<Row>("DELETE FROM drive_oauth_states WHERE workspace_id=? AND state_hash=? RETURNING folder_id,expires_at").get(workspaceId, stateHash); if (!row || Date.parse(String(row.expires_at)) <= Date.now()) return undefined; return { folderId: String(row.folder_id) } }) }
export async function recordArchiveAssociation(input: { workspaceId: string; runId: string; rowId: string; archiveName: string; path: string; category: string; documentId?: string }): Promise<void> { await db().prepare(`INSERT INTO import_archive_associations (id,workspace_id,run_id,row_id,archive_name,entry_path,category,document_id,created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,archive_name,entry_path) DO UPDATE SET row_id=excluded.row_id,category=excluded.category,document_id=excluded.document_id`).run(newId(), input.workspaceId, input.runId, input.rowId, input.archiveName, input.path, input.category, input.documentId ?? null, nowIso()) }
export async function findImportRow(workspaceId: string, runId: string, rowId: string): Promise<{ id: string; dealId: string | null; application: Record<string, unknown> } | undefined> { const row = await db().prepare<Row>("SELECT id,deal_id,application_json FROM import_rows WHERE workspace_id=? AND run_id=? AND id=?").get(workspaceId, runId, rowId); return row ? { id: String(row.id), dealId: row.deal_id ? String(row.deal_id) : null, application: protectedJson(row.application_json, workspaceId, {}) } : undefined }
