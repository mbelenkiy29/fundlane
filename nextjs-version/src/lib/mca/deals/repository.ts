import "server-only"

import { decryptSensitive, encryptSensitive } from "../crypto"
import { getDatabase, newId, parseJson, withImmediateTransaction } from "../db"
import type { DbExecutor } from "../db"
import { einLookupHash, identityLookupHash } from "../merchants/lookup-hash"
import { upsertMerchantFromDeal } from "../merchants/repository"
import type {
  DealActivity,
  DealAssignment,
  DealFilters,
  DealNote,
  DealOfferSummary,
  DealOwner,
  DealRecord,
  DealSubmissionSummary,
  DealStatus,
  FieldSource,
} from "./schema"
import { inclusiveUtcDateBounds } from "./filters"

function db(): DbExecutor { return getDatabase() }

type Row = Record<string, string | number | null>

function decrypt(value: unknown, workspaceId: string): string | undefined {
  return typeof value === "string" && value ? decryptSensitive(value, workspaceId) : undefined
}

function encrypt(value: string | undefined, workspaceId: string): string | null {
  return value ? encryptSensitive(value, workspaceId) : null
}

const childOrder = {
  deal_owners: "id",
  deal_assignments: "assigned_at, id",
  deal_notes: "created_at, id",
  deal_activity: "created_at, id",
  deal_submissions: "id",
  deal_offers: "id",
} as const

async function rowsForDeal(database: DbExecutor, table: keyof typeof childOrder, workspaceId: string, dealId: string): Promise<Row[]> {
  return database.prepare<Row>(`SELECT * FROM ${table} WHERE workspace_id = ? AND deal_id = ? ORDER BY ${childOrder[table]}`).all(workspaceId, dealId)
}

