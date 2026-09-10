import "server-only"

import { getDatabase, parseJson } from "../db"
import type { AnalysisMode, AnalysisSnapshot, FunderScore } from "./contracts"

type SnapshotRow = {
  id: string
  workspace_id: string
  deal_id: string
  policy_version: number
  underwriting_version: number
  completeness_version: number
  deal_version: number
  criteria_versions: string
  mode: string
  top_n: number
  scores_json: string
  stale: number | boolean
  aggregate_computed_at?: string | null
  created_at: string
}

export interface StoredScoreSnapshot extends AnalysisSnapshot {
  workspaceId: string
  dealVersion: number
  criteriaVersions: Record<string, number>
  stale: boolean
  aggregateComputedAt: string
}

function mapRow(row: SnapshotRow): StoredScoreSnapshot {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    dealId: String(row.deal_id),
    policyVersion: Number(row.policy_version),
    underwritingVersion: Number(row.underwriting_version),
    completenessVersion: Number(row.completeness_version),
    dealVersion: Number(row.deal_version),
    criteriaVersions: parseJson<Record<string, number>>(row.criteria_versions, {}),
    mode: row.mode as AnalysisMode,
    topN: Number(row.top_n),
    scores: parseJson<FunderScore[]>(row.scores_json, []),
    stale: Boolean(row.stale),
    aggregateComputedAt: String(row.aggregate_computed_at ?? ""),
    createdAt: String(row.created_at),
  }
}

export function toAnalysisSnapshot(row: StoredScoreSnapshot): AnalysisSnapshot {
  return {
    id: row.id,
    dealId: row.dealId,
    policyVersion: row.policyVersion,
    underwritingVersion: row.underwritingVersion,
    completenessVersion: row.completenessVersion,
    mode: row.mode,
    topN: row.topN,
    scores: row.scores,
    createdAt: row.createdAt,
  }
}

export async function findLatestScoreSnapshot(workspaceId: string, dealId: string): Promise<StoredScoreSnapshot | undefined> {
  const row = await getDatabase().prepare<SnapshotRow>(
    `SELECT * FROM mca_score_snapshots WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(workspaceId, dealId)
  return row ? mapRow(row) : undefined
}

export async function listScoreSnapshotRecords(workspaceId: string, dealId: string, limit = 20): Promise<StoredScoreSnapshot[]> {
  const rows = await getDatabase().prepare<SnapshotRow>(
    `SELECT * FROM mca_score_snapshots WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(workspaceId, dealId, limit)
  return rows.map(mapRow)
}

export async function insertScoreSnapshot(input: StoredScoreSnapshot): Promise<StoredScoreSnapshot> {
  await getDatabase().prepare(`INSERT INTO mca_score_snapshots
    (id, workspace_id, deal_id, policy_version, underwriting_version, completeness_version, deal_version,
     criteria_versions, mode, top_n, scores_json, stale, aggregate_computed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id,
    input.workspaceId,
    input.dealId,
    input.policyVersion,
    input.underwritingVersion,
    input.completenessVersion,
    input.dealVersion,
    JSON.stringify(input.criteriaVersions),
    input.mode,
    input.topN,
    JSON.stringify(input.scores),
    input.stale ? 1 : 0,
    input.aggregateComputedAt,
    input.createdAt,
  )
  return input
}

export async function markScoreSnapshotsStale(workspaceId: string, dealId: string): Promise<void> {
  await getDatabase().prepare(`UPDATE mca_score_snapshots SET stale = 1 WHERE workspace_id = ? AND deal_id = ? AND stale = 0`)
    .run(workspaceId, dealId)
}
