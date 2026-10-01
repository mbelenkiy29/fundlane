import { assertPendingProfileHidden } from "./helpers/pending-profile"
import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, withImmediateTransaction } from "../src/lib/mca/db"
import { writeFundingAccounting } from "../src/lib/mca/accounting/funding-writer"
import { adjustPayment, applySplitTemplate, listPayments, reconcilePayment, saveSplitTemplate } from "../src/lib/mca/accounting/service"
import { recordAdvanceStatus } from "../src/lib/mca/advances/service"
import { runRenewalEligibility, saveRenewalPolicy } from "../src/lib/mca/renewals/service"
import { updateRenewalAction } from "../src/lib/mca/renewals/service"
import { setDistributionStatus } from "../src/lib/mca/accounting/service"
import { GET as getPayments } from "../src/app/api/mca/accounting/payments/route"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = { workspace: "ws-accounting", user: "user-originator", member: "member-originator", userB: "user-b", memberB: "member-b",
  deal: "deal-accounting", offer: "offer-accounting", revision: "revision-accounting", event: "event-accounting", advance: "advance-accounting" }
const now = "2026-01-01T00:00:00.000Z"
const actor: DealActor = { workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.member, ids.memberB], source: "user", correlationId: "corr-accounting" }
function resultRows<T>(result: { rows: unknown }): T[] { return result.rows as T[] }

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,?,?,?,?)`).run(ids.workspace, "Accounting Test",
      JSON.stringify({ reports: true, payments: true, integrations: true }),
      JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
      JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-A',?,?),(?,?,?,'APP-B',?,?)`).run(ids.user, "a@example.test", "Alice Originator", now, now, ids.userB, "b@example.test", "Bob Closer", now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?)`).run(ids.member, ids.workspace, ids.user, now, now, ids.memberB, ids.workspace, ids.userB, now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('session-accounting',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(ids.user, ids.member, hashOpaqueToken("accounting-token"), now, now)
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,'Harbor Bakery','funded',1,'submission_ready','[]','{}',1,?,?)`).run(ids.deal, ids.workspace, "MCA-TEST", now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id)
    VALUES ('assignment-a',?,?,?,'originator',1,?,?)`).run(ids.workspace, ids.deal, ids.member, now, ids.user)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,'Northstar Capital','manual',?,?,?)`).run(ids.offer, ids.workspace, ids.deal, ids.revision, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES (?,?,?,1,'funded',4000000,1250000,10,500000,'monthly',320000,10000,?,?,?)`).run(ids.revision, ids.workspace, ids.offer, now, new Date(Date.parse(now) + 14 * 86_400_000).toISOString(), now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-accounting-2',?,?,'Second Capital','manual','revision-accounting-2',?,?)`).run(ids.workspace, ids.deal, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES ('revision-accounting-2',?,'offer-accounting-2',1,'funded',2000000,1200000,10,240000,'monthly',100000,0,?,?,?)`).run(ids.workspace, now, new Date(Date.parse(now) + 14 * 86_400_000).toISOString(), now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,expected_commission_at,expected_fee_at,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'live','{}','active',1,?,?)`).run(ids.advance, ids.workspace, ids.event, ids.deal, ids.offer, ids.revision, now, 4_000_000, 5_000_000, 500_000, 10, "monthly", "calendar_days", 320_000, 10_000, "2026-01-10T00:00:00.000Z", "2026-01-05T00:00:00.000Z", now, now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES ('advance-accounting-2',?,'event-accounting-2',?,'offer-accounting-2','revision-accounting-2',?,2000000,2400000,240000,10,'monthly','calendar_days',100000,0,'live','{}','active',1,?,?)`).run(ids.workspace, ids.deal, now, now, now)
}

before(async () => { fixture = await createPostgresTestDatabase("milestone05_accounting"); Object.assign(process.env, fixture.env()); await seed() })
after(async () => { await closeDatabaseForTests(); await fixture.close() })

test("MIC-112 funding writer is atomic-ready, idempotent, originator-aware, and uses distinct dates", async () => {
  const input = { workspaceId: ids.workspace, fundingEventId: ids.event, advanceId: ids.advance, dealId: ids.deal,
    offerId: ids.offer, offerRevisionId: ids.revision, fundedAt: now, amountCents: 4_000_000, commissionCents: 320_000,
    feeCents: 10_000, expectedCommissionAt: "2026-01-10T00:00:00.000Z", expectedFeeAt: "2026-01-05T00:00:00.000Z",
    splits: [{ recipientMembershipId: ids.member, percentageBasisPoints: 6000 }, { recipientMembershipId: ids.memberB, percentageBasisPoints: 4000 }],
    source: "live" as const, idempotencyKey: "funding-retry-1" }
  const first = await withImmediateTransaction((database) => writeFundingAccounting(database, input))
  const replay = await withImmediateTransaction((database) => writeFundingAccounting(database, input))
  assert.deepEqual(replay.recordIds, first.recordIds)
  const payments = await fixture.query(`SELECT type,expected_at,originator_membership_id FROM mca_accounting_payments ORDER BY type`)
  const paymentRows = resultRows<{ type: string; expected_at: string; originator_membership_id: string }>(payments)
  assert.equal(payments.rowCount, 2); assert.ok(paymentRows.every((row) => row.originator_membership_id === ids.member))
  assert.deepEqual(Object.fromEntries(paymentRows.map((row) => [row.type, row.expected_at])), { commission: "2026-01-10T00:00:00.000Z", fee: "2026-01-05T00:00:00.000Z" })
  const distributions = await fixture.query(`SELECT amount_cents FROM mca_payment_distributions ORDER BY amount_cents DESC`)
  assert.deepEqual(resultRows<{ amount_cents: number }>(distributions).map((row) => row.amount_cents), [192000, 128000])
})

test("MIC-103 rejects a second active allocation and preserves first snapshot", async () => {
  const payment = await fixture.query(`SELECT id FROM mca_accounting_payments WHERE type='commission'`)
  const saved = await saveSplitTemplate({ ...actor, correlationId: "corr-template" }, { name: "Equal split", allocations: [
    { recipientMembershipId: ids.member, percentageBasisPoints: 5000 }, { recipientMembershipId: ids.memberB, percentageBasisPoints: 5000 },
  ] })
  await assert.rejects(() => applySplitTemplate({ ...actor, correlationId: "corr-apply" }, { paymentId: resultRows<{ id: string }>(payment)[0].id,
    templateId: saved.templateId, version: saved.version, idempotencyKey: "different-active-allocation" }), /already has active distributions/)
  assert.equal(resultRows<{ count: number }>(await fixture.query(`SELECT count(*)::int count FROM mca_payment_distributions`))[0].count, 2)
})

test("MIC-103 supports three recipients and paid distribution retries preserve original history", async () => {
  const db = getDatabase()
  await db.prepare(`INSERT INTO mca_accounting_payments
    (id,workspace_id,advance_id,type,origin,expected_amount_cents,received_amount_cents,status,idempotency_key,created_at,updated_at)
    VALUES ('payment-three-way',?,'advance-accounting-2','commission','manual',10000,0,'expected','three-way',?,?)`).run(ids.workspace, now, now)
  const thirdUser = "user-c"; const thirdMember = "member-c"
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,'Cara Manager','APP-C',?,?)`).run(thirdUser, "c@example.test", now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'manager','active',?,?)`).run(thirdMember, ids.workspace, thirdUser, now, now)
  const template = await saveSplitTemplate({ ...actor, correlationId: "corr-three-template" }, { name: "Three way", allocations: [
    { recipientMembershipId: ids.member, percentageBasisPoints: 3333 }, { recipientMembershipId: ids.memberB, percentageBasisPoints: 3333 },
    { recipientMembershipId: thirdMember, percentageBasisPoints: 3334 },
  ] })
  await applySplitTemplate({ ...actor, correlationId: "corr-three-apply" }, { paymentId: "payment-three-way", templateId: template.templateId, version: template.version, idempotencyKey: "three-apply" })
  const rows = resultRows<{ id: string; amount_cents: number }>(await fixture.query(`SELECT id,amount_cents FROM mca_payment_distributions WHERE payment_id='payment-three-way' ORDER BY amount_cents`))
  assert.deepEqual(rows.map((row) => row.amount_cents), [3333, 3333, 3334])
  const paidAt = "2026-06-10T00:00:00.000Z"
  await setDistributionStatus({ ...actor, correlationId: "corr-paid" }, rows[0].id, "paid", paidAt)
  await setDistributionStatus({ ...actor, correlationId: "corr-paid-replay" }, rows[0].id, "paid", "2026-07-01T00:00:00.000Z")
  assert.equal(resultRows<{ paid_at: string }>(await fixture.query(`SELECT paid_at FROM mca_payment_distributions WHERE id=$1`, [rows[0].id]))[0].paid_at, paidAt)
})

test("MIC-107 default history creates no fabricated collection", async () => {
  await recordAdvanceStatus({ ...actor, correlationId: "corr-default" }, ids.advance, { status: "default", reason: "Merchant confirmed missed remittances", effectiveAt: "2026-06-02T00:00:00.000Z" })
  assert.equal(resultRows<{ count: number }>(await fixture.query(`SELECT count(*)::int count FROM mca_advance_status_history WHERE status='default'`))[0].count, 1)
  assert.equal(resultRows<{ total: number }>(await fixture.query(`SELECT sum(received_amount_cents)::int total FROM mca_accounting_payments`))[0].total, 0)
})

test("MIC-112 adjustments change effective expected totals once across retries", async () => {
  const payment = resultRows<{ id: string }>(await fixture.query(`SELECT id FROM mca_accounting_payments WHERE type='fee'`))[0]
  const input = { amountCents: -1000, reason: "Waived processing fee", idempotencyKey: "adjust-fee-once" }
  const first = await adjustPayment({ ...actor, correlationId: "corr-adjust-1" }, payment.id, input)
  const replay = await adjustPayment({ ...actor, correlationId: "corr-adjust-2" }, payment.id, input)
  assert.equal(first.created, true); assert.equal(replay.created, false)
  const ledger = await listPayments(actor, {}, true)
  assert.equal(ledger.payments.find((item) => item.id === payment.id)?.expectedAmountCents, 9000)
  assert.equal(resultRows<{ count: number }>(await fixture.query(`SELECT count(*)::int count FROM mca_accounting_adjustments WHERE payment_id=$1`, [payment.id]))[0].count, 1)
})

test("MIC-105 creates one advance-specific renewal action across scheduler retries", async () => {
  await saveRenewalPolicy({ ...actor, correlationId: "corr-policy" }, { paidInThresholdBasisPoints: 5000, minimumDaysSinceFunding: 0 })
  const first = await runRenewalEligibility({ ...actor, correlationId: "corr-renew-1" }, "2026-06-02T00:00:00.000Z")
  const replay = await runRenewalEligibility({ ...actor, correlationId: "corr-renew-2" }, "2026-06-02T00:00:00.000Z")
  assert.equal(first.created, 2); assert.equal(replay.created, 0); assert.deepEqual(new Set(first.eligible.map((item) => item.sourceAdvanceId)), new Set([ids.advance, "advance-accounting-2"]))
  assert.match(first.eligible[0].messageBody, /Harbor Bakery/); assert.match(first.eligible[0].messageBody, /Northstar Capital/); assert.match(first.eligible[0].messageBody, /\$40,000\.00/)
})

test("MIC-105 requests fresh tasks idempotently and validates repeat-deal lineage", async () => {
  const existing = await runRenewalEligibility({ ...actor, correlationId: "corr-renew-followup" }, "2026-06-02T00:00:00.000Z")
  const action = existing.eligible.find((item) => item.sourceAdvanceId === ids.advance)!
  await updateRenewalAction({ ...actor, correlationId: "corr-docs" }, action.id, { requestDocumentation: true })
  await updateRenewalAction({ ...actor, correlationId: "corr-docs-replay" }, action.id, { requestDocumentation: true })
  assert.equal(resultRows<{ count: number }>(await fixture.query(`SELECT count(*)::int count FROM mca_closing_stipulations WHERE deal_id=$1`, [ids.deal]))[0].count, 2)
  await assert.rejects(() => updateRenewalAction({ ...actor, correlationId: "corr-bad-link" }, action.id, { renewedDealId: ids.deal, state: "converted" }), /must be a new deal/)
  await getDatabase().prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES ('deal-renewed',?,'MCA-RENEWED','Harbor Bakery Renewal','lead',1,'partial','[]','{}',1,?,?)`).run(ids.workspace, now, now)
  const linked = await updateRenewalAction({ ...actor, correlationId: "corr-link" }, action.id, { renewedDealId: "deal-renewed", state: "converted" })
  assert.equal(linked.renewedDealId, "deal-renewed")
  assert.equal(resultRows<{ count: number }>(await fixture.query(`SELECT count(*)::int count FROM mca_accounting_payments WHERE advance_id=$1`, [ids.advance]))[0].count, 2)
})