async function hydrate(database: DbExecutor, row: Row): Promise<DealRecord> {
  const workspaceId = String(row.workspace_id)
  const dealId = String(row.id)
  const [ownerRows, assignmentRows, noteRows, activityRows, submissionRows, offerRows, currentOfferRows] = await Promise.all([
    rowsForDeal(database, "deal_owners", workspaceId, dealId),
    rowsForDeal(database, "deal_assignments", workspaceId, dealId),
    rowsForDeal(database, "deal_notes", workspaceId, dealId),
    rowsForDeal(database, "deal_activity", workspaceId, dealId),
    rowsForDeal(database, "deal_submissions", workspaceId, dealId),
    rowsForDeal(database, "deal_offers", workspaceId, dealId),
    database.prepare<Row>(`SELECT o.id, o.submission_id, r.state,
      EXISTS (SELECT 1 FROM mca_offer_revisions fr WHERE fr.workspace_id=o.workspace_id AND fr.offer_id=o.id AND fr.state='funded') AS funded,
      EXISTS (SELECT 1 FROM mca_offer_selections s WHERE s.workspace_id=o.workspace_id AND s.offer_id=o.id AND s.active=1) AS selected
      FROM mca_offers o LEFT JOIN mca_offer_revisions r ON r.workspace_id=o.workspace_id AND r.id=o.current_revision_id
      WHERE o.workspace_id=? AND o.deal_id=? ORDER BY o.created_at, o.id`).all(workspaceId, dealId),
  ])
  const owners = ownerRows.map((owner): DealOwner => ({
    id: String(owner.id),
    firstName: owner.first_name ? String(owner.first_name) : undefined,
    lastName: owner.last_name ? String(owner.last_name) : undefined,
    ownershipPercent: owner.ownership_percent === null ? undefined : Number(owner.ownership_percent),
    isPrimary: Boolean(owner.is_primary),
    dateOfBirth: decrypt(owner.date_of_birth_cipher, workspaceId),
    identityLast4: decrypt(owner.identity_last4_cipher, workspaceId),
    email: decrypt(owner.email_cipher, workspaceId),
    phone: decrypt(owner.phone_cipher, workspaceId),
  }))
  const assignments = assignmentRows.map((item): DealAssignment => ({
    id: String(item.id),
    membershipId: String(item.membership_id),
    kind: item.kind as DealAssignment["kind"],
    isPrimary: Boolean(item.is_primary),
    assignedAt: String(item.assigned_at),
    assignedByUserId: item.assigned_by_user_id ? String(item.assigned_by_user_id) : null,
  }))
  const notes = noteRows.map((item): DealNote => ({
    id: String(item.id), body: String(item.body), actorUserId: item.actor_user_id ? String(item.actor_user_id) : null, createdAt: String(item.created_at),
  }))
  const activity = activityRows.map((item): DealActivity => ({
    id: String(item.id), action: item.action as DealActivity["action"], actorUserId: item.actor_user_id ? String(item.actor_user_id) : null,
    source: item.source as DealActivity["source"], summary: String(item.summary),
    fromStatus: item.from_status ? item.from_status as DealStatus : undefined, toStatus: item.to_status ? item.to_status as DealStatus : undefined,
    createdAt: String(item.created_at), version: Number(item.record_version), correlationId: String(item.correlation_id),
  }))
  const submissions = submissionRows.map((item): DealSubmissionSummary => ({
    id: String(item.id), funderName: String(item.funder_name), status: item.status as DealSubmissionSummary["status"],
  }))
  const legacyOffers = offerRows.map((item): DealOfferSummary => ({
    id: String(item.id), submissionId: String(item.submission_id), status: item.status as DealOfferSummary["status"],
  }))
  const offers = [...new Map([...legacyOffers, ...currentOfferRows.map((item): DealOfferSummary => ({
    id: String(item.id), submissionId: item.submission_id ? String(item.submission_id) : "",
    status: item.funded ? "accepted" : item.state === "withdrawn" ? "declined" : item.selected ? "presented" : "received",
  }))].map((offer) => [offer.id, offer])).values()]
  return {
    id: dealId,
    workspaceId,
    merchantId: row.merchant_id ? String(row.merchant_id) : undefined,
    displayId: String(row.display_id),
    legalName: row.legal_name ? String(row.legal_name) : undefined,
    dbaName: row.dba_name ? String(row.dba_name) : undefined,
    ein: decrypt(row.ein_cipher, workspaceId),
    entityType: row.entity_type ? row.entity_type as DealRecord["entityType"] : undefined,
    address: parseJson(row.address_json, {}),
    contactName: row.contact_name ? String(row.contact_name) : undefined,
    contactEmail: decrypt(row.contact_email_cipher, workspaceId),
    contactPhone: decrypt(row.contact_phone_cipher, workspaceId),
    startDate: row.start_date ? String(row.start_date) : undefined,
    industry: row.industry ? String(row.industry) : undefined,
    naicsCode: row.naics_code ? String(row.naics_code) : undefined,
    monthlyRevenue: row.monthly_revenue === null ? undefined : Number(row.monthly_revenue),
    ficoScore: row.fico_score === null ? undefined : Number(row.fico_score),
    fundingPurpose: row.funding_purpose ? String(row.funding_purpose) : undefined,
    requestedAmount: row.requested_amount === null ? undefined : Number(row.requested_amount),
    status: row.status as DealStatus,
    pipelineVersion: 1,
    draftState: row.draft_state as DealRecord["draftState"],
    missingRequiredFields: parseJson(row.missing_required_json, []),
    owners,
    assignments,
    notes,
    activity,
    submissions,
    offers,
    fieldSources: parseJson<Record<string, FieldSource>>(row.field_sources_json, {}),
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function dealValues(record: DealRecord): Array<string | number | null> {
  return [
    record.id, record.workspaceId, record.displayId, record.legalName ?? null, record.dbaName ?? null,
    encrypt(record.ein, record.workspaceId), einLookupHash(record.workspaceId, record.ein) ?? null, record.entityType ?? null, JSON.stringify(record.address ?? {}), record.contactName ?? null,
    encrypt(record.contactEmail, record.workspaceId), encrypt(record.contactPhone, record.workspaceId), record.startDate ?? null,
    record.industry ?? null, record.naicsCode ?? null, record.monthlyRevenue ?? null, record.ficoScore ?? null,
    record.fundingPurpose ?? null, record.requestedAmount ?? null, record.status, record.pipelineVersion, record.draftState,
    JSON.stringify(record.missingRequiredFields), JSON.stringify(record.fieldSources), record.idempotencyKey ?? null,
    record.version, record.createdAt, record.updatedAt,
  ]
}

async function replaceChildren(database: DbExecutor, record: DealRecord): Promise<void> {
  for (const table of ["deal_owners", "deal_assignments"]) {
    await database.prepare(`DELETE FROM ${table} WHERE workspace_id = ? AND deal_id = ?`).run(record.workspaceId, record.id)
  }
  const ownerStatement = database.prepare(`INSERT INTO deal_owners
    (id, workspace_id, deal_id, first_name, last_name, ownership_percent, is_primary, date_of_birth_cipher, identity_last4_cipher, identity_last4_lookup_hash, email_cipher, phone_cipher)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const owner of record.owners) await ownerStatement.run(
    owner.id, record.workspaceId, record.id, owner.firstName ?? null, owner.lastName ?? null, owner.ownershipPercent ?? null,
    owner.isPrimary ? 1 : 0, encrypt(owner.dateOfBirth, record.workspaceId), encrypt(owner.identityLast4, record.workspaceId),
    identityLookupHash(record.workspaceId, owner.identityLast4) ?? null,
    encrypt(owner.email, record.workspaceId), encrypt(owner.phone, record.workspaceId),
  )
  const assignmentStatement = database.prepare(`INSERT INTO deal_assignments
    (id, workspace_id, deal_id, membership_id, kind, is_primary, assigned_at, assigned_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const assignment of record.assignments) await assignmentStatement.run(
    assignment.id, record.workspaceId, record.id, assignment.membershipId, assignment.kind,
    assignment.isPrimary ? 1 : 0, assignment.assignedAt, assignment.assignedByUserId,
  )
}

async function insertActivity(database: DbExecutor, workspaceId: string, dealId: string, item: DealActivity): Promise<void> {
  await database.prepare(`INSERT INTO deal_activity
    (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, workspaceId, dealId, item.action, item.actorUserId, item.source, item.summary,
      item.fromStatus ?? null, item.toStatus ?? null, item.version, item.correlationId, item.createdAt,
    )
}

export class DealVersionConflictError extends Error {
  constructor(public readonly current: DealRecord, public readonly expectedVersion: number) {
    super("This deal changed after you opened it.")
  }
}

export type DealMutationOutcome = "created" | "replayed" | "updated"
export type DealTransactionCheckpoint = (database: DbExecutor, persisted: DealRecord, outcome: DealMutationOutcome) => Promise<void>

export async function findDealById(workspaceId: string, id: string): Promise<DealRecord | undefined> {
  const database = db()
  const row = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(workspaceId, id)
  return row ? await hydrate(database, row) : undefined
}

export async function findDealByIdempotencyKey(workspaceId: string, key: string): Promise<DealRecord | undefined> {
  const database = db()
  const row = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, key)
  return row ? await hydrate(database, row) : undefined
}

export async function insertDeal(
  record: DealRecord,
  transactionCheckpoint?: DealTransactionCheckpoint,
  options?: { forceNewMerchant?: boolean },
): Promise<{ record: DealRecord; inserted: boolean }> {
  return withImmediateTransaction(async (database) => {
    const result = await database.prepare(`INSERT INTO deals
      (id, workspace_id, display_id, legal_name, dba_name, ein_cipher, ein_lookup_hash, entity_type, address_json, contact_name,
       contact_email_cipher, contact_phone_cipher, start_date, industry, naics_code, monthly_revenue, fico_score,
       funding_purpose, requested_amount, status, pipeline_version, draft_state, missing_required_json, field_sources_json,
       idempotency_key, version, created_at, updated_at)
      VALUES (${Array.from({ length: 28 }, () => "?").join(",")})
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`).run(...dealValues(record))
    if (result.changes === 0) {
      if (!record.idempotencyKey) throw new Error("Deal insert conflicted without an idempotency key")
      const existing = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND idempotency_key = ?").get(record.workspaceId, record.idempotencyKey)
      if (!existing) throw new Error("Deal insert conflicted but no idempotent record was found")
      const persisted = await hydrate(database, existing)
      persisted.merchantId = await upsertMerchantFromDeal({ ...persisted, merchantId: persisted.merchantId ?? record.merchantId }, database)
      await transactionCheckpoint?.(database, persisted, "replayed")
      return { record: persisted, inserted: false }
    }
    await replaceChildren(database, record)
    for (const item of record.activity) await insertActivity(database, record.workspaceId, record.id, item)
    const row = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(record.workspaceId, record.id)
    if (!row) throw new Error("Deal insert did not return a persisted row")
    const persisted = await hydrate(database, row)
    persisted.merchantId = await upsertMerchantFromDeal(
      { ...persisted, merchantId: record.merchantId ?? persisted.merchantId },
      database,
      { forceNew: options?.forceNewMerchant },
    )
    await transactionCheckpoint?.(database, persisted, "created")
    return { record: persisted, inserted: true }
  })
}

export async function updateDeal(record: DealRecord, expectedVersion: number, newActivity: DealActivity, transactionCheckpoint?: DealTransactionCheckpoint): Promise<DealRecord> {
  return withImmediateTransaction(async (database) => {
    const currentRow = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(record.workspaceId, record.id)
    if (!currentRow) throw new Error("Deal not found")
    if (Number(currentRow.version) !== expectedVersion) throw new DealVersionConflictError(await hydrate(database, currentRow), expectedVersion)
    const values = dealValues(record).slice(3)
    const result = await database.prepare(`UPDATE deals SET
      legal_name=?, dba_name=?, ein_cipher=?, ein_lookup_hash=?, entity_type=?, address_json=?, contact_name=?, contact_email_cipher=?,
      contact_phone_cipher=?, start_date=?, industry=?, naics_code=?, monthly_revenue=?, fico_score=?, funding_purpose=?,
      requested_amount=?, status=?, pipeline_version=?, draft_state=?, missing_required_json=?, field_sources_json=?,
      idempotency_key=?, version=?, created_at=?, updated_at=?
      WHERE workspace_id=? AND id=? AND version=?`).run(...values, record.workspaceId, record.id, expectedVersion)
    if (result.changes !== 1) {
      const latest = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(record.workspaceId, record.id)
      if (!latest) throw new Error("Deal not found")
      throw new DealVersionConflictError(await hydrate(database, latest), expectedVersion)
    }
    await replaceChildren(database, record)
    await insertActivity(database, record.workspaceId, record.id, newActivity)
    const persistedRow = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(record.workspaceId, record.id)
    if (!persistedRow) throw new Error("Deal not found")
    const persisted = await hydrate(database, persistedRow)
    persisted.merchantId = await upsertMerchantFromDeal({ ...persisted, merchantId: record.merchantId ?? persisted.merchantId }, database)
    await transactionCheckpoint?.(database, persisted, "updated")
    return persisted
  })
}

export async function insertNote(workspaceId: string, dealId: string, note: DealNote, activity: DealActivity, expectedVersion: number, updatedAt: string): Promise<DealRecord> {
  return withImmediateTransaction(async (database) => {
    const currentRow = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(workspaceId, dealId)
    if (!currentRow) throw new Error("Deal not found")
    if (Number(currentRow.version) !== expectedVersion) throw new DealVersionConflictError(await hydrate(database, currentRow), expectedVersion)
    const result = await database.prepare("UPDATE deals SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?")
      .run(updatedAt, workspaceId, dealId, expectedVersion)
    if (result.changes !== 1) throw new DealVersionConflictError(await hydrate(database, currentRow), expectedVersion)
    await database.prepare("INSERT INTO deal_notes (id, workspace_id, deal_id, body, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(note.id, workspaceId, dealId, note.body, note.actorUserId, note.createdAt)
    await insertActivity(database, workspaceId, dealId, activity)
    const row = await database.prepare<Row>("SELECT * FROM deals WHERE workspace_id = ? AND id = ?").get(workspaceId, dealId)
    if (!row) throw new Error("Deal not found")
    return hydrate(database, row)
  })
}

export async function activeMembershipIds(workspaceId: string): Promise<string[]> {
  return (await db().prepare<{ id: string }>("SELECT id FROM memberships WHERE workspace_id = ? AND status = 'active'").all(workspaceId)).map((row) => row.id)
}

export async function managedMembershipIds(workspaceId: string, managerMembershipId: string): Promise<string[]> {
  return (await db().prepare<{ id: string }>("SELECT id FROM memberships WHERE workspace_id = ? AND manager_membership_id = ? AND status = 'active'").all(workspaceId, managerMembershipId)).map((row) => row.id)
}

export async function listDealRecords(workspaceId: string, filters: DealFilters): Promise<DealRecord[]> {
  const database = db()
  const clauses = ["d.workspace_id = ?"]
  const values: Array<string | number> = [workspaceId]
  if (filters.search) {
    clauses.push("(LOWER(COALESCE(d.legal_name,'')) LIKE ? OR LOWER(COALESCE(d.dba_name,'')) LIKE ? OR LOWER(d.display_id) LIKE ?)")
    const term = `%${filters.search.toLowerCase()}%`
    values.push(term, term, term)
  }
  if (filters.statuses?.length) {
    clauses.push(`d.status IN (${filters.statuses.map(() => "?").join(",")})`)
    values.push(...filters.statuses)
  }
  if (filters.assignee) {
    clauses.push("EXISTS (SELECT 1 FROM deal_assignments da WHERE da.workspace_id=d.workspace_id AND da.deal_id=d.id AND da.membership_id=?)")
    values.push(filters.assignee)
  }
  const dateBounds = inclusiveUtcDateBounds(filters.createdFrom, filters.createdTo)
  if (dateBounds.from) { clauses.push("d.created_at >= ?"); values.push(dateBounds.from) }
  if (dateBounds.toExclusive) { clauses.push("d.created_at < ?"); values.push(dateBounds.toExclusive) }
  if (filters.funder) {
    clauses.push("EXISTS (SELECT 1 FROM deal_submissions ds WHERE ds.workspace_id=d.workspace_id AND ds.deal_id=d.id AND LOWER(ds.funder_name) LIKE ?)")
    values.push(`%${filters.funder.toLowerCase()}%`)
  }
  const rows = await database.prepare<Row>(`SELECT d.* FROM deals d WHERE ${clauses.join(" AND ")} ORDER BY d.updated_at DESC`).all(...values)
  return Promise.all(rows.map((row) => hydrate(database, row)))
}

export async function addSyntheticSubmission(workspaceId: string, dealId: string, funderName: string): Promise<void> {
  await db().prepare("INSERT INTO deal_submissions (id, workspace_id, deal_id, funder_name, status) VALUES (?, ?, ?, ?, 'sent')")
    .run(newId(), workspaceId, dealId, funderName)
}
