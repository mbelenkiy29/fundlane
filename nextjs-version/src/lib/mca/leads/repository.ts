import "server-only"

import { getDatabase, newId, nowIso, withImmediateTransaction, type DbExecutor } from "../db"
import type { DealAcquisitionEvent, LeadProvider, LeadSourceKind, PurchaseBatch } from "./contracts"

type Row = Record<string, string | number | null>

function db(): DbExecutor {
  return getDatabase()
}

function providerFrom(row: Row, batchCount = 0): LeadProvider {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    kind: row.kind as LeadSourceKind,
    active: Number(row.active) === 1,
    createdAt: String(row.created_at),
    batchCount,
  }
}

function batchFrom(row: Row, dealCount = 0): PurchaseBatch {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceId: String(row.source_id),
    sourceName: row.source_name == null ? "" : String(row.source_name),
    name: String(row.name),
    purchasedOn: row.purchased_on == null ? null : String(row.purchased_on),
    costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    inactive: Number(row.inactive) === 1,
    createdAt: String(row.created_at),
    dealCount,
  }
}

function eventFrom(row: Row): DealAcquisitionEvent {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    dealId: String(row.deal_id),
    sourceId: row.source_id == null ? null : String(row.source_id),
    batchId: row.batch_id == null ? null : String(row.batch_id),
    costCents: row.cost_cents == null ? null : Number(row.cost_cents),
    purchasedOn: row.purchased_on == null ? null : String(row.purchased_on),
    actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
    correlationId: String(row.correlation_id),
    createdAt: String(row.created_at),
  }
}

export async function findProviderById(id: string): Promise<LeadProvider | undefined> {
  const row = await db().prepare<Row>("SELECT * FROM import_sources WHERE id = ?").get(id)
  return row ? providerFrom(row) : undefined
}