test("MIC-112 direct API honors configured payment flags and withholds company totals separately", async () => {
  const request = () => new Request("http://localhost/api/mca/accounting/payments", { headers: { cookie: "mca_session=accounting-token" } })
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await getDatabase().prepare(`UPDATE workspaces SET action_visibility=? WHERE id=?`).run(hidden, ids.workspace)
  assert.equal((await getPayments(request())).status, 403)
  const visible = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const disabledFeature = JSON.stringify({ reports: true, payments: false, integrations: true })
  await getDatabase().prepare(`UPDATE workspaces SET action_visibility=?,feature_flags=? WHERE id=?`).run(visible, disabledFeature, ids.workspace)
  assert.equal((await getPayments(request())).status, 403)
  const enabledFeature = JSON.stringify({ reports: true, payments: true, integrations: true })
  const hiddenPage = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: false, workspace: true, integrations: true })
  await getDatabase().prepare(`UPDATE workspaces SET feature_flags=?,page_visibility=? WHERE id=?`).run(enabledFeature, hiddenPage, ids.workspace)
  assert.equal((await getPayments(request())).status, 403)
  const visiblePage = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const tableOnly = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: false })
  await getDatabase().prepare(`UPDATE workspaces SET page_visibility=?,action_visibility=? WHERE id=?`).run(visiblePage, tableOnly, ids.workspace)
  const allowed = await getPayments(request()); assert.equal(allowed.status, 200)
  assert.equal("totals" in await allowed.json(), false)
})

