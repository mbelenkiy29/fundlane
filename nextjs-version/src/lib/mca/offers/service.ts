import "server-only"

import { nowIso, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { getDealForDocument } from "../deals/service"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { isSplitFundProduct, offerRevisionValidity, type OfferRecord, type OfferRevision, type OfferRevisionForClosing, type OfferSource, type OfferTermsInput } from "./contracts"
import { findOffer, findOfferByExternal, insertOffer, insertOfferRevision, listOffers, OfferRevisionConflictError, setSelection } from "./repository"

const requiredTerms: Array<keyof OfferTermsInput> = ["amountCents", "factorRate", "termMonths", "paymentAmountCents", "paymentFrequency"]

function validateText(value: unknown, field: string, max = 300): string {
  if (typeof value !== "string" || !value.trim()) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: ["This field is required."] })
  if (value.trim().length > max) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [`Use at most ${max} characters.`] })
  return value.trim()
}

function assertIntegerMoney(value: number | undefined, field: string, positive = false): void {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [positive ? "Enter a positive whole number of cents." : "Enter a non-negative whole number of cents."] })
}

function normalizeTerms(input: OfferTermsInput): { terms: OfferTermsInput; incompleteFields: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(422, "validation_failed", "Offer terms must be an object.", { terms: ["Provide offer terms."] })
  assertIntegerMoney(input.amountCents, "amountCents", true)
  assertIntegerMoney(input.paymentAmountCents, "paymentAmountCents", true)
  assertIntegerMoney(input.feeCents, "feeCents")
  assertIntegerMoney(input.commissionCents, "commissionCents")
  for (const [field, value] of [["factorRate", input.factorRate], ["buyRate", input.buyRate], ["termMonths", input.termMonths]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: ["Enter a positive number."] })
  }
  if (input.termMonths !== undefined && !Number.isInteger(input.termMonths)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { termMonths: ["Use a whole number of months."] })
  if (input.paymentFrequency !== undefined && !["daily", "weekly", "biweekly", "monthly", "irregular"].includes(input.paymentFrequency)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { paymentFrequency: ["Choose a supported frequency."] })
  if (input.stipulations !== undefined && (!Array.isArray(input.stipulations) || input.stipulations.some((item) => typeof item !== "string" || !item.trim()))) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { stipulations: ["Each stipulation must contain text."] })
  const terms = { ...input, product: input.product?.trim() || undefined, stipulations: input.stipulations?.map((item) => item.trim()) ?? [] }
  return { terms, incompleteFields: requiredTerms.filter((field) => terms[field] === undefined).map(String) }
}

async function audit(database: DbExecutor, actor: DealActor, action: string, resourceId: string, metadata: Record<string, unknown>) {
  await recordAuditEvent({ context: actor, action, resourceType: "offer", resourceId, metadata, correlationId: actor.correlationId, executor: database })
}

