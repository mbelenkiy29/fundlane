import "server-only"

import { getDatabase, newId, nowIso, parseJson, type DbExecutor } from "../db"
import type { OfferRecord, OfferRevision, OfferRevisionState, OfferSource, OfferTermsInput, PaymentFrequency } from "./contracts"

type OfferRow = {
  id: string; workspace_id: string; deal_id: string; submission_id: string | null; funder_id: string | null
  funder_name: string; source: OfferSource; external_id: string | null; current_revision_id: string | null
  created_at: string; updated_at: string
}
type RevisionRow = {
  id: string; revision_number: number; state: OfferRevisionState; product: string | null; amount_cents: number | null
  factor_rate_millionths: number | null; buy_rate_millionths: number | null; term_months: number | null
  payment_amount_cents: number | null; payment_frequency: PaymentFrequency | null; fee_cents: number | null
  commission_cents: number | null; stipulations_json: string; incomplete_fields_json: string
  effective_at: string; created_by_user_id: string | null; created_at: string
}

const fromMillionths = (value: number | null) => value === null ? undefined : Number(value) / 1_000_000
const toMillionths = (value: number | undefined) => value === undefined ? null : Math.round(value * 1_000_000)

function revisionFromRow(row: RevisionRow): OfferRevision {
  return {
    id: row.id,
    revisionNumber: Number(row.revision_number),
    state: row.state,
    product: row.product ?? undefined,
    amountCents: row.amount_cents === null ? undefined : Number(row.amount_cents),
    factorRate: fromMillionths(row.factor_rate_millionths),
    buyRate: fromMillionths(row.buy_rate_millionths),
    termMonths: row.term_months === null ? undefined : Number(row.term_months),
    paymentAmountCents: row.payment_amount_cents === null ? undefined : Number(row.payment_amount_cents),
    paymentFrequency: row.payment_frequency ?? undefined,
    feeCents: row.fee_cents === null ? undefined : Number(row.fee_cents),
    commissionCents: row.commission_cents === null ? undefined : Number(row.commission_cents),
    stipulations: parseJson(row.stipulations_json, []),
    incompleteFields: parseJson(row.incomplete_fields_json, []),
    effectiveAt: row.effective_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  }
}

