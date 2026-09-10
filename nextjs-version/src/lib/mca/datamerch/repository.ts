import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, parseJson, type DbExecutor } from "../db"
import type { DataMerchCheck, DataMerchConfig } from "./contracts"
import type { DataMerchMerchantPayload } from "./client"

function db() { return getDatabase() }

export interface StoredDataMerchConfig extends DataMerchConfig {
  credentialCipher?: string
  credentialExpiresAt?: string
}

export interface StoredDataMerchCheck extends DataMerchCheck {
  workspaceId: string
  queryKind?: "ein" | "legal_name"
  merchants: DataMerchMerchantPayload[]
}

type ConfigRow = {
  workspace_id: string
  enabled: number
  credential_cipher: string | null
  credential_expires_at: string | null
  last_diagnostic: string | null
}

type CheckRow = {
  id: string
  workspace_id: string
  deal_id: string
  deal_version: number
  status: DataMerchCheck["status"]
  correlation_id: string
  result_summary: string | null
  record_count: number
  query_kind: string | null
  result_cipher: string | null
  lease_token: string | null
  lease_expires_at: string | null
  created_at: string
}

function mapConfig(row: ConfigRow | undefined, workspaceId: string): StoredDataMerchConfig {
  if (!row) {
    return { workspaceId, enabled: false, hasCredential: false }
  }
  return {
    workspaceId: row.workspace_id,
    enabled: Boolean(row.enabled),
    hasCredential: Boolean(row.credential_cipher),
    lastDiagnostic: row.last_diagnostic ?? undefined,
    credentialCipher: row.credential_cipher ?? undefined,
    credentialExpiresAt: row.credential_expires_at ?? undefined,
  }
}

