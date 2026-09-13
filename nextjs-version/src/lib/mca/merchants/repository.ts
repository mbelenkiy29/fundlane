import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, parseJson, type DbExecutor } from "../db"
import type { DealAddress, DealAssignment, DealOwner } from "../deals/schema"
import { einLookupHash, identityLookupHash } from "./lookup-hash"

type Row = Record<string, string | number | null>

export interface MerchantDealIdentity {
  id: string
  workspaceId: string
  merchantId?: string
  legalName?: string
  dbaName?: string
  ein?: string
  address?: DealAddress
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  owners: DealOwner[]
  updatedAt: string
}

export interface MerchantRow {
  id: string
  workspaceId: string
  legalName?: string
  dbaName?: string
  ein?: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  address: DealAddress
  createdAt: string
  updatedAt: string
  owners: DealOwner[]
}

export interface MerchantDealAccess {
  merchantId: string
  dealId: string
  updatedAt: string
  assignments: Pick<DealAssignment, "membershipId" | "kind">[]
}

function db(executor?: DbExecutor): DbExecutor {
  return executor ?? getDatabase()
}

function decrypt(value: unknown, workspaceId: string): string | undefined {
  return typeof value === "string" && value ? decryptSensitive(value, workspaceId) : undefined
}

function encrypt(value: string | undefined, workspaceId: string): string | null {
  return value ? encryptSensitive(value, workspaceId) : null
}