async function hydrate(database: DbExecutor, row: OfferRow): Promise<OfferRecord> {
  const revisions = (await database.prepare<RevisionRow>(
    "SELECT * FROM mca_offer_revisions WHERE workspace_id = ? AND offer_id = ? ORDER BY revision_number ASC",
  ).all(row.workspace_id, row.id)).map(revisionFromRow)
  const selected = await database.prepare<{ offer_revision_id: string }>(
    "SELECT offer_revision_id FROM mca_offer_selections WHERE workspace_id = ? AND offer_id = ? AND active = 1 ORDER BY selected_at, id",
  ).all(row.workspace_id, row.id)
  return {
    id: row.id, workspaceId: row.workspace_id, dealId: row.deal_id,
    submissionId: row.submission_id ?? undefined, funderId: row.funder_id ?? undefined,
    funderName: row.funder_name, source: row.source, externalId: row.external_id ?? undefined,
    currentRevisionId: row.current_revision_id ?? revisions[revisions.length - 1]?.id ?? "",
    revisions, selectedRevisionIds: selected.map((item) => item.offer_revision_id),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

export async function findOffer(workspaceId: string, offerId: string, database: DbExecutor = getDatabase()): Promise<OfferRecord | undefined> {
  const row = await database.prepare<OfferRow>("SELECT * FROM mca_offers WHERE workspace_id = ? AND id = ?").get(workspaceId, offerId)
  return row ? hydrate(database, row) : undefined
}

export async function findOfferByExternal(workspaceId: string, source: OfferSource, externalId: string, database: DbExecutor = getDatabase()): Promise<OfferRecord | undefined> {
  const row = await database.prepare<OfferRow>("SELECT * FROM mca_offers WHERE workspace_id = ? AND source = ? AND external_id = ?").get(workspaceId, source, externalId)
  return row ? hydrate(database, row) : undefined
}

export async function listOffers(workspaceId: string, dealId: string, database: DbExecutor = getDatabase()): Promise<OfferRecord[]> {
  const rows = await database.prepare<OfferRow>(
    "SELECT * FROM mca_offers WHERE workspace_id = ? AND deal_id = ? ORDER BY created_at, id",
  ).all(workspaceId, dealId)
  return Promise.all(rows.map((row) => hydrate(database, row)))
}

export interface NewOfferInput {
  workspaceId: string; dealId: string; submissionId?: string; funderId?: string; funderName: string
  source: OfferSource; externalId?: string; terms: OfferTermsInput; incompleteFields: string[]; createdByUserId: string | null
}

async function insertRevision(database: DbExecutor, input: {
  id: string; workspaceId: string; offerId: string; revisionNumber: number; state: OfferRevisionState
  terms: OfferTermsInput; incompleteFields: string[]; createdByUserId: string | null; createdAt: string
}): Promise<void> {
  await database.prepare(`INSERT INTO mca_offer_revisions
    (id, workspace_id, offer_id, revision_number, state, product, amount_cents, factor_rate_millionths,
     buy_rate_millionths, term_months, payment_amount_cents, payment_frequency, fee_cents, commission_cents,
     stipulations_json, incomplete_fields_json, effective_at, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id, input.workspaceId, input.offerId, input.revisionNumber, input.state, input.terms.product ?? null,
    input.terms.amountCents ?? null, toMillionths(input.terms.factorRate), toMillionths(input.terms.buyRate),
    input.terms.termMonths ?? null, input.terms.paymentAmountCents ?? null, input.terms.paymentFrequency ?? null,
    input.terms.feeCents ?? null, input.terms.commissionCents ?? null, JSON.stringify(input.terms.stipulations ?? []),
    JSON.stringify(input.incompleteFields), input.terms.effectiveAt ?? input.createdAt, input.createdByUserId, input.createdAt,
  )
}

export async function insertOffer(input: NewOfferInput, database: DbExecutor): Promise<OfferRecord> {
  const offerId = newId(), revisionId = newId(), now = nowIso()
  await database.prepare(`INSERT INTO mca_offers
    (id, workspace_id, deal_id, submission_id, funder_id, funder_name, source, external_id, current_revision_id, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    offerId, input.workspaceId, input.dealId, input.submissionId ?? null, input.funderId ?? null, input.funderName,
    input.source, input.externalId ?? null, revisionId, input.createdByUserId, now, now,
  )
  await insertRevision(database, { id: revisionId, workspaceId: input.workspaceId, offerId, revisionNumber: 1, state: "active", terms: input.terms, incompleteFields: input.incompleteFields, createdByUserId: input.createdByUserId, createdAt: now })
  const saved = await findOffer(input.workspaceId, offerId, database)
  if (!saved) throw new Error("Offer was not persisted")
  return saved
}

export async function insertOfferRevision(input: {
  workspaceId: string; offerId: string; expectedRevisionNumber: number; terms: OfferTermsInput
  incompleteFields: string[]; createdByUserId: string | null
}, database: DbExecutor): Promise<OfferRecord> {
  const locked = await database.prepare<OfferRow>("SELECT * FROM mca_offers WHERE workspace_id = ? AND id = ? FOR UPDATE").get(input.workspaceId, input.offerId)
  if (!locked) throw new Error("Offer not found")
  const current = await database.prepare<RevisionRow>("SELECT * FROM mca_offer_revisions WHERE workspace_id = ? AND id = ?").get(input.workspaceId, locked.current_revision_id)
  if (!current) throw new Error("Current offer revision not found")
  if (Number(current.revision_number) !== input.expectedRevisionNumber) throw new OfferRevisionConflictError(Number(current.revision_number))
  const id = newId(), now = nowIso(), nextNumber = Number(current.revision_number) + 1
  if (current.state === "active") await database.prepare("UPDATE mca_offer_revisions SET state = 'superseded' WHERE workspace_id = ? AND id = ?").run(input.workspaceId, current.id)
  await insertRevision(database, { id, workspaceId: input.workspaceId, offerId: input.offerId, revisionNumber: nextNumber, state: "active", terms: input.terms, incompleteFields: input.incompleteFields, createdByUserId: input.createdByUserId, createdAt: now })
  await database.prepare("UPDATE mca_offers SET current_revision_id = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(id, now, input.workspaceId, input.offerId)
  const saved = await findOffer(input.workspaceId, input.offerId, database)
  if (!saved) throw new Error("Revised offer was not persisted")
  return saved
}

export class OfferRevisionConflictError extends Error {
  constructor(public readonly currentRevisionNumber: number) { super("This offer changed after you opened it.") }
}

export async function setSelection(input: {
  workspaceId: string; dealId: string; offerId: string; revisionId: string; selected: boolean
  actorUserId: string | null; reason?: string
}, database: DbExecutor): Promise<void> {
  const now = nowIso()
  if (!input.selected) {
    await database.prepare(`UPDATE mca_offer_selections SET active = 0, deselected_by_user_id = ?, deselected_at = ?, reason = ?
      WHERE workspace_id = ? AND deal_id = ? AND offer_id = ? AND offer_revision_id = ? AND active = 1`).run(input.actorUserId, now, input.reason ?? null, input.workspaceId, input.dealId, input.offerId, input.revisionId)
    return
  }
  const active = await database.prepare<{ offer_revision_id: string }>(`SELECT offer_revision_id FROM mca_offer_selections
    WHERE workspace_id = ? AND deal_id = ? AND offer_id = ? AND active = 1`).get(input.workspaceId, input.dealId, input.offerId)
  if (active?.offer_revision_id === input.revisionId) return
  await database.prepare(`UPDATE mca_offer_selections SET active = 0, deselected_by_user_id = ?, deselected_at = ?, reason = ?
    WHERE workspace_id = ? AND deal_id = ? AND offer_id = ? AND active = 1`).run(input.actorUserId, now, "selection_replaced", input.workspaceId, input.dealId, input.offerId)
  await database.prepare(`INSERT INTO mca_offer_selections
    (id, workspace_id, deal_id, offer_id, offer_revision_id, active, selected_by_user_id, selected_at, reason)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(newId(), input.workspaceId, input.dealId, input.offerId, input.revisionId, input.actorUserId, now, input.reason ?? null)
}
