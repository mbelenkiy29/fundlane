import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { isSplitFundProduct, offerRevisionValidity } from "../src/lib/mca/offers/contracts"
import { assertOfferRevisionEligibleForClosing, createOffer, getOfferRevisionForClosing, reviseOffer, selectOfferRevision } from "../src/lib/mca/offers/service"
import { approveManualSubmission, createManualSubmission } from "../src/lib/mca/offers/manual-submissions"
import { confirmOfferFunding, reverseFundingEvent } from "../src/lib/mca/funding/service"
import { commitHistoricalImport, previewHistoricalImport } from "../src/lib/mca/historical/service"
import { getDeal } from "../src/lib/mca/deals/service"
import { writeFundingAccounting } from "../src/lib/mca/accounting/funding-writer"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-02T00:00:00.000Z"
const ids = { workspace: "ws-offers", user: "user-admin", member: "member-admin", repUser: "user-rep", rep: "member-rep", deal: "deal-offers", secondDeal: "deal-second" }
const admin: DealActor = { workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.member, ids.rep], source: "user", correlationId: "corr-offers" }
const apiActor: DealActor = { ...admin, userId: null, membershipId: null, role: null, source: "api_key", correlationId: "corr-api" }

async function queryRow<T>(sql: string, values: unknown[] = []): Promise<T> {
  return (await fixture.query(sql, values)).rows[0] as T
}

async function queryRows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await fixture.query(sql, values)).rows as T[]
}

