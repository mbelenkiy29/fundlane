import "server-only"

import { calculateOffer } from "../accounting/calculations"
import { writeFundingAccounting } from "../accounting/funding-writer"
import { getDatabase, newId, nowIso, parseJson, recordAuditEvent, withImmediateTransaction, type DbExecutor } from "../db"
import { getDealForDocument } from "../deals/service"
import { persistInstallments } from "../deals/remittance"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { assertLinkedSubmissionNotFunded, assertOfferRevisionEligibleForClosing, getOfferRevisionForClosing } from "../offers/service"
import { insertDealSubmissionCache } from "../submissions/repository"
import type { ConfirmFundingInput, FundingAccountingWriter, FundingResult, FundingSplitInput } from "./contracts"

type FundingRow = {
  id: string; deal_id: string; offer_id: string; offer_revision_id: string; advance_id: string
  funded_at: string; source: FundingResult["source"]; state: FundingResult["state"]; accounting_record_ids_json: string
}

function rowResult(row: FundingRow, replayed: boolean): FundingResult {
  return { fundingEventId: row.id, advanceId: row.advance_id, dealId: row.deal_id, offerId: row.offer_id, offerRevisionId: row.offer_revision_id, fundedAt: row.funded_at, source: row.source, state: row.state, accountingRecordIds: parseJson(row.accounting_record_ids_json, []), replayed }
}

function validDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(value) || Number.isNaN(Date.parse(value))) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: ["Use a valid ISO date or UTC timestamp."] })
  return value
}

function validMoney(value: number, field: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { [field]: [positive ? "Enter a positive whole number of cents." : "Enter a non-negative whole number of cents."] })
  return value
}

function validSplits(splits: FundingSplitInput[]): FundingSplitInput[] {
  if (!splits.length) return []
  const ids = new Set<string>(), total = splits.reduce((sum, split) => {
    if (!split.recipientMembershipId?.trim() || ids.has(split.recipientMembershipId)) throw new AppError(422, "validation_failed", "Split recipients must be unique active memberships.", { splits: ["Choose each recipient once."] })
    ids.add(split.recipientMembershipId)
    if (!Number.isInteger(split.percentageBasisPoints) || split.percentageBasisPoints <= 0) throw new AppError(422, "validation_failed", "Split percentages are invalid.", { splits: ["Use positive integer basis points."] })
    return sum + split.percentageBasisPoints
  }, 0)
  if (total !== 10_000) throw new AppError(422, "validation_failed", "Split percentages must total 100.00%.", { splits: ["Percentages must total 10,000 basis points."] })
  return splits.map((split) => ({ ...split, recipientMembershipId: split.recipientMembershipId.trim() }))
}

async function existingFunding(database: DbExecutor, workspaceId: string, idempotencyKey: string): Promise<FundingRow | undefined> {
  return database.prepare<FundingRow>("SELECT * FROM mca_funding_events WHERE workspace_id = ? AND idempotency_key = ?").get(workspaceId, idempotencyKey)
}

async function syncFundedSubmission(database: DbExecutor, input: {
  workspaceId: string; dealId: string; submissionJobId?: string
}): Promise<void> {
  if (!input.submissionJobId) return
  const job = await database.prepare<{ id: string; funder_id: string; display_funder_name: string; route_kind: "email" | "api" | "manual_portal" | "custom_webhook" }>(`SELECT id, funder_id, display_funder_name, route_kind
    FROM mca_submission_jobs WHERE workspace_id = ? AND deal_id = ? AND id = ? FOR UPDATE`).get(input.workspaceId, input.dealId, input.submissionJobId)
  if (!job) throw new AppError(409, "linked_submission_missing", "The offer's linked submission no longer exists.")
  await insertDealSubmissionCache({ workspaceId: input.workspaceId, dealId: input.dealId, funderName: job.display_funder_name, status: "approved", funderId: job.funder_id, jobId: job.id, routeKind: job.route_kind }, database)
  const cache = await database.prepare<{ id: string }>("SELECT id FROM deal_submissions WHERE workspace_id = ? AND deal_id = ? AND job_id = ? FOR UPDATE").get(input.workspaceId, input.dealId, job.id)
  if (!cache) throw new Error("Funded submission cache was not persisted")
  await database.prepare("UPDATE deal_offers SET status = 'accepted' WHERE workspace_id = ? AND deal_id = ? AND submission_id = ?").run(input.workspaceId, input.dealId, cache.id)
}

