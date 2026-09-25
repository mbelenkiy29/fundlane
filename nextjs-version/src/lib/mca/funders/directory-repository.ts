import "server-only"

import { getDatabase, parseJson, withImmediateTransaction } from "../db"
import type { DbExecutor } from "../db"
import { SANDBOX_FUNDER_IDEMPOTENCY_KEY } from "../sandbox/labels"
import type { FunderContact, FunderGroup, FunderRecord, FunderRoute } from "./contracts"

export interface StoredFunder extends FunderRecord {
  idempotencyKey: string
}

type FunderRow = {
  id: string
  workspace_id: string
  idempotency_key: string
  legal_name: string
  nickname: string | null
  website: string | null
  domains: string
  products: string
  active: number
  contacts: string
  routes: string
  criteria_version: number
  profile_version: number
  created_at: string
  updated_at: string
}

type GroupRow = {
  id: string
  workspace_id: string
  name: string
  funder_ids: string
  created_at: string
  updated_at: string
}

function db() { return getDatabase() }

function fromFunderRow(row: FunderRow): StoredFunder {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    legalName: row.legal_name,
    nickname: row.nickname ?? undefined,
    website: row.website ?? undefined,
    domains: parseJson<string[]>(row.domains, []),
    products: parseJson<string[]>(row.products, []),
    active: Boolean(row.active),
    contacts: parseJson<FunderContact[]>(row.contacts, []),
    routes: parseJson<FunderRoute[]>(row.routes, []),
    criteriaVersion: row.criteria_version,
    profileVersion: row.profile_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function fromGroupRow(row: GroupRow): FunderGroup {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    funderIds: parseJson<string[]>(row.funder_ids, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toFunderRecord(record: StoredFunder): FunderRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    legalName: record.legalName,
    nickname: record.nickname,
    website: record.website,
    domains: record.domains,
    products: record.products,
    active: record.active,
    sandbox: record.idempotencyKey === SANDBOX_FUNDER_IDEMPOTENCY_KEY,
    contacts: record.contacts,
    routes: record.routes,
    criteriaVersion: record.criteriaVersion,
    profileVersion: record.profileVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export async function findFunderById(workspaceId: string, id: string): Promise<StoredFunder | undefined> {
  const row = await db().prepare<FunderRow>("SELECT * FROM mca_funders WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? fromFunderRow(row) : undefined
}

export async function findFunderByIdForUpdate(database: DbExecutor, workspaceId: string, id: string): Promise<StoredFunder | undefined> {
  const row = await database.prepare<FunderRow>("SELECT * FROM mca_funders WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, id)
  return row ? fromFunderRow(row) : undefined
}

export async function findFunderByIdempotencyKey(workspaceId: string, key: string): Promise<StoredFunder | undefined> {
  const row = await db().prepare<FunderRow>("SELECT * FROM mca_funders WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, key)
  return row ? fromFunderRow(row) : undefined
}

export async function findFunderByIdempotencyKeyForUpdate(database: DbExecutor, workspaceId: string, key: string): Promise<StoredFunder | undefined> {
  const row = await database.prepare<FunderRow>("SELECT * FROM mca_funders WHERE workspace_id = ? AND idempotency_key = ? FOR UPDATE").get(workspaceId, key)
  return row ? fromFunderRow(row) : undefined
}

export async function listFunderRecords(workspaceId: string, includeInactive = false): Promise<StoredFunder[]> {
  const sql = includeInactive
    ? "SELECT * FROM mca_funders WHERE workspace_id = ? ORDER BY active DESC, lower(legal_name), created_at"
    : "SELECT * FROM mca_funders WHERE workspace_id = ? AND active = 1 ORDER BY lower(legal_name), created_at"
  const rows = await db().prepare<FunderRow>(sql).all(workspaceId)
  return rows.map(fromFunderRow)
}

export async function insertFunder(record: StoredFunder): Promise<{ record: StoredFunder; inserted: boolean }> {
  return withImmediateTransaction(async (database) => {
    const result = await database.prepare(`INSERT INTO mca_funders
      (id, workspace_id, idempotency_key, legal_name, nickname, website, domains, products, active, contacts, routes,
       criteria_version, profile_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`).run(
      record.id, record.workspaceId, record.idempotencyKey, record.legalName, record.nickname ?? null, record.website ?? null,
      JSON.stringify(record.domains), JSON.stringify(record.products), record.active ? 1 : 0,
      JSON.stringify(record.contacts), JSON.stringify(record.routes), record.criteriaVersion, record.profileVersion,
      record.createdAt, record.updatedAt,
    )
    if (result.changes === 1) return { record, inserted: true }
    const replay = await database.prepare<FunderRow>("SELECT * FROM mca_funders WHERE workspace_id = ? AND idempotency_key = ?")
      .get(record.workspaceId, record.idempotencyKey)
    if (!replay) throw new Error("Funder insert conflicted but no idempotent record was found")
    return { record: fromFunderRow(replay), inserted: false }
  })
}

export async function updateFunderRecord(record: StoredFunder): Promise<StoredFunder> {
  await db().prepare(`UPDATE mca_funders SET
    legal_name = ?, nickname = ?, website = ?, domains = ?, products = ?, active = ?, contacts = ?, routes = ?,
    profile_version = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ?`).run(
    record.legalName, record.nickname ?? null, record.website ?? null, JSON.stringify(record.domains),
    JSON.stringify(record.products), record.active ? 1 : 0, JSON.stringify(record.contacts), JSON.stringify(record.routes),
    record.profileVersion, record.updatedAt, record.workspaceId, record.id,
  )
  const saved = await findFunderById(record.workspaceId, record.id)
  if (!saved) throw new Error("Funder not found after update")
  return saved
}

export async function findGroupById(workspaceId: string, id: string): Promise<FunderGroup | undefined> {
  const row = await db().prepare<GroupRow>("SELECT * FROM mca_funder_groups WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? fromGroupRow(row) : undefined
}

export async function findGroupByIdForUpdate(database: DbExecutor, workspaceId: string, id: string): Promise<FunderGroup | undefined> {
  const row = await database.prepare<GroupRow>("SELECT * FROM mca_funder_groups WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, id)
  return row ? fromGroupRow(row) : undefined
}

export async function listGroupRecords(workspaceId: string): Promise<FunderGroup[]> {
  const rows = await db().prepare<GroupRow>("SELECT * FROM mca_funder_groups WHERE workspace_id = ? ORDER BY lower(name), created_at")
    .all(workspaceId)
  return rows.map(fromGroupRow)
}

export async function insertGroup(record: FunderGroup): Promise<FunderGroup> {
  await db().prepare(`INSERT INTO mca_funder_groups (id, workspace_id, name, funder_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(record.id, record.workspaceId, record.name, JSON.stringify(record.funderIds), record.createdAt, record.updatedAt)
  return record
}

export async function updateGroupRecord(record: FunderGroup): Promise<FunderGroup> {
  await db().prepare("UPDATE mca_funder_groups SET name = ?, funder_ids = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
    .run(record.name, JSON.stringify(record.funderIds), record.updatedAt, record.workspaceId, record.id)
  const saved = await findGroupById(record.workspaceId, record.id)
  if (!saved) throw new Error("Funder group not found after update")
  return saved
}