async function syncDealToOffer(database: DbExecutor, actor: DealActor, dealId: string): Promise<void> {
  const deal = await database.prepare<{ status: string; version: number }>("SELECT status, version FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, dealId)
  if (!deal || !["ready_to_submit", "submitted", "resubmitting", "repricing"].includes(deal.status)) return
  const now = new Date().toISOString(), version = Number(deal.version) + 1
  await database.prepare("UPDATE deals SET status = 'offer', version = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(version, now, actor.workspaceId, dealId)
  await database.prepare(`INSERT INTO deal_activity
    (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
    VALUES (gen_random_uuid()::text, ?, ?, 'status_changed', ?, ?, 'Selected offer synchronized deal status.', ?, 'offer', ?, ?, ?)`).run(
    actor.workspaceId, dealId, actor.userId, actor.source === "api_key" ? "api" : "manual", deal.status, version, actor.correlationId, now,
  )
}

export async function getOffers(actor: DealActor, dealId: string): Promise<OfferRecord[]> {
  await getDealForDocument(actor, dealId)
  return listOffers(actor.workspaceId, dealId)
}

export async function createOffer(actor: DealActor, input: {
  dealId: string; submissionId?: string; funderId?: string; funderName: string; source?: OfferSource
  externalId?: string; terms: OfferTermsInput
}): Promise<OfferRecord> {
  await getDealForDocument(actor, input.dealId)
  const normalized = normalizeTerms(input.terms)
  if (input.source !== undefined && !["api", "email", "link", "manual", "historical"].includes(input.source)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { source: ["Choose a supported offer source."] })
  const source = input.source ?? "manual"
  if (input.externalId?.trim()) {
    const replay = await findOfferByExternal(actor.workspaceId, source, input.externalId.trim())
    if (replay) {
      if (replay.dealId !== input.dealId) throw new AppError(409, "offer_external_id_conflict", "This external offer ID already belongs to another deal.")
      return replay
    }
  }
  return withImmediateTransaction(async (database) => {
    if (input.externalId?.trim()) {
      await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`${actor.workspaceId}:${source}:${input.externalId.trim()}`)
      const replay = await findOfferByExternal(actor.workspaceId, source, input.externalId.trim(), database)
      if (replay) {
        if (replay.dealId !== input.dealId) throw new AppError(409, "offer_external_id_conflict", "This external offer ID already belongs to another deal.")
        return replay
      }
    }
    if (input.submissionId) {
      const submission = await database.prepare<{ id: string }>("SELECT id FROM mca_submission_jobs WHERE workspace_id = ? AND deal_id = ? AND id = ?").get(actor.workspaceId, input.dealId, input.submissionId)
      if (!submission) throw new AppError(422, "submission_not_found", "The selected submission does not belong to this deal.")
    }
    if (input.funderId) {
      const funder = await database.prepare<{ id: string }>("SELECT id FROM mca_funders WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, input.funderId)
      if (!funder) throw new AppError(422, "funder_not_found", "The selected funder does not belong to this workspace.")
    }
    const offer = await insertOffer({ workspaceId: actor.workspaceId, dealId: input.dealId, submissionId: input.submissionId, funderId: input.funderId, funderName: validateText(input.funderName, "funderName", 200), source, externalId: input.externalId?.trim() || undefined, terms: normalized.terms, incompleteFields: normalized.incompleteFields, createdByUserId: actor.userId }, database)
    await audit(database, actor, "offer.created", offer.id, { dealId: offer.dealId, revisionId: offer.currentRevisionId, source: offer.source, incompleteFields: normalized.incompleteFields })
    return offer
  })
}

export async function reviseOffer(actor: DealActor, offerId: string, input: { expectedRevisionNumber: number; terms: OfferTermsInput }): Promise<OfferRecord> {
  const existing = await findOffer(actor.workspaceId, offerId)
  if (!existing) throw new AppError(404, "offer_not_found", "The requested offer was not found.")
  await getDealForDocument(actor, existing.dealId)
  const normalized = normalizeTerms(input.terms)
  try {
    return await withImmediateTransaction(async (database) => {
      const offer = await insertOfferRevision({ workspaceId: actor.workspaceId, offerId, expectedRevisionNumber: input.expectedRevisionNumber, terms: normalized.terms, incompleteFields: normalized.incompleteFields, createdByUserId: actor.userId }, database)
      await audit(database, actor, "offer.revised", offer.id, { dealId: offer.dealId, revisionId: offer.currentRevisionId, revisionNumber: offer.revisions[offer.revisions.length - 1]?.revisionNumber, incompleteFields: normalized.incompleteFields })
      return offer
    })
  } catch (error) {
    if (error instanceof OfferRevisionConflictError) throw new AppError(409, "offer_revision_conflict", error.message, { expectedRevisionNumber: [`Current revision is ${error.currentRevisionNumber}.`] })
    throw error
  }
}

export async function selectOfferRevision(actor: DealActor, input: { dealId: string; offerId: string; revisionId: string; selected: boolean; reason?: string }): Promise<OfferRecord> {
  await getDealForDocument(actor, input.dealId)
  return withImmediateTransaction(async (database) => {
    await database.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`${actor.workspaceId}:offer-select:${input.dealId}`)
    await database.prepare("SELECT id FROM mca_offers WHERE workspace_id = ? AND deal_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.dealId, input.offerId)
    const offer = await findOffer(actor.workspaceId, input.offerId, database)
    if (!offer || offer.dealId !== input.dealId) throw new AppError(404, "offer_not_found", "The requested offer was not found.")
    const revision = offer.revisions.find((item) => item.id === input.revisionId)
    if (!revision) throw new AppError(404, "offer_revision_not_found", "The requested offer revision was not found.")
    if (input.selected) {
      if (revision.state !== "active") throw new AppError(409, "offer_revision_ineligible", "Only the current active revision can be newly selected.")
      assertOfferRevisionValidity(revision)
      await assertLinkedSubmissionNotFunded(database, actor.workspaceId, offer.submissionId)
      if (!offer.selectedRevisionIds.includes(revision.id)) {
        await assertAdditionalOfferSelectionAllowed(database, actor.workspaceId, input.dealId, input.offerId, revision.product)
      }
    }
    await setSelection({ workspaceId: actor.workspaceId, dealId: input.dealId, offerId: input.offerId, revisionId: input.revisionId, selected: input.selected, actorUserId: actor.userId, reason: input.reason?.trim() || undefined }, database)
    if (input.selected) await syncDealToOffer(database, actor, input.dealId)
    await audit(database, actor, input.selected ? "offer.selected" : "offer.deselected", offer.id, { dealId: offer.dealId, revisionId: revision.id, reason: input.reason?.trim() || undefined })
    const saved = await findOffer(actor.workspaceId, input.offerId, database)
    if (!saved) throw new Error("Offer disappeared after selection")
    return saved
  })
}

function requestedRevision(offer: OfferRecord, input: { revisionId?: string }): OfferRevision | undefined {
  return input.revisionId ? offer.revisions.find((item) => item.id === input.revisionId) : offer.revisions.find((item) => item.id === offer.currentRevisionId)
}

export async function getOfferRevisionForClosing(actor: DealActor, input: { dealId: string; offerId?: string; revisionId?: string }): Promise<OfferRevisionForClosing> {
  await getDealForDocument(actor, input.dealId)
  const offers = input.offerId ? [await findOffer(actor.workspaceId, input.offerId)].filter(Boolean) as OfferRecord[] : await listOffers(actor.workspaceId, input.dealId)
  const matches = offers.filter((offer) => offer.dealId === input.dealId).flatMap((offer) => {
    const revision = requestedRevision(offer, input)
    return revision ? [{ offer, revision }] : []
  })
  if (matches.length !== 1) throw new AppError(matches.length ? 409 : 404, matches.length ? "offer_revision_ambiguous" : "offer_revision_not_found", matches.length ? "Specify the exact offer revision." : "The requested offer revision was not found.")
  const { offer, revision } = matches[0]
  if (revision.amountCents === undefined) throw new AppError(409, "offer_terms_incomplete", "The offer revision has no funding amount.", { amountCents: ["Add an amount before continuing."] })
  return closingSnapshot(offer, revision)
}

export async function listOfferRevisionsForClosing(actor: DealActor, input: { dealId: string }): Promise<OfferRevisionForClosing[]> {
  await getDealForDocument(actor, input.dealId)
  const offers = await listOffers(actor.workspaceId, input.dealId)
  return offers.flatMap((offer) => {
    const included = new Set([offer.currentRevisionId, ...offer.selectedRevisionIds])
    return offer.revisions.filter((revision) => included.has(revision.id) && revision.amountCents !== undefined).map((revision) => closingSnapshot(offer, revision))
  })
}

function closingSnapshot(offer: OfferRecord, revision: OfferRevision): OfferRevisionForClosing {
  return {
    offerId: offer.id,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    state: revision.state,
    selected: offer.selectedRevisionIds.includes(revision.id),
    funderId: offer.funderId,
    funderName: offer.funderName,
    amountCents: revision.amountCents!,
    factorRate: revision.factorRate,
    termMonths: revision.termMonths,
    paymentAmountCents: revision.paymentAmountCents,
    paymentFrequency: revision.paymentFrequency,
    commissionCents: revision.commissionCents,
    effectiveAt: revision.effectiveAt ?? revision.createdAt,
    expiresAt: revision.expiresAt,
  }
}

async function assertAdditionalOfferSelectionAllowed(
  database: DbExecutor,
  workspaceId: string,
  dealId: string,
  offerId: string,
  incomingProduct: string | undefined,
): Promise<void> {
  const selected = await database.prepare<{ product: string | null }>(
    `SELECT r.product FROM mca_offer_selections s
     JOIN mca_offer_revisions r ON r.workspace_id = s.workspace_id AND r.id = s.offer_revision_id
     WHERE s.workspace_id = ? AND s.deal_id = ? AND s.active = 1 AND s.offer_id != ?`,
  ).all(workspaceId, dealId, offerId)
  const committed = await database.prepare<{ product: string | null }>(
    `SELECT r.product FROM mca_funding_events e
     JOIN mca_offer_revisions r ON r.workspace_id = e.workspace_id AND r.id = e.offer_revision_id
     WHERE e.workspace_id = ? AND e.deal_id = ? AND e.state = 'committed'`,
  ).all(workspaceId, dealId)
  if (selected.length === 0) return
  const incomingSplit = isSplitFundProduct(incomingProduct)
  const allSelectedSplit = selected.every((row) => isSplitFundProduct(row.product))
  const hasCommittedSplit = committed.some((row) => isSplitFundProduct(row.product))
  if (incomingSplit && allSelectedSplit) return
  if (incomingSplit && hasCommittedSplit && allSelectedSplit) return
  throw new AppError(409, "offer_selection_conflict", "This deal already has a selected offer revision.")
}

export function assertOfferRevisionValidity(revision: { effectiveAt?: string; expiresAt: string }, at = nowIso()): void {
  const validity = offerRevisionValidity(revision, at)
  if (validity === "expired") throw new AppError(409, "offer_revision_expired", "This offer revision has expired.")
  if (validity === "not_yet_effective") throw new AppError(409, "offer_revision_not_yet_effective", "This offer revision is not yet effective.")
}

export async function assertLinkedSubmissionNotFunded(database: DbExecutor, workspaceId: string, submissionId: string | undefined): Promise<void> {
  if (!submissionId) return
  const job = await database.prepare<{ state: string }>("SELECT state FROM mca_submission_jobs WHERE workspace_id = ? AND id = ?").get(workspaceId, submissionId)
  if (job?.state === "funded") throw new AppError(409, "offer_revision_ineligible", "The linked submission is already funded.")
}

export function assertOfferRevisionEligibleForClosing(snapshot: OfferRevisionForClosing): void {
  if (!snapshot.selected) throw new AppError(409, "offer_revision_not_selected", "Select this exact offer revision before continuing.")
  if (snapshot.state === "withdrawn" || snapshot.state === "funded") throw new AppError(409, "offer_revision_ineligible", `This offer revision is ${snapshot.state}.`)
  assertOfferRevisionValidity(snapshot)
}

export { offerRevisionValidity }