function merchantFrom(row: Row, owners: DealOwner[] = []): MerchantRow {
  const workspaceId = String(row.workspace_id)
  return {
    id: String(row.id),
    workspaceId,
    legalName: row.legal_name ? String(row.legal_name) : undefined,
    dbaName: row.dba_name ? String(row.dba_name) : undefined,
    ein: decrypt(row.ein_cipher, workspaceId),
    contactName: row.contact_name ? String(row.contact_name) : undefined,
    contactEmail: decrypt(row.contact_email_cipher, workspaceId),
    contactPhone: decrypt(row.contact_phone_cipher, workspaceId),
    address: parseJson(row.address_json, {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    owners,
  }
}

function ownerFrom(row: Row): DealOwner {
  const workspaceId = String(row.workspace_id)
  return {
    id: String(row.id),
    firstName: row.first_name ? String(row.first_name) : undefined,
    lastName: row.last_name ? String(row.last_name) : undefined,
    ownershipPercent: row.ownership_percent === null || row.ownership_percent === undefined ? undefined : Number(row.ownership_percent),
    isPrimary: Boolean(row.is_primary),
    dateOfBirth: decrypt(row.date_of_birth_cipher, workspaceId),
    identityLast4: decrypt(row.identity_last4_cipher, workspaceId),
    email: decrypt(row.email_cipher, workspaceId),
    phone: decrypt(row.phone_cipher, workspaceId),
  }
}

async function listOwners(database: DbExecutor, workspaceId: string, merchantId: string): Promise<DealOwner[]> {
  const rows = await database.prepare<Row>(
    "SELECT * FROM mca_merchant_owners WHERE workspace_id = ? AND merchant_id = ? ORDER BY id",
  ).all(workspaceId, merchantId)
  return rows.map(ownerFrom)
}

export async function findMerchantById(workspaceId: string, merchantId: string, executor?: DbExecutor): Promise<MerchantRow | undefined> {
  const database = db(executor)
  const row = await database.prepare<Row>("SELECT * FROM mca_merchants WHERE workspace_id = ? AND id = ?").get(workspaceId, merchantId)
  if (!row) return undefined
  return merchantFrom(row, await listOwners(database, workspaceId, merchantId))
}

export async function findMerchantByEinHash(workspaceId: string, hash: string, executor?: DbExecutor): Promise<MerchantRow | undefined> {
  const database = db(executor)
  const row = await database.prepare<Row>(
    "SELECT * FROM mca_merchants WHERE workspace_id = ? AND ein_lookup_hash = ? ORDER BY created_at, id",
  ).get(workspaceId, hash)
  if (!row) return undefined
  return merchantFrom(row, await listOwners(database, workspaceId, String(row.id)))
}

export async function listMerchantIdsByEinHash(workspaceId: string, hash: string, executor?: DbExecutor): Promise<string[]> {
  const rows = await db(executor).prepare<{ id: string }>(
    "SELECT id FROM mca_merchants WHERE workspace_id = ? AND ein_lookup_hash = ? ORDER BY created_at, id",
  ).all(workspaceId, hash)
  return rows.map((row) => row.id)
}

export async function listMerchantsByIds(workspaceId: string, merchantIds: string[], executor?: DbExecutor): Promise<MerchantRow[]> {
  if (!merchantIds.length) return []
  const database = db(executor)
  const rows = await database.prepare<Row>(
    `SELECT * FROM mca_merchants WHERE workspace_id = ? AND id IN (${merchantIds.map(() => "?").join(",")})`,
  ).all(workspaceId, ...merchantIds)
  return Promise.all(rows.map(async (row) => merchantFrom(row, await listOwners(database, workspaceId, String(row.id)))))
}

export async function listMerchantIdsByLast4Hashes(workspaceId: string, hashes: string[], executor?: DbExecutor): Promise<string[]> {
  if (!hashes.length) return []
  const rows = await db(executor).prepare<{ merchant_id: string }>(
    `SELECT DISTINCT merchant_id FROM mca_merchant_owners
     WHERE workspace_id = ? AND identity_last4_lookup_hash IN (${hashes.map(() => "?").join(",")})`,
  ).all(workspaceId, ...hashes)
  return rows.map((row) => row.merchant_id)
}

export async function listDealIdsByEinHash(workspaceId: string, hash: string, executor?: DbExecutor): Promise<string[]> {
  const rows = await db(executor).prepare<{ id: string }>(
    "SELECT id FROM deals WHERE workspace_id = ? AND ein_lookup_hash = ?",
  ).all(workspaceId, hash)
  return rows.map((row) => row.id)
}

export async function listDealIdsByLast4Hashes(workspaceId: string, hashes: string[], executor?: DbExecutor): Promise<string[]> {
  if (!hashes.length) return []
  const rows = await db(executor).prepare<{ deal_id: string }>(
    `SELECT DISTINCT deal_id FROM deal_owners
     WHERE workspace_id = ? AND identity_last4_lookup_hash IN (${hashes.map(() => "?").join(",")})`,
  ).all(workspaceId, ...hashes)
  return rows.map((row) => row.deal_id)
}

export interface DealAccessRow {
  dealId: string
  merchantId?: string
  updatedAt: string
  assignments: MerchantDealAccess["assignments"]
}

async function assignmentsForDeals(
  database: DbExecutor,
  workspaceId: string,
  dealIds: string[],
): Promise<Map<string, MerchantDealAccess["assignments"]>> {
  const assignmentsByDeal = new Map<string, MerchantDealAccess["assignments"]>()
  if (!dealIds.length) return assignmentsByDeal
  const assignmentRows = await database.prepare<{ deal_id: string; membership_id: string; kind: string }>(
    `SELECT deal_id, membership_id, kind FROM deal_assignments
     WHERE workspace_id = ? AND deal_id IN (${dealIds.map(() => "?").join(",")})`,
  ).all(workspaceId, ...dealIds)
  for (const row of assignmentRows) {
    const list = assignmentsByDeal.get(row.deal_id) ?? []
    list.push({ membershipId: row.membership_id, kind: row.kind as DealAssignment["kind"] })
    assignmentsByDeal.set(row.deal_id, list)
  }
  return assignmentsByDeal
}

export async function listDealAccessByIds(workspaceId: string, dealIds: string[], executor?: DbExecutor): Promise<DealAccessRow[]> {
  if (!dealIds.length) return []
  const database = db(executor)
  const deals = await database.prepare<{ id: string; merchant_id: string | null; updated_at: string }>(
    `SELECT id, merchant_id, updated_at FROM deals
     WHERE workspace_id = ? AND id IN (${dealIds.map(() => "?").join(",")})
     ORDER BY updated_at DESC, id DESC`,
  ).all(workspaceId, ...dealIds)
  const assignmentsByDeal = await assignmentsForDeals(database, workspaceId, deals.map((deal) => deal.id))
  return deals.map((deal) => ({
    dealId: deal.id,
    merchantId: deal.merchant_id ? String(deal.merchant_id) : undefined,
    updatedAt: deal.updated_at,
    assignments: assignmentsByDeal.get(deal.id) ?? [],
  }))
}

export async function listMerchantDealAccess(workspaceId: string, merchantIds: string[], executor?: DbExecutor): Promise<MerchantDealAccess[]> {
  if (!merchantIds.length) return []
  const database = db(executor)
  const deals = await database.prepare<{ id: string; merchant_id: string; updated_at: string }>(
    `SELECT id, merchant_id, updated_at FROM deals
     WHERE workspace_id = ? AND merchant_id IN (${merchantIds.map(() => "?").join(",")})
     ORDER BY updated_at DESC, id DESC`,
  ).all(workspaceId, ...merchantIds)
  const assignmentsByDeal = await assignmentsForDeals(database, workspaceId, deals.map((deal) => deal.id))
  return deals.map((deal) => ({
    merchantId: deal.merchant_id,
    dealId: deal.id,
    updatedAt: deal.updated_at,
    assignments: assignmentsByDeal.get(deal.id) ?? [],
  }))
}

export async function listDocumentSummariesForDeals(
  workspaceId: string,
  dealIds: string[],
  executor?: DbExecutor,
): Promise<Array<{ id: string; category: string; filename: string; dealId: string }>> {
  if (!dealIds.length) return []
  const rows = await db(executor).prepare<{ id: string; category: string; original_filename: string; deal_id: string }>(
    `SELECT id, category, original_filename, deal_id FROM mca_documents
     WHERE workspace_id = ? AND deal_id IN (${dealIds.map(() => "?").join(",")})
     ORDER BY created_at DESC, id DESC`,
  ).all(workspaceId, ...dealIds)
  return rows.map((row) => ({ id: row.id, category: row.category, filename: row.original_filename, dealId: row.deal_id }))
}

async function replaceMerchantOwners(database: DbExecutor, record: MerchantDealIdentity, merchantId: string): Promise<void> {
  await database.prepare("DELETE FROM mca_merchant_owners WHERE workspace_id = ? AND merchant_id = ?").run(record.workspaceId, merchantId)
  const statement = database.prepare(`INSERT INTO mca_merchant_owners
    (id, workspace_id, merchant_id, first_name, last_name, ownership_percent, is_primary, date_of_birth_cipher,
     identity_last4_cipher, identity_last4_lookup_hash, email_cipher, phone_cipher)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const owner of record.owners) {
    await statement.run(
      owner.id || newId(), record.workspaceId, merchantId, owner.firstName ?? null, owner.lastName ?? null,
      owner.ownershipPercent ?? null, owner.isPrimary ? 1 : 0, encrypt(owner.dateOfBirth, record.workspaceId),
      encrypt(owner.identityLast4, record.workspaceId), identityLookupHash(record.workspaceId, owner.identityLast4) ?? null,
      encrypt(owner.email, record.workspaceId), encrypt(owner.phone, record.workspaceId),
    )
  }
}

export async function upsertMerchantFromDeal(record: MerchantDealIdentity, executor?: DbExecutor): Promise<string> {
  const database = db(executor)
  const einHash = einLookupHash(record.workspaceId, record.ein)
  let merchantId = einHash
    ? (await database.prepare<{ id: string }>(
      "SELECT id FROM mca_merchants WHERE workspace_id = ? AND ein_lookup_hash = ?",
    ).get(record.workspaceId, einHash))?.id
    : undefined
  merchantId = merchantId ?? record.merchantId ?? newId()
  const existing = await database.prepare<{ id: string }>(
    "SELECT id FROM mca_merchants WHERE workspace_id = ? AND id = ?",
  ).get(record.workspaceId, merchantId)
  const values = [
    record.legalName ?? null, record.dbaName ?? null, encrypt(record.ein, record.workspaceId), einHash ?? null,
    record.contactName ?? null, encrypt(record.contactEmail, record.workspaceId), encrypt(record.contactPhone, record.workspaceId),
    JSON.stringify(record.address ?? {}), record.updatedAt, record.workspaceId, merchantId,
  ]
  if (existing) {
    await database.prepare(`UPDATE mca_merchants SET
      legal_name=?, dba_name=?, ein_cipher=?, ein_lookup_hash=?, contact_name=?,
      contact_email_cipher=?, contact_phone_cipher=?, address_json=?, updated_at=?
      WHERE workspace_id=? AND id=?`).run(...values)
  } else {
    await database.prepare(`INSERT INTO mca_merchants
      (legal_name, dba_name, ein_cipher, ein_lookup_hash, contact_name, contact_email_cipher, contact_phone_cipher,
       address_json, updated_at, workspace_id, id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values, record.updatedAt)
  }
  await replaceMerchantOwners(database, record, merchantId)
  await database.prepare("UPDATE deals SET merchant_id = ? WHERE workspace_id = ? AND id = ?").run(merchantId, record.workspaceId, record.id)
  return merchantId
}

export async function listWorkspaceDealRows(workspaceId?: string, executor?: DbExecutor): Promise<Row[]> {
  const database = db(executor)
  if (workspaceId) return database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? ORDER BY created_at, id").all(workspaceId)
  return database.prepare<Row>("SELECT * FROM deals ORDER BY workspace_id, created_at, id").all()
}

export async function listDealOwnerRows(workspaceId: string, dealId: string, executor?: DbExecutor): Promise<Row[]> {
  return db(executor).prepare<Row>("SELECT * FROM deal_owners WHERE workspace_id = ? AND deal_id = ? ORDER BY id").all(workspaceId, dealId)
}

export async function persistDealEinLookupHash(workspaceId: string, dealId: string, hash: string | null, executor?: DbExecutor): Promise<void> {
  await db(executor).prepare("UPDATE deals SET ein_lookup_hash = ? WHERE workspace_id = ? AND id = ?").run(hash, workspaceId, dealId)
}

export async function persistOwnerIdentityLookupHash(workspaceId: string, ownerId: string, hash: string | null, executor?: DbExecutor): Promise<void> {
  await db(executor).prepare("UPDATE deal_owners SET identity_last4_lookup_hash = ? WHERE workspace_id = ? AND id = ?").run(hash, workspaceId, ownerId)
}

export async function loadDealIdentity(workspaceId: string, dealId: string, executor?: DbExecutor): Promise<MerchantDealIdentity | undefined> {
  const database = db(executor)
  const row = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(workspaceId, dealId)
  if (!row) return undefined
  const owners = await listDealOwnerRows(workspaceId, dealId, database)
  return {
    id: String(row.id),
    workspaceId,
    merchantId: row.merchant_id ? String(row.merchant_id) : undefined,
    legalName: row.legal_name ? String(row.legal_name) : undefined,
    dbaName: row.dba_name ? String(row.dba_name) : undefined,
    ein: decrypt(row.ein_cipher, workspaceId),
    address: parseJson(row.address_json, {}),
    contactName: row.contact_name ? String(row.contact_name) : undefined,
    contactEmail: decrypt(row.contact_email_cipher, workspaceId),
    contactPhone: decrypt(row.contact_phone_cipher, workspaceId),
    updatedAt: String(row.updated_at),
    owners: owners.map(ownerFrom),
  }
}

export async function countMerchants(workspaceId?: string, executor?: DbExecutor): Promise<number> {
  const database = db(executor)
  const row = workspaceId
    ? await database.prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_merchants WHERE workspace_id = ?").get(workspaceId)
    : await database.prepare<{ count: number }>("SELECT COUNT(*)::int AS count FROM mca_merchants").get()
  return row?.count ?? 0
}