export async function findProvider(workspaceId: string, id: string): Promise<LeadProvider | undefined> {
  const row = await db().prepare<Row>("SELECT * FROM import_sources WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? providerFrom(row) : undefined
}

export async function listProviders(workspaceId: string): Promise<LeadProvider[]> {
  const rows = await db().prepare<Row>(`SELECT s.*, COALESCE(b.batch_count, 0)::int AS batch_count
    FROM import_sources s
    LEFT JOIN (SELECT source_id, COUNT(*)::int AS batch_count FROM lead_batches WHERE workspace_id = ? GROUP BY source_id) b
      ON b.source_id = s.id
    WHERE s.workspace_id = ?
    ORDER BY s.created_at, s.name`).all(workspaceId, workspaceId)
  return rows.map((row) => providerFrom(row, Number(row.batch_count ?? 0)))
}

export async function updateProvider(workspaceId: string, id: string, change: { name?: string; active?: boolean }): Promise<LeadProvider | undefined> {
  const current = await findProvider(workspaceId, id)
  if (!current) return undefined
  const name = change.name ?? current.name
  const active = change.active ?? current.active
  await db().prepare("UPDATE import_sources SET name = ?, active = ? WHERE workspace_id = ? AND id = ?").run(name, active ? 1 : 0, workspaceId, id)
  return { ...current, name, active }
}

const batchSelect = `SELECT b.*, s.name AS source_name,
    (
      SELECT COUNT(*)::int
      FROM (
        SELECT DISTINCT ON (deal_id) batch_id
        FROM mca_deal_acquisition_events
        WHERE workspace_id = b.workspace_id
        ORDER BY deal_id, created_at DESC, id DESC
      ) latest
      WHERE latest.batch_id = b.id
    ) AS deal_count
    FROM lead_batches b
    JOIN import_sources s ON s.id = b.source_id`

export async function findBatchById(id: string): Promise<PurchaseBatch | undefined> {
  const row = await db().prepare<Row>(`${batchSelect} WHERE b.id = ?`).get(id)
  return row ? batchFrom(row, Number(row.deal_count ?? 0)) : undefined
}

export async function findBatch(workspaceId: string, id: string): Promise<PurchaseBatch | undefined> {
  const row = await db().prepare<Row>(`${batchSelect} WHERE b.workspace_id = ? AND b.id = ?`).get(workspaceId, id)
  return row ? batchFrom(row, Number(row.deal_count ?? 0)) : undefined
}

export async function findBatchByName(workspaceId: string, sourceId: string, name: string): Promise<PurchaseBatch | undefined> {
  const row = await db().prepare<Row>(`${batchSelect} WHERE b.workspace_id = ? AND b.source_id = ? AND b.name = ?`).get(workspaceId, sourceId, name)
  return row ? batchFrom(row, Number(row.deal_count ?? 0)) : undefined
}

export async function listBatches(workspaceId: string): Promise<PurchaseBatch[]> {
  const rows = await db().prepare<Row>(`${batchSelect} WHERE b.workspace_id = ? ORDER BY b.created_at, b.name`).all(workspaceId)
  return rows.map((row) => batchFrom(row, Number(row.deal_count ?? 0)))
}

export async function applyBatchPurchaseFields(
  workspaceId: string,
  id: string,
  fields: { purchasedOn: string | null; costCents: number | null; inactive: boolean; name: string },
): Promise<PurchaseBatch | undefined> {
  await db().prepare(`UPDATE lead_batches SET name = ?, purchased_on = ?, cost_cents = ?, inactive = ?
    WHERE workspace_id = ? AND id = ?`).run(fields.name, fields.purchasedOn, fields.costCents, fields.inactive ? 1 : 0, workspaceId, id)
  return findBatch(workspaceId, id)
}

export async function listLatestAcquisitions(workspaceId: string): Promise<DealAcquisitionEvent[]> {
  const rows = await db().prepare<Row>(`SELECT DISTINCT ON (deal_id) *
    FROM mca_deal_acquisition_events
    WHERE workspace_id = ?
    ORDER BY deal_id, created_at DESC, id DESC`).all(workspaceId)
  return rows.map(eventFrom)
}

export async function listAcquisitionHistory(workspaceId: string, dealId: string): Promise<DealAcquisitionEvent[]> {
  const rows = await db().prepare<Row>(`SELECT * FROM mca_deal_acquisition_events
    WHERE workspace_id = ? AND deal_id = ?
    ORDER BY created_at, id`).all(workspaceId, dealId)
  return rows.map(eventFrom)
}

export async function findAcquisitionByCorrelation(workspaceId: string, correlationId: string, executor: DbExecutor = db()): Promise<DealAcquisitionEvent | undefined> {
  const row = await executor.prepare<Row>(`SELECT * FROM mca_deal_acquisition_events WHERE workspace_id = ? AND correlation_id = ?`).get(workspaceId, correlationId)
  return row ? eventFrom(row) : undefined
}

export async function insertAcquisitionEvent(input: {
  workspaceId: string
  dealId: string
  sourceId: string | null
  batchId: string | null
  costCents: number | null
  purchasedOn: string | null
  actorUserId: string | null
  correlationId: string
}, executor: DbExecutor = db()): Promise<{ event: DealAcquisitionEvent; inserted: boolean }> {
  const createdAt = nowIso()
  const id = newId()
  const row = await executor.prepare<Row>(`INSERT INTO mca_deal_acquisition_events
    (id, workspace_id, deal_id, source_id, batch_id, cost_cents, purchased_on, actor_user_id, correlation_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, correlation_id) DO NOTHING
    RETURNING *`).get(
    id, input.workspaceId, input.dealId, input.sourceId, input.batchId, input.costCents, input.purchasedOn,
    input.actorUserId, input.correlationId, createdAt,
  )
  if (row) return { event: eventFrom(row), inserted: true }
  const existing = await findAcquisitionByCorrelation(input.workspaceId, input.correlationId, executor)
  if (!existing) throw new Error("Acquisition event conflict did not return the stored row.")
  return { event: existing, inserted: false }
}

export async function listImportRunCreatedDeals(workspaceId: string, runId: string): Promise<Array<{ rowId: string; dealId: string; sourceId: string; batchId: string }>> {
  const rows = await db().prepare<Row>(`SELECT r.id AS row_id, r.deal_id, run.source_id, run.batch_id
    FROM import_rows r
    JOIN import_runs run ON run.id = r.run_id AND run.workspace_id = r.workspace_id
    WHERE r.workspace_id = ? AND r.run_id = ? AND r.deal_id IS NOT NULL
      AND r.state IN ('created','retried')
    ORDER BY r.row_number`).all(workspaceId, runId)
  return rows.map((row) => ({
    rowId: String(row.row_id),
    dealId: String(row.deal_id),
    sourceId: String(row.source_id),
    batchId: String(row.batch_id),
  }))
}

export async function withLeadsTransaction<T>(operation: (database: DbExecutor) => Promise<T>): Promise<T> {
  return withImmediateTransaction(operation)
}
