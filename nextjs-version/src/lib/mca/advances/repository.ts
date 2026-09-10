import "server-only"

import { getDatabase, newId, nowIso, type DbExecutor } from "../db"
import type { AdvancePerformanceStatus } from "../accounting/contracts"

export interface AdvanceRow {
  id: string
  workspace_id: string
  funding_event_id: string
  deal_id: string
  offer_id: string
  offer_revision_id: string
  funded_at: string
  principal_cents: number
  payback_cents: number | null
  periodic_payment_cents: number | null
  payment_count: number | null
  payment_frequency: string | null
  calendar_convention: string | null
  status: string
  business_name: string
  funder_name: string
  assigned_team: string
  term_months: number | null
}

export async function listAdvanceRows(workspaceId: string): Promise<AdvanceRow[]> {
  return getDatabase().prepare<AdvanceRow>(`SELECT a.id, a.workspace_id, a.funding_event_id, a.deal_id, a.offer_id,
    a.offer_revision_id, a.funded_at, a.principal_cents, a.payback_cents, a.periodic_payment_cents, a.payment_count,
    a.payment_frequency, a.calendar_convention, a.status,
    COALESCE(NULLIF(d.dba_name,''), NULLIF(d.legal_name,''), d.display_id) business_name,
    o.funder_name, r.term_months,
    COALESCE((SELECT string_agg(u.name || ' (' || da.kind || ')', ', ' ORDER BY da.is_primary DESC, da.assigned_at)
      FROM deal_assignments da JOIN memberships m ON m.id=da.membership_id AND m.workspace_id=da.workspace_id
      JOIN users u ON u.id=m.user_id WHERE da.workspace_id=a.workspace_id AND da.deal_id=a.deal_id), '') assigned_team
    FROM mca_advances a JOIN deals d ON d.workspace_id=a.workspace_id AND d.id=a.deal_id
    JOIN mca_offers o ON o.workspace_id=a.workspace_id AND o.id=a.offer_id
    LEFT JOIN mca_offer_revisions r ON r.workspace_id=a.workspace_id AND r.id=a.offer_revision_id
    WHERE a.workspace_id = ? AND a.reversed_at IS NULL ORDER BY a.funded_at DESC, a.created_at DESC`).all(workspaceId)
}

export function findAdvanceRow(workspaceId: string, id: string, database: DbExecutor = getDatabase()): Promise<AdvanceRow | undefined> {
  return database.prepare<AdvanceRow>(`SELECT a.id, a.workspace_id, a.funding_event_id, a.deal_id, a.offer_id,
    a.offer_revision_id, a.funded_at, a.principal_cents, a.payback_cents, a.periodic_payment_cents, a.payment_count,
    a.payment_frequency, a.calendar_convention, a.status,
    COALESCE(NULLIF(d.dba_name,''), NULLIF(d.legal_name,''), d.display_id) business_name,
    o.funder_name, r.term_months,
    COALESCE((SELECT string_agg(u.name || ' (' || da.kind || ')', ', ' ORDER BY da.is_primary DESC, da.assigned_at)
      FROM deal_assignments da JOIN memberships m ON m.id=da.membership_id AND m.workspace_id=da.workspace_id
      JOIN users u ON u.id=m.user_id WHERE da.workspace_id=a.workspace_id AND da.deal_id=a.deal_id), '') assigned_team
    FROM mca_advances a JOIN deals d ON d.workspace_id=a.workspace_id AND d.id=a.deal_id
    JOIN mca_offers o ON o.workspace_id=a.workspace_id AND o.id=a.offer_id
    LEFT JOIN mca_offer_revisions r ON r.workspace_id=a.workspace_id AND r.id=a.offer_revision_id
    WHERE a.workspace_id = ? AND a.id = ?`).get(workspaceId, id)
}

export interface StatusHistoryRow { id: string; advance_id: string; status: AdvancePerformanceStatus; reason: string | null; effective_at: string }
export async function statusHistories(workspaceId: string): Promise<Map<string, StatusHistoryRow[]>> {
  const rows = await getDatabase().prepare<StatusHistoryRow>(`SELECT id,advance_id,status,reason,effective_at
    FROM mca_advance_status_history WHERE workspace_id=? ORDER BY effective_at DESC,created_at DESC`).all(workspaceId)
  const result = new Map<string, StatusHistoryRow[]>()
  for (const row of rows) result.set(row.advance_id, [...(result.get(row.advance_id) ?? []), row])
  return result
}

export async function latestPerformanceStatuses(workspaceId: string): Promise<Map<string, AdvancePerformanceStatus>> {
  const rows = await getDatabase().prepare<{ advance_id: string; status: AdvancePerformanceStatus }>(`SELECT DISTINCT ON (advance_id)
    advance_id, status FROM mca_advance_status_history WHERE workspace_id = ? ORDER BY advance_id, effective_at DESC, created_at DESC`).all(workspaceId)
  return new Map(rows.map((row) => [row.advance_id, row.status]))
}

export async function insertStatusHistory(database: DbExecutor, input: {
  workspaceId: string
  advanceId: string
  status: AdvancePerformanceStatus
  reason?: string
  effectiveAt: string
  actorUserId: string | null
  correlationId: string
}): Promise<{ id: string; inserted: boolean }> {
  const id = newId()
  const row = await database.prepare<{ id: string }>(`INSERT INTO mca_advance_status_history
    (id, workspace_id, advance_id, status, reason, effective_at, actor_user_id, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, advance_id, correlation_id) DO NOTHING RETURNING id`).get(
      id, input.workspaceId, input.advanceId, input.status, input.reason ?? null,
      input.effectiveAt, input.actorUserId, input.correlationId, nowIso(),
    )
  if (row) return { id: row.id, inserted: true }
  const replay = await database.prepare<{ id: string }>(`SELECT id FROM mca_advance_status_history
    WHERE workspace_id=? AND advance_id=? AND correlation_id=?`).get(input.workspaceId, input.advanceId, input.correlationId)
  if (!replay) throw new Error("Advance status conflict could not be replayed.")
  return { id: replay.id, inserted: false }
}