async function clearActiveSelections(dealId = ids.deal): Promise<void> {
  await getDatabase().prepare(
    "UPDATE mca_offer_selections SET active = 0, deselected_at = ?, reason = ? WHERE workspace_id = ? AND deal_id = ? AND active = 1",
  ).run(now, "test_clear", ids.workspace, dealId)
}

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,?,?,?,?)`).run(ids.workspace, "Offer Test", JSON.stringify({ reports: true, payments: true, integrations: true }), JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-OFFER-A',?,?),(?,?,?,'APP-OFFER-R',?,?)`).run(ids.user, "admin@offers.test", "Admin", now, now, ids.repUser, "rep@offers.test", "Rep", now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?)`).run(ids.member, ids.workspace, ids.user, now, now, ids.rep, ids.workspace, ids.repUser, now, now)
  for (const [deal, display] of [[ids.deal, "MCA-OFFER"], [ids.secondDeal, "MCA-SECOND"]]) {
    await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
      VALUES (?,?,?,'Synthetic Merchant','submitted',1,'submission_ready','[]','{}',1,?,?)`).run(deal, ids.workspace, display, now, now)
    await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id)
      VALUES (?,?,?,?, 'originator',1,?,?)`).run(`assignment-${deal}`, ids.workspace, deal, ids.member, now, ids.user)
  }
  await db.prepare("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES ('legacy-submission',?,?, 'Legacy Capital','approved')").run(ids.workspace, ids.deal)
  await db.prepare("INSERT INTO deal_offers (id,workspace_id,deal_id,submission_id,status) VALUES ('legacy-offer',?,?,'legacy-submission','accepted')").run(ids.workspace, ids.deal)
  await db.prepare(`INSERT INTO mca_funders
    (id,workspace_id,idempotency_key,legal_name,domains,products,active,contacts,routes,criteria_version,profile_version,created_at,updated_at)
    VALUES ('provider-funder',?,'provider-funder','Provider Funding','[]','[]',1,'[]','[]',1,1,?,?)`).run(ids.workspace, now, now)
  await db.prepare(`INSERT INTO mca_submission_jobs
    (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_by_user_id,created_at,updated_at)
    VALUES ('provider-job',?,?,'provider-funder','Provider Funding','api','{}','sent','provider-confirm','provider-attempt',1,'[]','{"documentIds":[]}','[]',?,?,?)`).run(ids.workspace, ids.deal, ids.user, now, now)
  await db.prepare(`INSERT INTO mca_submission_attempts
    (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,external_ref,created_at)
    VALUES ('provider-attempt-row',?,'provider-job','provider-attempt','api','sent','provider-transport-correlation','provider-external-ref',?)`).run(ids.workspace, now)
  await db.prepare("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id,job_id,route_kind) VALUES ('provider-submission',?,?,'Provider Funding','sent','provider-funder','provider-job','api')").run(ids.workspace, ids.deal)
  await db.prepare("INSERT INTO deal_offers (id,workspace_id,deal_id,submission_id,status,source,terms_unknown) VALUES ('provider-offer-cache',?,?,'provider-submission','presented','api',0)").run(ids.workspace, ids.deal)
}

before(async () => { fixture = await createPostgresTestDatabase("milestone05_offers"); Object.assign(process.env, fixture.env()); await seed() })
after(async () => { await closeDatabaseForTests(); await fixture.close() })

test("MIC-109 retains revisions and exact selection history without moving a deal for unselected changes", async () => {
  const unselected = await createOffer(admin, { dealId: ids.secondDeal, funderName: "Unselected Capital", externalId: "unselected-1", terms: { amountCents: 4_000_000 } })
  const revisedUnselected = await reviseOffer(admin, unselected.id, { expectedRevisionNumber: 1, terms: { amountCents: 4_500_000, factorRate: 1.3 } })
  assert.equal(revisedUnselected.revisions.length, 2)
  assert.equal(revisedUnselected.revisions[0].amountCents, 4_000_000)
  assert.equal((await queryRow<{ status: string }>("SELECT status FROM deals WHERE id=$1", [ids.secondDeal])).status, "submitted")

  const offer = await createOffer(admin, { dealId: ids.deal, funderName: "Northstar Capital", externalId: "offer-1", terms: { product: "MCA", amountCents: 5_000_000, factorRate: 1.35, termMonths: 8, paymentAmountCents: 37_500, paymentFrequency: "daily", commissionCents: 400_000 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true })
  const hydrated = await getDeal(admin, ids.deal)
  assert.equal(hydrated.offers.find((item) => item.id === offer.id)?.status, "presented")
  assert.equal(hydrated.offers.find((item) => item.id === "legacy-offer")?.status, "accepted")
  const revised = await reviseOffer(admin, offer.id, { expectedRevisionNumber: 1, terms: { product: "MCA", amountCents: 5_500_000, factorRate: 1.32, termMonths: 9, paymentAmountCents: 36_000, paymentFrequency: "daily", commissionCents: 440_000 } })
  assert.deepEqual(revised.selectedRevisionIds, [offer.currentRevisionId])
  assert.equal(revised.revisions[0].state, "superseded")
  assert.equal((await getOfferRevisionForClosing(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId })).selected, true)
  assert.equal((await queryRow<{ status: string }>("SELECT status FROM deals WHERE id=$1", [ids.deal])).status, "offer")
})

test("MIC-109 selection retries are no-ops and stale deselection preserves the newer revision", async () => {
  await clearActiveSelections()
  const offer = await createOffer(admin, { dealId: ids.deal, funderName: "Selection Capital", externalId: "selection-1", terms: { amountCents: 6_000_000, factorRate: 1.3 } })
  await Promise.all([
    selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true }),
    selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true }),
  ])
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_offer_selections WHERE offer_id=$1", [offer.id])).count, 1)
  const revised = await reviseOffer(admin, offer.id, { expectedRevisionNumber: 1, terms: { amountCents: 6_100_000, factorRate: 1.29 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: revised.currentRevisionId, selected: true })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: false })
  const active = await queryRow<{ offer_revision_id: string }>("SELECT offer_revision_id FROM mca_offer_selections WHERE offer_id=$1 AND active=1", [offer.id])
  assert.equal(active.offer_revision_id, revised.currentRevisionId)
})

test("MIC-118 concurrent confirmation creates one advance and ledger set, and rollback is atomic", async () => {
  const offer = await createOffer(admin, { dealId: ids.deal, submissionId: "provider-job", funderId: "provider-funder", funderName: "Provider Funding", source: "api", externalId: "funding-1", terms: { product: "split-fund", amountCents: 7_000_000, factorRate: 1.25, paymentAmountCents: 350_000, paymentFrequency: "weekly", commissionCents: 560_000, feeCents: 20_000 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true })
  const input = { dealId: ids.deal, offerId: offer.id, offerRevisionId: offer.currentRevisionId, idempotencyKey: "fund-double-click", fundedAt: "2025-05-03", feeCents: 20_000, expectedCommissionAt: "2025-05-10", expectedFeeAt: "2025-05-08", paymentCount: 20, paymentFrequency: "weekly" as const, calendarConvention: "calendar_days" as const, splits: [{ recipientMembershipId: ids.member, percentageBasisPoints: 10000 }] }
  const results = await Promise.all([confirmOfferFunding(admin, input), confirmOfferFunding(admin, input)])
  assert.equal(new Set(results.map((item) => item.advanceId)).size, 1)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_advances WHERE offer_revision_id=$1", [offer.currentRevisionId])).count, 1)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_accounting_payments WHERE advance_id=$1", [results[0].advanceId])).count, 2)
  assert.deepEqual(Object.fromEntries((await queryRows<{ type: string; expected_at: string }>("SELECT type,expected_at FROM mca_accounting_payments WHERE advance_id=$1", [results[0].advanceId])).map((row) => [row.type, row.expected_at])), { commission: "2025-05-10", fee: "2025-05-08" })
  assert.equal((await getDeal(admin, ids.deal)).offers.find((item) => item.id === offer.id)?.status, "accepted")
  assert.deepEqual(await queryRow<{ job_state: string; submission_status: string; offer_status: string }>(`SELECT j.state job_state,s.status submission_status,o.status offer_status
    FROM mca_submission_jobs j JOIN deal_submissions s ON s.job_id=j.id JOIN deal_offers o ON o.submission_id=s.id WHERE j.id='provider-job'`), { job_state: "sent", submission_status: "approved", offer_status: "accepted" })
  assert.deepEqual(await queryRow<{ state: string; correlation_id: string; external_ref: string }>("SELECT state,correlation_id,external_ref FROM mca_submission_attempts WHERE id='provider-attempt-row'"), { state: "sent", correlation_id: "provider-transport-correlation", external_ref: "provider-external-ref" })
  const paymentCountBeforeStatus = (await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_accounting_payments")).count
  await fixture.query("UPDATE deals SET status='contract' WHERE id=$1", [ids.secondDeal])
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_accounting_payments")).count, paymentCountBeforeStatus)

  const paidOffer = await createOffer(admin, { dealId: ids.deal, funderName: "Paid History Capital", externalId: "funding-paid", terms: { product: "split-fund", amountCents: 1_500_000, factorRate: 1.2, commissionCents: 120_000 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: paidOffer.id, revisionId: paidOffer.currentRevisionId, selected: true })
  const paidFunding = await confirmOfferFunding(admin, { dealId: ids.deal, offerId: paidOffer.id, offerRevisionId: paidOffer.currentRevisionId, idempotencyKey: "fund-paid-history", fundedAt: "2025-05-03", splits: [{ recipientMembershipId: ids.member, percentageBasisPoints: 10000 }] })
  const paidPayment = await queryRow<{ id: string }>("SELECT id FROM mca_accounting_payments WHERE funding_event_id=$1 AND type='commission'", [paidFunding.fundingEventId])
  await fixture.query("UPDATE mca_accounting_payments SET status='received',received_amount_cents=120000,received_at='2025-05-04' WHERE id=$1", [paidPayment.id])
  await fixture.query("UPDATE mca_payment_distributions SET status='paid',paid_at='2025-05-04' WHERE payment_id=$1", [paidPayment.id])

  await reverseFundingEvent(admin, { fundingEventId: results[0].fundingEventId, reason: "Funder corrected the remittance schedule", reversedAt: "2025-05-04" })
  assert.equal((await queryRow<{ status: string }>("SELECT status FROM deals WHERE id=$1", [ids.deal])).status, "funded")
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_advance_status_history WHERE advance_id=$1 AND status='closed'", [results[0].advanceId])).count, 1)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM deal_activity WHERE deal_id=$1 AND summary LIKE 'Funding event reversed:%'", [ids.deal])).count, 1)
  assert.deepEqual(await queryRow<{ job_state: string; submission_status: string; offer_status: string }>(`SELECT j.state job_state,s.status submission_status,o.status offer_status
    FROM mca_submission_jobs j JOIN deal_submissions s ON s.job_id=j.id JOIN deal_offers o ON o.submission_id=s.id WHERE j.id='provider-job'`), { job_state: "sent", submission_status: "approved", offer_status: "presented" })
  assert.deepEqual(await queryRow<{ state: string; correlation_id: string; external_ref: string }>("SELECT state,correlation_id,external_ref FROM mca_submission_attempts WHERE id='provider-attempt-row'"), { state: "sent", correlation_id: "provider-transport-correlation", external_ref: "provider-external-ref" })
  await assert.rejects(() => reverseFundingEvent(admin, { fundingEventId: paidFunding.fundingEventId, reason: "Would erase a receipt", reversedAt: "2025-05-05" }), /accounting adjustment/)
  assert.deepEqual(await queryRow<{ status: string; received_amount_cents: number; received_at: string }>("SELECT status,received_amount_cents,received_at FROM mca_accounting_payments WHERE id=$1", [paidPayment.id]), { status: "received", received_amount_cents: 120000, received_at: "2025-05-04" })
  assert.deepEqual(await queryRow<{ status: string; paid_at: string }>("SELECT status,paid_at FROM mca_payment_distributions WHERE payment_id=$1", [paidPayment.id]), { status: "paid", paid_at: "2025-05-04" })

  const correctionOffer = await reviseOffer(admin, offer.id, { expectedRevisionNumber: 1, terms: { product: "split-fund", amountCents: 7_000_000, factorRate: 1.25, paymentAmountCents: 340_000, paymentFrequency: "weekly", commissionCents: 560_000, feeCents: 20_000 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: correctionOffer.currentRevisionId, selected: true })
  await confirmOfferFunding(admin, { ...input, offerRevisionId: correctionOffer.currentRevisionId, idempotencyKey: "fund-correction", correctionOfEventId: results[0].fundingEventId })
  assert.equal((await queryRow<{ state: string }>("SELECT state FROM mca_funding_events WHERE id=$1", [results[0].fundingEventId])).state, "corrected")
  assert.equal((await queryRow<{ status: string }>("SELECT o.status FROM deal_offers o JOIN deal_submissions s ON s.id=o.submission_id WHERE s.job_id='provider-job'")).status, "accepted")
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM audit_events WHERE resource_id=$1 AND action='funding.reversed'", [results[0].fundingEventId])).count, 1)
  const failed = await createOffer(admin, { dealId: ids.deal, funderName: "Rollback Capital", externalId: "rollback-1", terms: { product: "split-fund", amountCents: 3_000_000, factorRate: 1.2 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: failed.id, revisionId: failed.currentRevisionId, selected: true })
  await assert.rejects(() => confirmOfferFunding(admin, { dealId: ids.deal, offerId: failed.id, offerRevisionId: failed.currentRevisionId, idempotencyKey: "rollback-funding", fundedAt: "2025-06-01" }, async () => { throw new Error("injected accounting failure") }), /injected accounting failure/)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_advances WHERE offer_revision_id=$1", [failed.currentRevisionId])).count, 0)
})

test("MIC-125 manual submissions are admin-session only and create no outbound job", async () => {
  await clearActiveSelections()
  const outboundJobsBefore = (await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_submission_jobs WHERE deal_id=$1", [ids.deal])).count
  await assert.rejects(() => createManualSubmission(apiActor, { dealId: ids.deal, funderName: "Legacy Funder", historicalAt: "2024-03-01", reason: "Migration", idempotencyKey: "manual-denied" }), /administrator session/)
  const created = await createManualSubmission(admin, { dealId: ids.deal, funderName: "Legacy Funder", historicalAt: "2024-03-01", reason: "Phone approval", idempotencyKey: "manual-local" })
  const replay = await createManualSubmission(admin, { dealId: ids.deal, funderName: "Legacy Funder", historicalAt: "2024-03-01", reason: "Phone approval", idempotencyKey: "manual-local" })
  assert.equal(replay.submission.id, created.submission.id)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_submission_jobs WHERE deal_id=$1", [ids.deal])).count, outboundJobsBefore)
  const approved = await approveManualSubmission(admin, { submissionId: created.submission.id, terms: { amountCents: 2_000_000, factorRate: 1.3, commissionCents: 100_000 } })
  const funding = await confirmOfferFunding(admin, { dealId: ids.deal, offerId: approved.offer.id, offerRevisionId: approved.offer.currentRevisionId, idempotencyKey: "manual-funding", fundedAt: "2024-03-01" })
  assert.equal(funding.source, "manual")
  assert.deepEqual(await queryRow<{ source: string; manual_submission_id: string }>("SELECT source,manual_submission_id FROM mca_funding_events WHERE id=$1", [funding.fundingEventId]), { source: "manual", manual_submission_id: created.submission.id })
  assert.equal((await queryRow<{ state: string }>("SELECT state FROM mca_manual_submissions WHERE id=$1", [created.submission.id])).state, "funded")
})

test("MIC-120 preserves historical dates, reconciles paid commission, and dedupes by source plus external ID", async () => {
  const rows = [
    { externalId: "legacy-101", legalName: "Historical Bakery", funderName: "Archive Capital", fundedAt: "2023-02-14", amountCents: 8_000_000, factorRate: 1.25, commissionCents: 640_000, paidCommissionCents: 640_000, paidCommissionAt: "2023-02-21", feeCents: 15_000, expectedCommissionAt: "2023-02-20", expectedFeeAt: "2023-02-18", splits: [{ recipientMembershipId: ids.member, percentageBasisPoints: 6000 }, { recipientMembershipId: ids.rep, percentageBasisPoints: 4000 }], paidSplits: [{ recipientMembershipId: ids.member, amountCents: 384_000, paidAt: "2023-02-21" }, { recipientMembershipId: ids.rep, amountCents: 256_000, paidAt: "2023-02-22" }] },
    { externalId: "legacy-102", legalName: "Historical Cafe", funderName: "Archive Capital", fundedAt: "2023-03-01", amountCents: 9_000_000, factorRate: 1.2, commissionCents: 450_000 },
  ]
  const preview = await previewHistoricalImport(admin, { sourceId: "legacy-crm", batchId: "batch-1", requestId: "legacy-retry", rows })
  const replayPreview = await previewHistoricalImport(admin, { sourceId: "legacy-crm", batchId: "batch-1", requestId: "legacy-retry", rows })
  assert.equal(replayPreview.runId, preview.runId)
  const partial = await commitHistoricalImport(admin, { runId: preview.runId, expectedPreviewRevision: 1 }, async (database, input) => {
    if (input.amountCents === 9_000_000) throw new Error("injected historical row failure")
    return writeFundingAccounting(database, input)
  })
  assert.deepEqual({ state: partial.state, created: partial.created, failed: partial.failed, principalCents: partial.principalCents }, { state: "failed", created: 1, failed: 1, principalCents: 8_000_000 })
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_funding_events WHERE source='historical' AND amount_cents=9000000")).count, 0)
  const result = await commitHistoricalImport(admin, { runId: preview.runId, expectedPreviewRevision: 1 })
  assert.deepEqual({ state: result.state, created: result.created, failed: result.failed, principalCents: result.principalCents }, { state: "committed", created: 2, failed: 0, principalCents: 17_000_000 })
  const goodEventId = (await queryRow<{ id: string }>("SELECT id FROM mca_funding_events WHERE source='historical' AND amount_cents=8000000")).id
  assert.equal((await queryRow<{ funded_at: string }>("SELECT funded_at FROM mca_advances WHERE funding_event_id=$1", [goodEventId])).funded_at, "2023-02-14")
  assert.deepEqual(await queryRow<{ received_amount_cents: number; received_at: string }>("SELECT received_amount_cents,received_at FROM mca_accounting_payments WHERE funding_event_id=$1 AND type='commission'", [goodEventId]), { received_amount_cents: 640000, received_at: "2023-02-21" })
  assert.deepEqual(await queryRows<{ status: string; paid_at: string }>("SELECT d.status,d.paid_at FROM mca_payment_distributions d JOIN mca_accounting_payments p ON p.id=d.payment_id WHERE p.funding_event_id=$1 ORDER BY d.amount_cents DESC", [goodEventId]), [{ status: "paid", paid_at: "2023-02-21" }, { status: "paid", paid_at: "2023-02-22" }])
  const duplicate = await previewHistoricalImport(admin, { sourceId: "legacy-crm", batchId: "batch-2", rows })
  assert.equal(duplicate.totals.duplicates, 2)
  const otherSource = await previewHistoricalImport(admin, { sourceId: "other-crm", batchId: "batch-1", rows: [rows[0]] })
  assert.equal(otherSource.totals.valid, 1)
  const otherResult = await commitHistoricalImport(admin, { runId: otherSource.runId, expectedPreviewRevision: 1 })
  const identities = await queryRows<{ advance_id: string; deal_id: string }>("SELECT advance_id,deal_id FROM mca_funding_events WHERE source='historical' AND amount_cents=8000000 ORDER BY created_at")
  assert.equal(identities.length, 2)
  assert.notEqual(identities[0].advance_id, identities[1].advance_id)
  assert.notEqual(identities[0].deal_id, identities[1].deal_id)
  assert.equal(otherResult.created, 1)
})

test("concurrent overlapping historical commits create each financial identity once", async () => {
  const rows = ["concurrent-one", "concurrent-two"].map((externalId) => ({ externalId, legalName: "Concurrent Merchant", funderName: "Concurrent Funder", fundedAt: "2025-02-01", amountCents: 250000, commissionCents: 25000 }))
  const a = await previewHistoricalImport(admin, { sourceId: "concurrent-commit", batchId: "same", rows })
  const b = await previewHistoricalImport(admin, { sourceId: "concurrent-commit", batchId: "same", rows: [...rows].reverse() })
  const results = await Promise.all([a, b].map((preview) => commitHistoricalImport(admin, { runId: preview.runId, expectedPreviewRevision: 1 })))
  assert.equal(results.reduce((n, r) => n + r.created, 0), 2)
  assert.equal(results.reduce((n, r) => n + r.duplicates, 0), 2)
  assert.equal(results.reduce((n, r) => n + r.failed, 0), 0)
  const counts = await queryRow<{ events: number; advances: number; payments: number }>(`SELECT
    count(DISTINCT f.id)::int events, count(DISTINCT a.id)::int advances, count(DISTINCT p.id)::int payments
    FROM mca_historical_import_rows h JOIN mca_funding_events f ON f.id=h.funding_event_id
    JOIN mca_advances a ON a.funding_event_id=f.id JOIN mca_accounting_payments p ON p.funding_event_id=f.id
    WHERE h.source_id='concurrent-commit' AND p.type='commission'`)
  assert.deepEqual(counts, { events: 2, advances: 2, payments: 2 })
  const again = await previewHistoricalImport(admin, { sourceId: "concurrent-commit", batchId: "same", rows: rows.map((r) => ({ ...r, amountCents: 999999 })) })
  assert.equal(again.totals.duplicates, 2)
  assert.ok(again.rows.every((r) => r.duplicateReason === "already_imported"))
})

test("a fresh upload can finish a partially failed run without replaying its successful row", async () => {
  const rows = [1, 2].map((n) => ({ externalId: `partial-${n}`, legalName: "Retry Merchant", funderName: "Retry Funder", fundedAt: "2025-02-01", amountCents: n * 100000, commissionCents: 10000 }))
  const original = await previewHistoricalImport(admin, { sourceId: "partial-reupload", batchId: "same", rows })
  const failed = await commitHistoricalImport(admin, { runId: original.runId, expectedPreviewRevision: 1 }, async (db, input) => {
    if (input.amountCents === 200000) throw new Error("injected failure")
    return writeFundingAccounting(db, input)
  })
  assert.equal(failed.created, 1); assert.equal(failed.failed, 1)
  const fresh = await previewHistoricalImport(admin, { sourceId: "partial-reupload", batchId: "same", rows })
  assert.equal(fresh.totals.valid, 1); assert.equal(fresh.totals.duplicates, 1)
  const completed = await commitHistoricalImport(admin, { runId: fresh.runId, expectedPreviewRevision: 1 })
  assert.equal(completed.created, 1); assert.equal(completed.duplicates, 1)
  const retry = await commitHistoricalImport(admin, { runId: original.runId, expectedPreviewRevision: 1 })
  assert.equal(retry.created, 1); assert.equal(retry.duplicates, 1); assert.equal(retry.failed, 0)
  assert.equal((await queryRow<{ count: number }>("SELECT count(*)::int count FROM mca_historical_import_rows WHERE source_id='partial-reupload' AND outcome='created'")).count, 2)
})

test("offerRevisionValidity treats past effectiveAt as in force and expires after expiresAt", () => {
  const now = "2026-01-15T00:00:00.000Z"
  assert.equal(offerRevisionValidity({ effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-29T00:00:00.000Z" }, now), "active")
  assert.equal(offerRevisionValidity({ effectiveAt: "2026-01-15T00:00:00.000Z", expiresAt: "2026-01-29T00:00:00.000Z" }, now), "active")
  assert.equal(offerRevisionValidity({ effectiveAt: "2026-01-20T00:00:00.000Z", expiresAt: "2026-01-29T00:00:00.000Z" }, now), "not_yet_effective")
  assert.equal(offerRevisionValidity({ effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-15T00:00:00.000Z" }, now), "expired")
  assert.equal(offerRevisionValidity({ effectiveAt: "2026-01-20T00:00:00.000Z", expiresAt: "2026-01-14T00:00:00.000Z" }, now), "expired")
})

test("isSplitFundProduct matches split-fund variants only", () => {
  for (const product of ["split-fund", "split_fund", "split fund", "Split-Fund", "SPLITFUND", " split-fund "]) {
    assert.equal(isSplitFundProduct(product), true, product)
  }
  for (const product of [undefined, null, "", "MCA", "split-funding", "fund-split", "split"]) {
    assert.equal(isSplitFundProduct(product), false, String(product))
  }
})

test("second non-split select on a deal returns offer_selection_conflict; split-fund allows multi-select", async () => {
  const first = await createOffer(admin, {
    dealId: ids.secondDeal,
    funderName: "Conflict First",
    externalId: "select-conflict-1",
    terms: { product: "MCA", amountCents: 1_000_000, factorRate: 1.2 },
  })
  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: first.id, revisionId: first.currentRevisionId, selected: true })

  const second = await createOffer(admin, {
    dealId: ids.secondDeal,
    funderName: "Conflict Second",
    externalId: "select-conflict-2",
    terms: { product: "MCA", amountCents: 1_100_000, factorRate: 1.21 },
  })
  await assert.rejects(
    () => selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: second.id, revisionId: second.currentRevisionId, selected: true }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_selection_conflict",
  )

  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: first.id, revisionId: first.currentRevisionId, selected: false })
  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: second.id, revisionId: second.currentRevisionId, selected: true })

  const splitA = await createOffer(admin, {
    dealId: ids.secondDeal,
    funderName: "Split A",
    externalId: "select-split-a",
    terms: { product: "split-fund", amountCents: 500_000, factorRate: 1.15 },
  })
  const splitB = await createOffer(admin, {
    dealId: ids.secondDeal,
    funderName: "Split B",
    externalId: "select-split-b",
    terms: { product: "split_fund", amountCents: 600_000, factorRate: 1.16 },
  })
  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: second.id, revisionId: second.currentRevisionId, selected: false })
  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: splitA.id, revisionId: splitA.currentRevisionId, selected: true })
  await selectOfferRevision(admin, { dealId: ids.secondDeal, offerId: splitB.id, revisionId: splitB.currentRevisionId, selected: true })
  const active = await queryRows<{ offer_id: string }>(
    "SELECT offer_id FROM mca_offer_selections WHERE deal_id=$1 AND active=1 ORDER BY offer_id",
    [ids.secondDeal],
  )
  assert.deepEqual(active.map((row) => row.offer_id).sort(), [splitA.id, splitB.id].sort())
})

test("createOffer defaults expiresAt to createdAt plus 14 days", async () => {
  const offer = await createOffer(admin, { dealId: ids.deal, funderName: "Expiry Default Capital", externalId: "expiry-default-1", terms: { amountCents: 1_000_000 } })
  const revision = offer.revisions[0]
  assert.equal(revision.expiresAt, new Date(Date.parse(revision.createdAt) + 14 * 24 * 60 * 60 * 1000).toISOString())
  assert.equal(offerRevisionValidity(revision, revision.createdAt), "active")
})

test("expired and not-yet-effective revisions cannot be newly selected or funded; deselect remains allowed", async () => {
  await clearActiveSelections()
  const expired = await createOffer(admin, { dealId: ids.deal, funderName: "Expired Capital", externalId: "expiry-select-1", terms: { amountCents: 2_000_000, factorRate: 1.2 } })
  await getDatabase().prepare("UPDATE mca_offer_revisions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", expired.currentRevisionId)
  await assert.rejects(
    () => selectOfferRevision(admin, { dealId: ids.deal, offerId: expired.id, revisionId: expired.currentRevisionId, selected: true }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_expired",
  )

  const future = await createOffer(admin, { dealId: ids.deal, funderName: "Future Capital", externalId: "expiry-future-1", terms: { amountCents: 2_100_000, factorRate: 1.2, effectiveAt: "2099-06-01T00:00:00.000Z" } })
  await assert.rejects(
    () => selectOfferRevision(admin, { dealId: ids.deal, offerId: future.id, revisionId: future.currentRevisionId, selected: true }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_not_yet_effective",
  )

  const selected = await createOffer(admin, { dealId: ids.deal, funderName: "Deselect Capital", externalId: "expiry-deselect-1", terms: { amountCents: 2_200_000, factorRate: 1.2 } })
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: selected.id, revisionId: selected.currentRevisionId, selected: true })
  await getDatabase().prepare("UPDATE mca_offer_revisions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", selected.currentRevisionId)
  const snapshot = await getOfferRevisionForClosing(admin, { dealId: ids.deal, offerId: selected.id, revisionId: selected.currentRevisionId })
  assert.throws(
    () => assertOfferRevisionEligibleForClosing(snapshot),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_expired",
  )
  await assert.rejects(
    () => confirmOfferFunding(admin, { dealId: ids.deal, offerId: selected.id, offerRevisionId: selected.currentRevisionId, idempotencyKey: "fund-expired-1", fundedAt: "2026-01-02" }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_expired",
  )
  const deselected = await selectOfferRevision(admin, { dealId: ids.deal, offerId: selected.id, revisionId: selected.currentRevisionId, selected: false })
  assert.deepEqual(deselected.selectedRevisionIds, [])
})

test("funded linked submission is ineligible at select and fund", async () => {
  await clearActiveSelections()
  await getDatabase().prepare(`INSERT INTO mca_submission_jobs
    (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_by_user_id,created_at,updated_at)
    VALUES ('funded-job',?,?,'provider-funder','Provider Funding','api','{}','funded','funded-confirm','funded-attempt',1,'[]','{"documentIds":[]}','[]',?,?,?)`).run(ids.workspace, ids.deal, ids.user, now, now)
  const offer = await createOffer(admin, { dealId: ids.deal, submissionId: "funded-job", funderId: "provider-funder", funderName: "Provider Funding", source: "api", externalId: "expiry-funded-job-1", terms: { amountCents: 3_000_000, factorRate: 1.2 } })
  await assert.rejects(
    () => selectOfferRevision(admin, { dealId: ids.deal, offerId: offer.id, revisionId: offer.currentRevisionId, selected: true }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_ineligible",
  )
  const live = await createOffer(admin, { dealId: ids.deal, submissionId: "funded-job", funderId: "provider-funder", funderName: "Provider Funding", source: "api", externalId: "expiry-funded-job-2", terms: { amountCents: 3_100_000, factorRate: 1.2 } })
  await getDatabase().prepare("UPDATE mca_submission_jobs SET state = 'sent' WHERE id = 'funded-job'").run()
  await selectOfferRevision(admin, { dealId: ids.deal, offerId: live.id, revisionId: live.currentRevisionId, selected: true })
  await getDatabase().prepare("UPDATE mca_submission_jobs SET state = 'funded' WHERE id = 'funded-job'").run()
  await assert.rejects(
    () => confirmOfferFunding(admin, { dealId: ids.deal, offerId: live.id, offerRevisionId: live.currentRevisionId, idempotencyKey: "fund-funded-job", fundedAt: "2026-01-02" }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "offer_revision_ineligible",
  )
})