function mapCheck(row: CheckRow): StoredDataMerchCheck {
  let merchants: DataMerchMerchantPayload[] = []
  if (row.result_cipher) {
    try {
      merchants = parseJson<DataMerchMerchantPayload[]>(decryptSensitive(row.result_cipher, row.workspace_id), [])
    } catch {
      merchants = []
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    dealId: row.deal_id,
    dealVersion: Number(row.deal_version),
    status: row.status,
    correlationId: row.correlation_id,
    resultSummary: row.result_summary ?? undefined,
    recordCount: Number(row.record_count),
    createdAt: row.created_at,
    queryKind: row.query_kind === "ein" || row.query_kind === "legal_name" ? row.query_kind : undefined,
    merchants,
  }
}

export async function readConfig(workspaceId: string): Promise<StoredDataMerchConfig> {
  const row = await db().prepare<ConfigRow>("SELECT * FROM mca_datamerch_config WHERE workspace_id = ?").get(workspaceId)
  return mapConfig(row, workspaceId)
}

export async function upsertConfig(input: {
  workspaceId: string
  enabled: boolean
  credentialCipher?: string | null
  credentialExpiresAt?: string | null
  lastDiagnostic?: string | null
  updatedAt: string
  updatedByUserId: string | null
}): Promise<StoredDataMerchConfig> {
  const current = await readConfig(input.workspaceId)
  const credentialCipher = input.credentialCipher === undefined ? current.credentialCipher ?? null : input.credentialCipher
  const credentialExpiresAt = input.credentialExpiresAt === undefined ? current.credentialExpiresAt ?? null : input.credentialExpiresAt
  const lastDiagnostic = input.lastDiagnostic === undefined ? current.lastDiagnostic ?? null : input.lastDiagnostic
  await db().prepare(`INSERT INTO mca_datamerch_config
    (workspace_id, enabled, credential_cipher, credential_expires_at, last_diagnostic, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      enabled = excluded.enabled,
      credential_cipher = excluded.credential_cipher,
      credential_expires_at = excluded.credential_expires_at,
      last_diagnostic = excluded.last_diagnostic,
      updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id`).run(
    input.workspaceId,
    input.enabled ? 1 : 0,
    credentialCipher,
    credentialExpiresAt,
    lastDiagnostic,
    input.updatedAt,
    input.updatedByUserId,
  )
  return readConfig(input.workspaceId)
}

export async function updateConfigDiagnostic(workspaceId: string, lastDiagnostic: string, updatedAt: string, executor: DbExecutor = db()): Promise<void> {
  await executor.prepare("UPDATE mca_datamerch_config SET last_diagnostic = ?, updated_at = ? WHERE workspace_id = ?")
    .run(lastDiagnostic, updatedAt, workspaceId)
}

export async function findCheckByCorrelation(workspaceId: string, dealId: string, correlationId: string): Promise<StoredDataMerchCheck | undefined> {
  const row = await db().prepare<CheckRow>(`SELECT * FROM mca_datamerch_checks WHERE workspace_id = ? AND deal_id = ? AND correlation_id = ?`)
    .get(workspaceId, dealId, correlationId)
  return row ? mapCheck(row) : undefined
}

export async function listChecks(workspaceId: string, dealId: string): Promise<StoredDataMerchCheck[]> {
  const rows = await db().prepare<CheckRow>(`SELECT * FROM mca_datamerch_checks WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at DESC, id DESC`)
    .all(workspaceId, dealId)
  return rows.map(mapCheck)
}

export async function insertCheck(input: {
  id: string
  workspaceId: string
  dealId: string
  dealVersion: number
  status: DataMerchCheck["status"]
  correlationId: string
  resultSummary?: string
  recordCount: number
  queryKind?: "ein" | "legal_name"
  merchants?: DataMerchMerchantPayload[]
  createdAt: string
}): Promise<StoredDataMerchCheck> {
  const resultCipher = input.merchants?.length
    ? encryptSensitive(JSON.stringify(input.merchants), input.workspaceId)
    : null
  await db().prepare(`INSERT INTO mca_datamerch_checks
    (id, workspace_id, deal_id, deal_version, status, correlation_id, result_summary, record_count, query_kind, result_cipher, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, deal_id, correlation_id) DO NOTHING`).run(
    input.id,
    input.workspaceId,
    input.dealId,
    input.dealVersion,
    input.status,
    input.correlationId,
    input.resultSummary ?? null,
    input.recordCount,
    input.queryKind ?? null,
    resultCipher,
    input.createdAt,
  )
  const saved = await findCheckByCorrelation(input.workspaceId, input.dealId, input.correlationId)
  if (!saved) throw new Error("Data Merch check not found after insert")
  return saved
}

export async function claimCheck(input: {
  id: string
  workspaceId: string
  leaseToken: string
  claimedAt: string
  leaseExpiresAt: string
}): Promise<{ check: StoredDataMerchCheck; acquired: boolean }> {
  const claimed = await db().prepare<CheckRow>(`UPDATE mca_datamerch_checks
    SET lease_token = ?, lease_expires_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'queued'
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    RETURNING *`).get(
    input.leaseToken,
    input.leaseExpiresAt,
    input.id,
    input.workspaceId,
    input.claimedAt,
  )
  if (claimed) return { check: mapCheck(claimed), acquired: true }
  const current = await db().prepare<CheckRow>("SELECT * FROM mca_datamerch_checks WHERE id = ? AND workspace_id = ?")
    .get(input.id, input.workspaceId)
  if (!current) throw new Error("Data Merch check not found after claim")
  return { check: mapCheck(current), acquired: false }
}

export async function completeClaimedCheck(input: {
  id: string
  workspaceId: string
  leaseToken: string
  status: DataMerchCheck["status"]
  resultSummary?: string
  recordCount: number
  merchants?: DataMerchMerchantPayload[]
  executor?: DbExecutor
}): Promise<StoredDataMerchCheck | undefined> {
  const resultCipher = input.merchants?.length
    ? encryptSensitive(JSON.stringify(input.merchants), input.workspaceId)
    : null
  const row = await (input.executor ?? db()).prepare<CheckRow>(`UPDATE mca_datamerch_checks
    SET status = ?, result_summary = ?, record_count = ?, result_cipher = ?, lease_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND workspace_id = ? AND status = 'queued' AND lease_token = ?
    RETURNING *`).get(
    input.status,
    input.resultSummary ?? null,
    input.recordCount,
    resultCipher,
    input.id,
    input.workspaceId,
    input.leaseToken,
  )
  return row ? mapCheck(row) : undefined
}

export function toPublicCheck(record: StoredDataMerchCheck): DataMerchCheck {
  return {
    id: record.id,
    dealId: record.dealId,
    dealVersion: record.dealVersion,
    status: record.status,
    correlationId: record.correlationId,
    resultSummary: record.resultSummary,
    recordCount: record.recordCount,
    createdAt: record.createdAt,
  }
}

export function toPublicConfig(record: StoredDataMerchConfig): DataMerchConfig {
  return {
    workspaceId: record.workspaceId,
    enabled: record.enabled,
    hasCredential: record.hasCredential,
    lastDiagnostic: record.lastDiagnostic,
  }
}