test("MIC-112 serializes accounting mutations through the advance and blocks reversed history", async () => {
  const db = getDatabase()
  const distribution = resultRows<{ id: string; status: string }>(await fixture.query(
    `SELECT id,status FROM mca_payment_distributions WHERE payment_id='payment-three-way' AND status='expected' ORDER BY id LIMIT 1`,
  ))[0]
  await db.prepare(`UPDATE mca_advances SET status='reversed',reversed_at=?,updated_at=?
    WHERE workspace_id=? AND id='advance-accounting-2'`).run(now, now, ids.workspace)

  await assert.rejects(
    () => reconcilePayment({ ...actor, correlationId: "corr-reversed-receipt" }, "payment-three-way", { receivedAmountCents: 5000, receivedAt: now }),
    /reversed advance cannot be changed/,
  )
  await assert.rejects(
    () => setDistributionStatus({ ...actor, correlationId: "corr-reversed-distribution" }, distribution.id, "paid", now),
    /reversed advance cannot be changed/,
  )
  assert.equal(resultRows<{ received_amount_cents: number }>(await fixture.query(
    `SELECT received_amount_cents FROM mca_accounting_payments WHERE id='payment-three-way'`,
  ))[0].received_amount_cents, 0)
  assert.equal(resultRows<{ status: string }>(await fixture.query(
    `SELECT status FROM mca_payment_distributions WHERE id=$1`, [distribution.id],
  ))[0].status, "expected")
})

test("pending shared recipients are masked in payment distributions", async () => {
  const { listDistributionRows } = await import("../src/lib/mca/accounting/repository")
  await assertPendingProfileHidden(ids.memberB, () => listDistributionRows(ids.workspace))
})
