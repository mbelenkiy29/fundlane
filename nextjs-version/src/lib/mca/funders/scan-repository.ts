import "server-only"

import { getDatabase, parseJson } from "../db"
import type { DbExecutor } from "../db"
import type { CriteriaScanProposal, EligibilityRule } from "./contracts"

export interface AmbiguousRange {
  field: string
  rangeText: string
}

export interface StoredCriteriaScan extends CriteriaScanProposal {
  workspaceId: string
  previousRules: EligibilityRule[]
  ambiguousRanges: AmbiguousRange[]
  rolledBackAt?: string
  acceptedAt?: string
  rejectedAt?: string
  createdBy?: string | null
  createdAt: string
  updatedAt: string
}

type ScanRow = {
  id: string
  workspace_id: string
  funder_id: string
  document_id: string
  version: number
  status: CriteriaScanProposal["status"]
  rules_json: string
  previous_rules_json: string
  warnings_json: string
  evidence_json: string
  ambiguous_json: string
  provider: string
  request_id: string | null
  rolled_back_at: string | null
  accepted_at: string | null
  rejected_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

function fromRow(row: ScanRow): StoredCriteriaScan {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    funderId: String(row.funder_id),
    documentId: String(row.document_id),
    version: Number(row.version),
    status: row.status,
    rules: parseJson<EligibilityRule[]>(row.rules_json, []),
    previousRules: parseJson<EligibilityRule[]>(row.previous_rules_json, []),
    warnings: parseJson<string[]>(row.warnings_json, []),
    evidence: parseJson<CriteriaScanProposal["evidence"]>(row.evidence_json, {}),
    ambiguousRanges: parseJson<AmbiguousRange[]>(row.ambiguous_json, []),
    provider: String(row.provider),
    requestId: row.request_id ?? undefined,
    rolledBackAt: row.rolled_back_at ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    rejectedAt: row.rejected_at ?? undefined,
    createdBy: row.created_by,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function nextScanVersion(workspaceId: string, funderId: string): Promise<number> {
  const row = await getDatabase().prepare<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM mca_funder_criteria_scans WHERE workspace_id = ? AND funder_id = ?",
  ).get(workspaceId, funderId)
  return (row?.version ?? 0) + 1
}

export async function findScanById(workspaceId: string, id: string): Promise<StoredCriteriaScan | undefined> {
  const row = await getDatabase().prepare<ScanRow>("SELECT * FROM mca_funder_criteria_scans WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? fromRow(row) : undefined
}

export async function findScanByIdForUpdate(database: DbExecutor, workspaceId: string, id: string): Promise<StoredCriteriaScan | undefined> {
  const row = await database.prepare<ScanRow>("SELECT * FROM mca_funder_criteria_scans WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, id)
  return row ? fromRow(row) : undefined
}

export async function findLaterActiveAcceptedScan(
  database: DbExecutor,
  workspaceId: string,
  funderId: string,
  version: number,
): Promise<StoredCriteriaScan | undefined> {
  const row = await database.prepare<ScanRow>(`SELECT * FROM mca_funder_criteria_scans
    WHERE workspace_id = ? AND funder_id = ? AND version > ? AND status = 'accepted' AND rolled_back_at IS NULL
    ORDER BY version DESC, created_at DESC LIMIT 1`).get(workspaceId, funderId, version)
  return row ? fromRow(row) : undefined
}

export async function findProposedScanForDocument(workspaceId: string, funderId: string, documentId: string): Promise<StoredCriteriaScan | undefined> {
  const row = await getDatabase().prepare<ScanRow>(
    "SELECT * FROM mca_funder_criteria_scans WHERE workspace_id = ? AND funder_id = ? AND document_id = ? AND status = 'proposed'",
  ).get(workspaceId, funderId, documentId)
  return row ? fromRow(row) : undefined
}

export async function listScanRecords(workspaceId: string, funderId: string): Promise<StoredCriteriaScan[]> {
  const rows = await getDatabase().prepare<ScanRow>(
    "SELECT * FROM mca_funder_criteria_scans WHERE workspace_id = ? AND funder_id = ? ORDER BY version DESC, created_at DESC",
  ).all(workspaceId, funderId)
  return rows.map(fromRow)
}

export async function insertScanRecord(record: StoredCriteriaScan): Promise<StoredCriteriaScan> {
  await getDatabase().prepare(`INSERT INTO mca_funder_criteria_scans
    (id, workspace_id, funder_id, document_id, version, status, rules_json, previous_rules_json, warnings_json, evidence_json, ambiguous_json, provider, request_id, rolled_back_at, accepted_at, rejected_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    record.id,
    record.workspaceId,
    record.funderId,
    record.documentId,
    record.version,
    record.status,
    JSON.stringify(record.rules),
    JSON.stringify(record.previousRules),
    JSON.stringify(record.warnings),
    JSON.stringify(record.evidence),
    JSON.stringify(record.ambiguousRanges),
    record.provider,
    record.requestId ?? null,
    record.rolledBackAt ?? null,
    record.acceptedAt ?? null,
    record.rejectedAt ?? null,
    record.createdBy ?? null,
    record.createdAt,
    record.updatedAt,
  )
  return (await findScanById(record.workspaceId, record.id))!
}

export async function updateScanDecision(input: {
  workspaceId: string
  id: string
  status: CriteriaScanProposal["status"]
  rules?: EligibilityRule[]
  previousRules?: EligibilityRule[]
  acceptedAt?: string | null
  rejectedAt?: string | null
  rolledBackAt?: string | null
  expectedStatus?: CriteriaScanProposal["status"]
  expectedRolledBackAt?: string | null
  updatedAt: string
}): Promise<StoredCriteriaScan> {
  const current = await findScanById(input.workspaceId, input.id)
  if (!current) throw new Error("scan_not_found")
  const conditions = ["workspace_id = ?", "id = ?"]
  const conditionValues: Array<string | null> = [input.workspaceId, input.id]
  if (input.expectedStatus !== undefined) {
    conditions.push("status = ?")
    conditionValues.push(input.expectedStatus)
  }
  if (input.expectedRolledBackAt !== undefined) {
    conditions.push("rolled_back_at IS NOT DISTINCT FROM ?")
    conditionValues.push(input.expectedRolledBackAt)
  }
  const result = await getDatabase().prepare(`UPDATE mca_funder_criteria_scans
    SET status = ?, rules_json = ?, previous_rules_json = ?, accepted_at = ?, rejected_at = ?, rolled_back_at = ?, updated_at = ?
    WHERE ${conditions.join(" AND ")}`).run(
    input.status,
    JSON.stringify(input.rules ?? current.rules),
    JSON.stringify(input.previousRules ?? current.previousRules),
    input.acceptedAt === undefined ? current.acceptedAt ?? null : input.acceptedAt,
    input.rejectedAt === undefined ? current.rejectedAt ?? null : input.rejectedAt,
    input.rolledBackAt === undefined ? current.rolledBackAt ?? null : input.rolledBackAt,
    input.updatedAt,
    ...conditionValues,
  )
  if (result.changes !== 1) throw new Error("scan_decision_conflict")
  return (await findScanById(input.workspaceId, input.id))!
}