async function syncReversedSubmission(database: DbExecutor, input: {
  workspaceId: string; dealId: string; offerId: string
}): Promise<void> {
  const offer = await database.prepare<{ submission_id: string | null }>("SELECT submission_id FROM mca_offers WHERE workspace_id = ? AND deal_id = ? AND id = ?").get(input.workspaceId, input.dealId, input.offerId)
  if (!offer?.submission_id) return
  const remaining = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM mca_funding_events e
    JOIN mca_offers o ON o.workspace_id=e.workspace_id AND o.id=e.offer_id
    WHERE e.workspace_id = ? AND e.deal_id = ? AND o.submission_id = ? AND e.state = 'committed'`).get(input.workspaceId, input.dealId, offer.submission_id)
  if ((remaining?.count ?? 0) > 0) return
  const cache = await database.prepare<{ id: string }>("SELECT id FROM deal_submissions WHERE workspace_id = ? AND deal_id = ? AND job_id = ? FOR UPDATE").get(input.workspaceId, input.dealId, offer.submission_id)
  if (cache) await database.prepare("UPDATE deal_offers SET status = 'presented' WHERE workspace_id = ? AND deal_id = ? AND submission_id = ? AND status = 'accepted'").run(input.workspaceId, input.dealId, cache.id)
}

export async function confirmOfferFunding(
  actor: DealActor,
  input: ConfirmFundingInput,
  accountingWriter: FundingAccountingWriter = writeFundingAccounting,
): Promise<FundingResult> {
  await getDealForDocument(actor, input.dealId)
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) throw new AppError(422, "validation_failed", "A stable funding confirmation key is required.", { idempotencyKey: ["Use 1 to 160 characters."] })
  const fundedAt = validDate(input.fundedAt, "fundedAt")
  const expectedCommissionAt = input.expectedCommissionAt ? validDate(input.expectedCommissionAt, "expectedCommissionAt") : undefined
  const expectedFeeAt = input.expectedFeeAt ? validDate(input.expectedFeeAt, "expectedFeeAt") : undefined
  const firstReplay = await existingFunding(getDatabase(), actor.workspaceId, input.idempotencyKey.trim())
  if (firstReplay) {
    if (firstReplay.offer_revision_id !== input.offerRevisionId) throw new AppError(409, "funding_key_conflict", "This funding key already belongs to another offer revision.")
    return rowResult(firstReplay, true)
  }
  const snapshot = await getOfferRevisionForClosing(actor, { dealId: input.dealId, offerId: input.offerId, revisionId: input.offerRevisionId })
  const amountCents = validMoney(input.amountCents ?? snapshot.amountCents, "amountCents", true)
  const commissionCents = validMoney(input.commissionCents ?? snapshot.commissionCents ?? 0, "commissionCents")
  const feeCents = validMoney(input.feeCents ?? 0, "feeCents")
  const splits = validSplits(input.splits ?? [])
  if (input.paymentCount !== undefined && (!Number.isSafeInteger(input.paymentCount) || input.paymentCount <= 0)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { paymentCount: ["Enter a positive whole payment count."] })
  if (input.paymentFrequency !== undefined && !["daily", "weekly", "biweekly", "monthly"].includes(input.paymentFrequency)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { paymentFrequency: ["Choose a supported funding frequency."] })
  if (input.calendarConvention !== undefined && !["calendar_days", "business_days", "fixed_count"].includes(input.calendarConvention)) throw new AppError(422, "validation_failed", "Review the highlighted fields.", { calendarConvention: ["Choose a supported calendar convention."] })
  const paymentConfiguration = [input.paymentCount, input.paymentFrequency, input.calendarConvention]
  if (paymentConfiguration.some((value) => value !== undefined) && paymentConfiguration.some((value) => value === undefined)) throw new AppError(422, "validation_failed", "Payment count, frequency, and calendar convention must be supplied together.", { paymentCount: ["Complete all payment schedule fields."] })

  return withImmediateTransaction(async (database) => {
    const lockedOffer = await database.prepare<{ source: string; submission_id: string | null }>("SELECT source, submission_id FROM mca_offers WHERE workspace_id = ? AND deal_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.dealId, input.offerId)
    if (!lockedOffer) throw new AppError(404, "offer_not_found", "The offer was not found for this deal.")
    const replay = await existingFunding(database, actor.workspaceId, input.idempotencyKey.trim())
    if (replay) {
      if (replay.offer_revision_id !== input.offerRevisionId) throw new AppError(409, "funding_key_conflict", "This funding key already belongs to another offer revision.")
      return rowResult(replay, true)
    }
    const revision = await database.prepare<{ state: string; effective_at: string; expires_at: string; factor_rate_millionths: number | null; term_months: number | null; payment_amount_cents: number | null; payment_frequency: string | null }>(
      "SELECT state, effective_at, expires_at, factor_rate_millionths, term_months, payment_amount_cents, payment_frequency FROM mca_offer_revisions WHERE workspace_id = ? AND offer_id = ? AND id = ? FOR UPDATE",
    ).get(actor.workspaceId, input.offerId, input.offerRevisionId)
    const selection = await database.prepare<{ id: string }>("SELECT id FROM mca_offer_selections WHERE workspace_id = ? AND deal_id = ? AND offer_id = ? AND offer_revision_id = ? AND active = 1").get(actor.workspaceId, input.dealId, input.offerId, input.offerRevisionId)
    if (!revision || !selection || !["active", "superseded"].includes(revision.state)) throw new AppError(409, "offer_revision_ineligible", "The exact selected offer revision is no longer eligible for funding.")
    await assertLinkedSubmissionNotFunded(database, actor.workspaceId, lockedOffer.submission_id ?? undefined)
    assertOfferRevisionEligibleForClosing({
      ...snapshot,
      state: revision.state as typeof snapshot.state,
      selected: Boolean(selection),
      effectiveAt: revision.effective_at,
      expiresAt: revision.expires_at,
    })
    const alreadyFunded = await database.prepare<{ id: string }>("SELECT id FROM mca_funding_events WHERE workspace_id = ? AND offer_revision_id = ? AND state = 'committed'").get(actor.workspaceId, input.offerRevisionId)
    if (alreadyFunded) throw new AppError(409, "offer_already_funded", "This offer revision already has a committed funding event. Retry with its original confirmation key.")
    if (input.correctionOfEventId) {
      const corrected = await database.prepare<{ deal_id: string; state: string }>("SELECT deal_id, state FROM mca_funding_events WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.correctionOfEventId)
      if (!corrected || corrected.deal_id !== input.dealId || corrected.state !== "reversed") throw new AppError(422, "correction_event_ineligible", "A correction must reference a reversed funding event for this deal.")
    }

    const linkedSubmission = await database.prepare<{ id: string; source: "manual" | "historical" }>(`SELECT id, source FROM mca_manual_submissions
      WHERE workspace_id = ? AND deal_id = ? AND offer_id = ? ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`).get(actor.workspaceId, input.dealId, input.offerId)
    const manualSubmission = input.manualSubmissionId
      ? await database.prepare<{ id: string; source: "manual" | "historical" }>("SELECT id, source FROM mca_manual_submissions WHERE workspace_id = ? AND deal_id = ? AND id = ? AND offer_id = ? FOR UPDATE").get(actor.workspaceId, input.dealId, input.manualSubmissionId, input.offerId)
      : linkedSubmission
    if (input.manualSubmissionId && !manualSubmission) throw new AppError(422, "manual_submission_not_found", "The manual submission does not belong to this deal and offer.")
    const derivedSource = manualSubmission?.source ?? (lockedOffer.source === "historical" ? "historical" : "live")
    if (input.source && input.source !== derivedSource) throw new AppError(422, "funding_source_mismatch", "Funding source must match the server-side offer and submission history.")
    const source = derivedSource
    if (source !== "live" && (actor.source === "api_key" || !["admin", "super_admin"].includes(actor.role ?? ""))) throw new AppError(403, "manual_funding_not_allowed", "Manual and historical funding require a workspace administrator session.")
    const eventId = newId(), advanceId = newId(), createdAt = nowIso()
    const factorRate = revision.factor_rate_millionths === null ? undefined : (Number(revision.factor_rate_millionths) / 1_000_000).toString()
    const calculation = factorRate ? calculateOffer({ principalCents: amountCents, factorRate, commissionBasis: "principal", commissionPointsBasisPoints: 0, feesCents: feeCents, paymentCount: input.paymentCount, paymentFrequency: input.paymentFrequency, paymentCalendar: input.calendarConvention, suppliedPeriodicPaymentCents: revision.payment_amount_cents ?? undefined, commissionOverrideCents: commissionCents }) : null
    await database.prepare(`INSERT INTO mca_funding_events
      (id, workspace_id, deal_id, offer_id, offer_revision_id, advance_id, manual_submission_id, idempotency_key,
       funded_at, amount_cents, commission_cents, fee_cents, expected_commission_at, expected_fee_at, splits_json,
       accounting_record_ids_json, source, state, correction_of_event_id, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'committed', ?, ?, ?)`).run(
      eventId, actor.workspaceId, input.dealId, input.offerId, input.offerRevisionId, advanceId,
      manualSubmission?.id ?? null, input.idempotencyKey.trim(), fundedAt, amountCents, commissionCents, feeCents,
      expectedCommissionAt ?? null, expectedFeeAt ?? null, JSON.stringify(splits), source, input.correctionOfEventId ?? null, actor.userId, createdAt,
    )
    await database.prepare(`INSERT INTO mca_advances
      (id, workspace_id, funding_event_id, deal_id, offer_id, offer_revision_id, funded_at, principal_cents,
       payback_cents, periodic_payment_cents, payment_count, payment_frequency, calendar_convention,
       commission_cents, fee_cents, expected_commission_at, expected_fee_at, source, calculation_snapshot_json, status,
       status_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`).run(
      advanceId, actor.workspaceId, eventId, input.dealId, input.offerId, input.offerRevisionId, fundedAt,
      amountCents, calculation?.paybackCents ?? null, revision.payment_amount_cents ?? calculation?.periodicPaymentEstimateCents ?? null,
      input.paymentCount ?? null, input.paymentFrequency ?? revision.payment_frequency, input.calendarConvention ?? null,
      commissionCents, feeCents, expectedCommissionAt ?? null, expectedFeeAt ?? null, source, JSON.stringify(calculation), createdAt, createdAt,
    )
    const timezone = await database.prepare<{ timezone: string }>("SELECT timezone FROM workspaces WHERE id=?").get(actor.workspaceId)
    await persistInstallments(database, {
      workspaceId: actor.workspaceId, advanceId, fundedAt,
      paymentCount: input.paymentCount ?? null,
      paymentFrequency: input.paymentFrequency ?? revision.payment_frequency,
      calendarConvention: input.calendarConvention ?? null,
      periodicPaymentCents: revision.payment_amount_cents ?? calculation?.periodicPaymentEstimateCents ?? null,
      paybackCents: calculation?.paybackCents ?? null, createdAt,
      timeZone: timezone?.timezone?.trim() || "America/New_York",
    })
    let accounting: { recordIds: string[] }
    try {
      accounting = await accountingWriter(database, { workspaceId: actor.workspaceId, fundingEventId: eventId, advanceId, dealId: input.dealId, offerId: input.offerId, offerRevisionId: input.offerRevisionId, fundedAt, amountCents, commissionCents, feeCents, expectedCommissionAt, expectedFeeAt, splits, source, idempotencyKey: input.idempotencyKey.trim() })
    } catch (error) {
      if (error instanceof TypeError) throw new AppError(422, "accounting_validation_failed", error.message, { splits: [error.message] })
      throw error
    }
    await database.prepare("UPDATE mca_funding_events SET accounting_record_ids_json = ? WHERE workspace_id = ? AND id = ?").run(JSON.stringify(accounting.recordIds), actor.workspaceId, eventId)
    if (input.correctionOfEventId) await database.prepare("UPDATE mca_funding_events SET state = 'corrected' WHERE workspace_id = ? AND id = ? AND state = 'reversed'").run(actor.workspaceId, input.correctionOfEventId)
    await database.prepare("UPDATE mca_offer_revisions SET state = 'funded' WHERE workspace_id = ? AND id = ?").run(actor.workspaceId, input.offerRevisionId)
    if (manualSubmission) await database.prepare("UPDATE mca_manual_submissions SET state = 'funded', updated_at = ? WHERE workspace_id = ? AND id = ? AND offer_id = ?").run(createdAt, actor.workspaceId, manualSubmission.id, input.offerId)
    await syncFundedSubmission(database, { workspaceId: actor.workspaceId, dealId: input.dealId, submissionJobId: lockedOffer.submission_id ?? undefined })
    const deal = await database.prepare<{ status: string; version: number }>("SELECT status, version FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.dealId)
    if (!deal) throw new AppError(404, "deal_not_found", "The requested deal was not found.")
    const nextVersion = Number(deal.version) + (deal.status === "funded" ? 0 : 1)
    if (deal.status !== "funded") {
      await database.prepare("UPDATE deals SET status = 'funded', version = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(nextVersion, createdAt, actor.workspaceId, input.dealId)
      await database.prepare(`INSERT INTO deal_activity
        (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
        VALUES (?, ?, ?, 'status_changed', ?, ?, 'Funding confirmation created an advance and accounting records.', ?, 'funded', ?, ?, ?)`).run(
        newId(), actor.workspaceId, input.dealId, actor.userId, source === "historical" ? "import" : "manual", deal.status, nextVersion, actor.correlationId, createdAt,
      )
    }
    await recordAuditEvent({ context: actor, action: "offer.funded", resourceType: "funding_event", resourceId: eventId, metadata: { dealId: input.dealId, offerId: input.offerId, offerRevisionId: input.offerRevisionId, advanceId, fundedAt, source, accountingRecordIds: accounting.recordIds }, correlationId: actor.correlationId, executor: database })
    const saved = await existingFunding(database, actor.workspaceId, input.idempotencyKey.trim())
    if (!saved) throw new Error("Funding event was not persisted")
    return rowResult(saved, false)
  })
}

export async function getFundingForDeal(actor: DealActor, dealId: string): Promise<FundingResult[]> {
  await getDealForDocument(actor, dealId)
  const rows = await getDatabase().prepare<FundingRow>("SELECT * FROM mca_funding_events WHERE workspace_id = ? AND deal_id = ? ORDER BY funded_at, created_at, id").all(actor.workspaceId, dealId)
  return rows.map((row) => rowResult(row, false))
}

export async function reverseFundingEvent(actor: DealActor, input: { fundingEventId: string; reason: string; reversedAt: string }): Promise<FundingResult> {
  if (actor.source !== "user" || !["admin", "super_admin"].includes(actor.role ?? "")) throw new AppError(403, "funding_reversal_permission_required", "Funding reversals require a workspace administrator session.")
  const reason = input.reason?.trim()
  if (!reason || reason.length > 500) throw new AppError(422, "validation_failed", "A correction reason of at most 500 characters is required.", { reason: ["Explain why the funding is being reversed."] })
  const reversedAt = validDate(input.reversedAt, "reversedAt")
  return withImmediateTransaction(async (database) => {
    const row = await database.prepare<FundingRow>("SELECT * FROM mca_funding_events WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, input.fundingEventId)
    if (!row) throw new AppError(404, "funding_event_not_found", "The funding event was not found.")
    await getDealForDocument(actor, row.deal_id)
    if (row.state === "reversed") return rowResult(row, true)
    if (row.state !== "committed") throw new AppError(409, "funding_event_ineligible", "Only a committed funding event can be reversed.")
    await database.prepare("SELECT id FROM mca_advances WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, row.advance_id)
    await database.prepare("SELECT id FROM mca_accounting_payments WHERE workspace_id = ? AND funding_event_id = ? ORDER BY id FOR UPDATE").all(actor.workspaceId, row.id)
    await database.prepare(`SELECT id FROM mca_payment_distributions WHERE workspace_id = ?
      AND payment_id IN (SELECT id FROM mca_accounting_payments WHERE workspace_id = ? AND funding_event_id = ?)
      ORDER BY id FOR UPDATE`).all(actor.workspaceId, actor.workspaceId, row.id)
    const collected = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM mca_accounting_payments
      WHERE workspace_id = ? AND funding_event_id = ? AND (received_amount_cents > 0 OR status IN ('partial','received'))`).get(actor.workspaceId, row.id)
    const paid = await database.prepare<{ count: number }>(`SELECT count(*)::int count FROM mca_payment_distributions d
      JOIN mca_accounting_payments p ON p.workspace_id=d.workspace_id AND p.id=d.payment_id
      WHERE p.workspace_id = ? AND p.funding_event_id = ? AND d.status = 'paid'`).get(actor.workspaceId, row.id)
    if ((collected?.count ?? 0) > 0 || (paid?.count ?? 0) > 0) {
      throw new AppError(409, "funding_has_collected_history", "This funding has collected payments or paid distributions. Record an accounting adjustment instead of reversing immutable paid history.")
    }
    await database.prepare("UPDATE mca_funding_events SET state = 'reversed', reversed_at = ? WHERE workspace_id = ? AND id = ?").run(reversedAt, actor.workspaceId, row.id)
    await database.prepare("UPDATE mca_advances SET status = 'reversed', status_version = status_version + 1, reversed_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(reversedAt, reversedAt, actor.workspaceId, row.advance_id)
    await database.prepare("UPDATE mca_offer_revisions SET state = 'active' WHERE workspace_id = ? AND id = ? AND state = 'funded'").run(actor.workspaceId, row.offer_revision_id)
    await syncReversedSubmission(database, { workspaceId: actor.workspaceId, dealId: row.deal_id, offerId: row.offer_id })
    await database.prepare("UPDATE mca_accounting_payments SET status = 'void', updated_at = ? WHERE workspace_id = ? AND funding_event_id = ? AND status = 'expected'").run(reversedAt, actor.workspaceId, row.id)
    await database.prepare(`UPDATE mca_payment_distributions SET status = 'void', updated_at = ? WHERE workspace_id = ?
      AND payment_id IN (SELECT id FROM mca_accounting_payments WHERE workspace_id = ? AND funding_event_id = ?) AND status = 'expected'`).run(reversedAt, actor.workspaceId, actor.workspaceId, row.id)
    await database.prepare(`INSERT INTO mca_advance_status_history
      (id, workspace_id, advance_id, status, reason, effective_at, actor_user_id, correlation_id, created_at)
      VALUES (?, ?, ?, 'closed', ?, ?, ?, ?, ?)`).run(newId(), actor.workspaceId, row.advance_id, `Funding reversal: ${reason}`, reversedAt, actor.userId, `${actor.correlationId}:${row.id}:reversed`, nowIso())
    const deal = await database.prepare<{ status: string; version: number }>("SELECT status, version FROM deals WHERE workspace_id = ? AND id = ? FOR UPDATE").get(actor.workspaceId, row.deal_id)
    const otherCommitted = await database.prepare<{ count: number }>("SELECT count(*)::int count FROM mca_funding_events WHERE workspace_id = ? AND deal_id = ? AND state = 'committed'").get(actor.workspaceId, row.deal_id)
    const resetsDeal = deal?.status === "funded" && (otherCommitted?.count ?? 0) === 0
    const activityVersion = Number(deal?.version ?? 0) + (resetsDeal ? 1 : 0)
    if (resetsDeal) await database.prepare("UPDATE deals SET status = 'offer', version = ?, updated_at = ? WHERE workspace_id = ? AND id = ?").run(activityVersion, reversedAt, actor.workspaceId, row.deal_id)
    if (deal) await database.prepare(`INSERT INTO deal_activity
      (id, workspace_id, deal_id, action, actor_user_id, source, summary, from_status, to_status, record_version, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?)`).run(
        newId(), actor.workspaceId, row.deal_id, resetsDeal ? "status_changed" : "updated", actor.userId,
        `Funding event reversed: ${reason}`, deal.status, resetsDeal ? "offer" : deal.status, activityVersion,
        `${actor.correlationId}:${row.id}:reversed`, reversedAt,
      )
    await recordAuditEvent({ context: actor, action: "funding.reversed", resourceType: "funding_event", resourceId: row.id, metadata: { dealId: row.deal_id, advanceId: row.advance_id, reason, reversedAt, transferPerformed: false }, correlationId: actor.correlationId, executor: database })
    const saved = await database.prepare<FundingRow>("SELECT * FROM mca_funding_events WHERE workspace_id = ? AND id = ?").get(actor.workspaceId, row.id)
    if (!saved) throw new Error("Reversed funding event disappeared")
    return rowResult(saved, false)
  })
}
