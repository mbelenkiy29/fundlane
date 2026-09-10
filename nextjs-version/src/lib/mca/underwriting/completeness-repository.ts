import "server-only"

import { getDatabase, parseJson, withImmediateTransaction } from "../db"
import type { CompletenessFinding, CompletenessResult } from "./contracts"

function db() { return getDatabase() }

export const DEFAULT_REQUIRED_STATEMENT_MONTHS = 3

export interface CompletenessResultRow {
  id: string
  workspaceId: string
  result: CompletenessResult
  findingsFingerprint: string
}

export interface ReadinessEventRecord {
  id: string
  dealId: string
  completenessVersion: number
  ready: boolean
  createdAt: string
}

export async function readRequiredStatementMonths(workspaceId: string): Promise<number> {
  const row = await db().prepare<{ n?: number }>("SELECT required_statement_months AS n FROM mca_completeness_settings WHERE workspace_id = ?").get(workspaceId)
  return Number.isInteger(row?.n) ? Number(row?.n) : DEFAULT_REQUIRED_STATEMENT_MONTHS
}

export async function upsertRequiredStatementMonths(workspaceId: string, n: number, userId: string | null, now: string): Promise<number> {
  await db().prepare(`INSERT INTO mca_completeness_settings (workspace_id, required_statement_months, updated_at, updated_by_user_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET required_statement_months = excluded.required_statement_months, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`)
    .run(workspaceId, n, now, userId)
  return n
}

function mapResult(row: Record<string, unknown>): CompletenessResultRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    findingsFingerprint: String(row.findings_fingerprint),
    result: {
      dealId: String(row.deal_id),
      ready: Boolean(row.ready),
      version: Number(row.version),
      ruleSnapshot: String(row.rule_snapshot),
      findings: parseJson<CompletenessFinding[]>(row.findings_json, []),
      checkedAt: String(row.checked_at),
    },
  }
}

export async function findLatestCompletenessResult(workspaceId: string, dealId: string): Promise<CompletenessResultRow | undefined> {
  const row = await db().prepare<Record<string, unknown>>(`SELECT * FROM mca_completeness_results WHERE workspace_id = ? AND deal_id = ? ORDER BY version DESC LIMIT 1`)
    .get(workspaceId, dealId)
  return row ? mapResult(row) : undefined
}

export async function insertCompletenessResultAndEvent(input: {
  resultId: string
  eventId: string
  workspaceId: string
  dealId: string
  ready: boolean
  ruleSnapshot: string
  findings: CompletenessFinding[]
  findingsFingerprint: string
  checkedAt: string
}): Promise<CompletenessResult> {
  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT id FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(input.workspaceId, input.dealId)
    const latestRow = await database.prepare<Record<string, unknown>>(`SELECT * FROM mca_completeness_results WHERE workspace_id = ? AND deal_id = ? ORDER BY version DESC LIMIT 1`)
      .get(input.workspaceId, input.dealId)
    const latest = latestRow ? mapResult(latestRow) : undefined
    if (latest?.findingsFingerprint === input.findingsFingerprint) return latest.result
    const version = (latest?.result.version ?? 0) + 1
    await database.prepare(`INSERT INTO mca_completeness_results
      (id, workspace_id, deal_id, ready, version, rule_snapshot, findings_json, findings_fingerprint, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.resultId,
      input.workspaceId,
      input.dealId,
      input.ready ? 1 : 0,
      version,
      input.ruleSnapshot,
      JSON.stringify(input.findings),
      input.findingsFingerprint,
      input.checkedAt,
    )
    await database.prepare(`INSERT INTO mca_readiness_events
      (id, workspace_id, deal_id, completeness_version, ready, findings_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.eventId,
      input.workspaceId,
      input.dealId,
      version,
      input.ready ? 1 : 0,
      input.findingsFingerprint,
      input.checkedAt,
    )
    return {
      dealId: input.dealId,
      ready: input.ready,
      version,
      ruleSnapshot: input.ruleSnapshot,
      findings: input.findings,
      checkedAt: input.checkedAt,
    }
  })
}

export async function listReadinessEventRecords(workspaceId: string, dealId: string): Promise<ReadinessEventRecord[]> {
  const rows = await db().prepare<{ id: string; deal_id: string; completeness_version: number; ready: number; created_at: string }>(`SELECT id, deal_id, completeness_version, ready, created_at
    FROM mca_readiness_events WHERE workspace_id = ? AND deal_id = ? ORDER BY completeness_version ASC`)
    .all(workspaceId, dealId)
  return rows.map((row) => ({
    id: row.id,
    dealId: row.deal_id,
    completenessVersion: row.completeness_version,
    ready: Boolean(row.ready),
    createdAt: row.created_at,
  }))
}

export async function listCheckingStatementMonths(workspaceId: string, dealId: string): Promise<Map<string, Array<{ period: string; accountKind: string }>>> {
  const rows = await db().prepare<{ document_id: string; period: string; account_kind: string }>(`SELECT document_id, period, account_kind
    FROM mca_statement_months WHERE workspace_id = ? AND deal_id = ?`).all(workspaceId, dealId)
  const byDocument = new Map<string, Array<{ period: string; accountKind: string }>>()
  for (const row of rows) {
    const current = byDocument.get(row.document_id) ?? []
    current.push({ period: row.period, accountKind: row.account_kind })
    byDocument.set(row.document_id, current)
  }
  return byDocument
}
