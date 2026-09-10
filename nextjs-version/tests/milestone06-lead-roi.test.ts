import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET } from "../src/app/api/mca/reports/lead-roi/route"
import {
  costPerFunded,
  drilldownReconcilesLeadRoi,
  formatRoiPercent,
  getLeadRoiReport,
  LEAD_ROI_ATTRIBUTION,
  merchantKeyFor,
  parseReportFilters,
  roiDisplayFor,
  roiRatio,
  type LeadRoiReport,
  type LeadRoiRow,
} from "../src/lib/mca/reports/lead-roi"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-01T00:00:00.000Z"
const ids = {
  workspace: "ws-lead-roi",
  otherWorkspace: "ws-lead-roi-other",
  adminUser: "user-roi-admin",
  adminMember: "member-roi-admin",
  repUser: "user-roi-rep",
  rep: "member-roi-rep",
  managerUser: "user-roi-manager",
  manager: "member-roi-manager",
  otherUser: "user-roi-other",
  otherMember: "member-roi-other",
  funder: "funder-roi-1",
  sourceExcel: "source-excel",
  sourceOther: "source-other",
  sourceForeign: "source-foreign",
  batchPaid: "batch-paid",
  batchZero: "batch-zero",
  batchMissing: "batch-missing",
  batchOther: "batch-other",
  batchDecember: "batch-december",
  alpha: "deal-alpha",
  twin: "deal-twin",
  beta: "deal-beta",
  renewal: "deal-renewal",
  gamma: "deal-gamma",
  delta: "deal-delta",
  echo: "deal-echo",
  unassigned: "deal-unassigned",
  december: "deal-december",
  march: "deal-march",
  otherDeal: "deal-other-ws",
}

const adminActor: DealActor = {
  workspaceId: ids.workspace,
  userId: ids.adminUser,
  membershipId: ids.adminMember,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [ids.adminMember, ids.rep, ids.manager],
  source: "user",
  correlationId: "corr-lead-roi",
}

const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })

async function insertDeal(input: { id: string; workspace?: string; name: string; createdAt: string; status?: string; ein?: string | null }) {
  const db = getDatabase()
  const workspace = input.workspace ?? ids.workspace
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,ein_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'submission_ready','[]','{}',1,?,?)`).run(
    input.id, workspace, input.id.replace("deal-", "MCA-").toUpperCase(), input.name, input.ein ?? null, input.status ?? "lead", input.createdAt, input.createdAt,
  )
  await db.prepare(`INSERT INTO deal_activity (id,workspace_id,deal_id,action,actor_user_id,source,summary,from_status,to_status,record_version,correlation_id,created_at)
    VALUES (?,?,?,'created',?,'manual','Deal created',NULL,NULL,1,?,?)`).run(`act-${input.id}`, workspace, input.id, ids.adminUser, `corr-${input.id}`, input.createdAt)
}

async function statusAt(dealId: string, toStatus: string, at: string, fromStatus = "lead") {
  await getDatabase().prepare(`INSERT INTO deal_activity (id,workspace_id,deal_id,action,actor_user_id,source,summary,from_status,to_status,record_version,correlation_id,created_at)
    VALUES (?,?,?,'status_changed',?,'manual',?,?,?,2,?,?)`).run(
    `act-${dealId}-${toStatus}`, ids.workspace, dealId, ids.adminUser, `Moved to ${toStatus}`, fromStatus, toStatus, `corr-${dealId}-${toStatus}`, at,
  )
}

async function acquire(dealId: string, sourceId: string, batchId: string, purchasedOn: string | null, at: string) {
  await getDatabase().prepare(`INSERT INTO mca_deal_acquisition_events (id,workspace_id,deal_id,source_id,batch_id,cost_cents,purchased_on,correlation_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(`acq-${dealId}`, ids.workspace, dealId, sourceId, batchId, null, purchasedOn, `corr-acq-${dealId}`, at)
}

async function submit(dealId: string, at: string) {
  await statusAt(dealId, "submitted", at)
  await getDatabase().prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id)
    VALUES (?,?,?,'Northstar Capital','sent',?)`).run(`sub-${dealId}`, ids.workspace, dealId, ids.funder)
}

async function fundDeal(input: {
  dealId: string
  suffix: string
  fundedAt: string
  amountCents: number
  commissionCents: number
  paymentStatus: "received" | "expected"
  receivedAt?: string
  expectedAt: string
}) {
  const db = getDatabase()
  const offerId = `offer-${input.dealId}-${input.suffix}`
  const revisionId = `rev-${input.dealId}-${input.suffix}`
  const advanceId = `adv-${input.dealId}-${input.suffix}`
  const eventId = `event-${input.dealId}-${input.suffix}`
  const paymentId = `pay-${input.dealId}-${input.suffix}`
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,?, 'Northstar Capital','manual',?,?,?)`).run(offerId, ids.workspace, input.dealId, ids.funder, revisionId, input.fundedAt, input.fundedAt)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,commission_cents,effective_at,created_at)
    VALUES (?,?,?,1,'funded',?,?,?,?)`).run(revisionId, ids.workspace, offerId, input.amountCents, input.commissionCents, input.fundedAt, input.fundedAt)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,commission_cents,source,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'live','active',?,?)`).run(
    advanceId, ids.workspace, eventId, input.dealId, offerId, revisionId, input.fundedAt, input.amountCents, input.commissionCents, now, now,
  )
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,source,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'live','committed',?)`).run(
    eventId, ids.workspace, input.dealId, offerId, revisionId, advanceId, `fund-${input.dealId}-${input.suffix}`, input.fundedAt, input.amountCents, input.commissionCents, now,
  )
  await db.prepare(`INSERT INTO mca_accounting_payments
    (id,workspace_id,advance_id,funding_event_id,type,origin,expected_amount_cents,received_amount_cents,expected_at,received_at,status,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,?,'commission','automatic',?,?,?,?,?,?,?,?)`).run(
    paymentId, ids.workspace, advanceId, eventId, input.commissionCents,
    input.paymentStatus === "received" ? input.commissionCents : 0,
    input.expectedAt, input.receivedAt ?? null, input.paymentStatus, paymentId, now, now,
  )
}

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',8,?,?,?,?,?),(?,?,'America/New_York',5,?,?,?,?,?)`).run(
    ids.workspace, "Lead ROI Workspace", flags, pages, actions, now, now,
    ids.otherWorkspace, "Other ROI Workspace", flags, pages, actions, now, now,
  )
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-ROI-ADMIN',?,?),(?,?,?,'APP-ROI-REP',?,?),(?,?,?,'APP-ROI-MGR',?,?),(?,?,?,'APP-ROI-OTHER',?,?)`).run(
    ids.adminUser, "admin@leadroi.test", "ROI Admin", now, now,
    ids.repUser, "rep@leadroi.test", "ROI Rep", now, now,
    ids.managerUser, "manager@leadroi.test", "ROI Manager", now, now,
    ids.otherUser, "other@leadroi.test", "Other Admin", now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'manager','active',?,?),(?,?,?,'admin','active',?,?)`).run(
    ids.adminMember, ids.workspace, ids.adminUser, now, now,
    ids.rep, ids.workspace, ids.repUser, now, now,
    ids.manager, ids.workspace, ids.managerUser, now, now,
    ids.otherMember, ids.otherWorkspace, ids.otherUser, now, now,
  )
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-roi-admin',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-roi-rep',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-roi-manager',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(
    ids.adminUser, ids.adminMember, hashOpaqueToken("roi-admin-token"), now, now,
    ids.repUser, ids.rep, hashOpaqueToken("roi-rep-token"), now, now,
    ids.managerUser, ids.manager, hashOpaqueToken("roi-manager-token"), now, now,
  )
  await db.prepare(`INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(ids.funder, ids.workspace, "funder-roi-key", "Northstar Capital", now, now)
  await db.prepare(`INSERT INTO import_sources (id,workspace_id,name,kind,created_at) VALUES
    (?,?,?,'spreadsheet',?),(?,?,?,'spreadsheet',?),(?,?,?,'spreadsheet',?)`).run(
    ids.sourceExcel, ids.workspace, "Excel Pack", now,
    ids.sourceOther, ids.workspace, "Other Source", now,
    ids.sourceForeign, ids.otherWorkspace, "Foreign Source", now,
  )
  await db.prepare(`INSERT INTO lead_batches (id,workspace_id,source_id,name,purchased_on,cost_cents,inactive,created_at) VALUES
    (?,?,?,?,?, ?,0,?),
    (?,?,?,?,?, ?,0,?),
    (?,?,?,?,?, NULL,0,?),
    (?,?,?,?,?, ?,0,?),
    (?,?,?,?,?, ?,0,?)`).run(
    ids.batchPaid, ids.workspace, ids.sourceExcel, "January paid pack", "2026-01-02", 100_000, now,
    ids.batchZero, ids.workspace, ids.sourceExcel, "Zero-cost pack", "2026-01-03", 0, now,
    ids.batchMissing, ids.workspace, ids.sourceExcel, "Missing-cost pack", "2026-01-04", now,
    ids.batchOther, ids.workspace, ids.sourceOther, "Other January pack", "2026-01-05", 20_000, now,
    ids.batchDecember, ids.workspace, ids.sourceExcel, "December pack", "2025-12-01", 50_000, now,
  )

  await insertDeal({ id: ids.alpha, name: "Harbor Alpha LLC", createdAt: "2026-01-05T15:00:00.000Z", status: "funded", ein: "ein-alpha" })
  await acquire(ids.alpha, ids.sourceExcel, ids.batchPaid, "2026-01-02", "2026-01-05T15:00:00.000Z")
  await submit(ids.alpha, "2026-01-06T15:00:00.000Z")
  await statusAt(ids.alpha, "offer", "2026-01-08T15:00:00.000Z", "submitted")
  await statusAt(ids.alpha, "funded", "2026-01-10T15:00:00.000Z", "offer")
  await fundDeal({
    dealId: ids.alpha, suffix: "1", fundedAt: "2026-01-10T15:00:00.000Z", amountCents: 4_000_000,
    commissionCents: 200_000, paymentStatus: "received", receivedAt: "2026-01-28T00:00:00.000Z", expectedAt: "2026-01-25T00:00:00.000Z",
  })
  await fundDeal({
    dealId: ids.alpha, suffix: "2", fundedAt: "2026-01-25T15:00:00.000Z", amountCents: 1_000_000,
    commissionCents: 30_000, paymentStatus: "received", receivedAt: "2026-01-30T00:00:00.000Z", expectedAt: "2026-01-29T00:00:00.000Z",
  })

  await insertDeal({ id: ids.twin, name: "Harbor Twin LLC", createdAt: "2026-01-05T16:00:00.000Z", status: "funded", ein: "ein-alpha" })
  await acquire(ids.twin, ids.sourceExcel, ids.batchPaid, "2026-01-02", "2026-01-05T16:00:00.000Z")
  await submit(ids.twin, "2026-01-06T16:00:00.000Z")
  await statusAt(ids.twin, "offer", "2026-01-09T15:00:00.000Z", "submitted")
  await statusAt(ids.twin, "funded", "2026-01-12T15:00:00.000Z", "offer")
  await fundDeal({
    dealId: ids.twin, suffix: "1", fundedAt: "2026-01-12T15:00:00.000Z", amountCents: 2_000_000,
    commissionCents: 40_000, paymentStatus: "expected", expectedAt: "2026-01-20T00:00:00.000Z",
  })

  await insertDeal({ id: ids.beta, name: "Beta Submitted LLC", createdAt: "2026-01-05T17:00:00.000Z", ein: "ein-beta" })
  await acquire(ids.beta, ids.sourceExcel, ids.batchPaid, "2026-01-02", "2026-01-05T17:00:00.000Z")
  await submit(ids.beta, "2026-01-07T15:00:00.000Z")

  await insertDeal({ id: ids.renewal, name: "Harbor Renewal LLC", createdAt: "2026-01-18T15:00:00.000Z", status: "funded", ein: "ein-alpha" })
  await acquire(ids.renewal, ids.sourceExcel, ids.batchPaid, "2026-01-02", "2026-01-18T15:00:00.000Z")
  await submit(ids.renewal, "2026-01-18T16:00:00.000Z")
  await statusAt(ids.renewal, "funded", "2026-01-20T15:00:00.000Z", "submitted")
  await fundDeal({
    dealId: ids.renewal, suffix: "1", fundedAt: "2026-01-20T15:00:00.000Z", amountCents: 1_500_000,
    commissionCents: 50_000, paymentStatus: "received", receivedAt: "2026-01-22T00:00:00.000Z", expectedAt: "2026-01-21T00:00:00.000Z",
  })
  await db.prepare(`INSERT INTO mca_renewal_actions
    (id,workspace_id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,message_subject,message_body,idempotency_key,created_at,updated_at)
    VALUES ('ren-alpha',?,'adv-deal-alpha-1',?,1,'2026-01-18T00:00:00.000Z','converted','Renewal','Follow-on funding','ren-alpha',?,?)`).run(
    ids.workspace, ids.renewal, now, now,
  )

  await insertDeal({ id: ids.gamma, name: "Gamma Zero LLC", createdAt: "2026-01-08T15:00:00.000Z", status: "funded", ein: "ein-gamma" })
  await acquire(ids.gamma, ids.sourceExcel, ids.batchZero, "2026-01-03", "2026-01-08T15:00:00.000Z")
  await submit(ids.gamma, "2026-01-09T15:00:00.000Z")
  await statusAt(ids.gamma, "funded", "2026-01-11T15:00:00.000Z", "submitted")
  await fundDeal({
    dealId: ids.gamma, suffix: "1", fundedAt: "2026-01-11T15:00:00.000Z", amountCents: 800_000,
    commissionCents: 10_000, paymentStatus: "received", receivedAt: "2026-01-15T00:00:00.000Z", expectedAt: "2026-01-14T00:00:00.000Z",
  })

  await insertDeal({ id: ids.delta, name: "Delta Missing LLC", createdAt: "2026-01-08T16:00:00.000Z", ein: "ein-delta" })
  await acquire(ids.delta, ids.sourceExcel, ids.batchMissing, "2026-01-04", "2026-01-08T16:00:00.000Z")
  await submit(ids.delta, "2026-01-09T16:00:00.000Z")

  await insertDeal({ id: ids.echo, name: "Echo Other LLC", createdAt: "2026-01-09T15:00:00.000Z", status: "funded", ein: "ein-echo" })
  await acquire(ids.echo, ids.sourceOther, ids.batchOther, "2026-01-05", "2026-01-09T15:00:00.000Z")
  await submit(ids.echo, "2026-01-10T15:00:00.000Z")
  await statusAt(ids.echo, "funded", "2026-01-13T15:00:00.000Z", "submitted")
  await fundDeal({
    dealId: ids.echo, suffix: "1", fundedAt: "2026-01-13T15:00:00.000Z", amountCents: 900_000,
    commissionCents: 10_000, paymentStatus: "received", receivedAt: "2026-01-16T00:00:00.000Z", expectedAt: "2026-01-15T00:00:00.000Z",
  })

  await insertDeal({ id: ids.unassigned, name: "Unassigned Merchant", createdAt: "2026-01-22T15:00:00.000Z" })
  await insertDeal({ id: ids.december, name: "December Cohort Inc", createdAt: "2025-12-15T15:00:00.000Z", status: "submitted", ein: "ein-december" })
  await acquire(ids.december, ids.sourceExcel, ids.batchDecember, "2025-12-01", "2025-12-15T15:00:00.000Z")
  await submit(ids.december, "2026-01-05T15:00:00.000Z")
  await insertDeal({ id: ids.march, name: "March Deal LLC", createdAt: "2026-03-01T15:00:00.000Z", ein: "ein-march" })
  await acquire(ids.march, ids.sourceExcel, ids.batchPaid, "2026-03-01", "2026-03-01T15:00:00.000Z")
  await insertDeal({ id: ids.otherDeal, workspace: ids.otherWorkspace, name: "Other Workspace Deal", createdAt: "2026-01-10T15:00:00.000Z" })
}

function januaryFilters() {
  return parseReportFilters(new URLSearchParams("basis=cohort&from=2026-01-01&to=2026-01-31"))
}

async function januaryReport(overrides: Parameters<typeof getLeadRoiReport>[1] | null = null, nowIso = "2026-02-01T17:00:00.000Z") {
  return getLeadRoiReport(adminActor, overrides ?? januaryFilters(), nowIso)
}

function batchRow(report: LeadRoiReport, batchId: string): LeadRoiRow {
  const found = report.batches.find((item) => item.batchId === batchId)
  assert.ok(found, `missing batch ${batchId}`)
  return found
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_lead_roi")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("MIC-116 math helpers refuse infinity and invented zeros", () => {
  assert.equal(costPerFunded(100_000, 0), null)
  assert.equal(costPerFunded(null, 2), null)
  assert.equal(costPerFunded(0, 2), 0)
  assert.equal(costPerFunded(100_000, 2), 50_000)
  assert.equal(roiRatio(230_000, 100_000)?.toFixed(1), "1.3")
  assert.equal(roiRatio(10_000, 0), null)
  assert.equal(roiRatio(10_000, null), null)
  assert.equal(roiDisplayFor(0), "undefined")
  assert.equal(roiDisplayFor(null), "undefined")
  assert.equal(formatRoiPercent(null, 0), "Undefined")
  assert.notEqual(formatRoiPercent(null, 0), "Infinity")
  assert.equal(merchantKeyFor({ id: "deal-1", einCipher: "ein-alpha" }), "ein:ein-alpha")
  assert.equal(merchantKeyFor({ id: "deal-1", einCipher: null }), "deal:deal-1")
  assert.equal(LEAD_ROI_ATTRIBUTION.zeroCostRoi, "undefined")
  assert.equal(LEAD_ROI_ATTRIBUTION.renewals, "excluded_from_acquisition_counts")
  assert.throws(() => parseReportFilters(new URLSearchParams("from=2026-01-01")), /basis/)
  assert.throws(() => parseReportFilters(new URLSearchParams("basis=cohort&from=2026-02-01&to=2026-01-01")), /from must be on or before to/)
})

test("MIC-116 synthetic cohort has conversion counts, separate CAC, and collected ROI", async () => {
  const report = await januaryReport()
  const paid = batchRow(report, ids.batchPaid)
  assert.equal(paid.acquiredCount, 3)
  assert.equal(paid.submittedCount, 3)
  assert.equal(paid.approvedCount, 2)
  assert.equal(paid.fundedDealCount, 2)
  assert.equal(paid.fundedMerchantCount, 1)
  assert.equal(paid.economics.purchaseCostCents, 100_000)
  assert.equal(paid.economics.costPerFundedDealCents, 50_000)
  assert.equal(paid.economics.costPerFundedMerchantCents, 100_000)
  assert.equal(paid.economics.collectedCommissionCents, 230_000)
  assert.equal(paid.economics.expectedCommissionCents, 270_000)
  assert.equal(paid.economics.followOnCollectedCents, 50_000)
  assert.equal(paid.economics.collectedRoi?.toFixed(1), "1.3")
  assert.equal(paid.economics.expectedRoi?.toFixed(1), "1.7")
  assert.equal(paid.economics.followOnCollectedRoi?.toFixed(1), "1.8")
  assert.equal(paid.economics.expectedRoiLabel, "expected_value")
  assert.equal(paid.economics.followOnRoiLabel, "including_follow_on")
  assert.notEqual(paid.economics.collectedRoi, paid.economics.expectedRoi)
  assert.equal(drilldownReconcilesLeadRoi(report), true)
  assert.equal(report.drilldown.acquired.some((item) => item.dealId === ids.otherDeal), false)
  assert.equal(report.drilldown.acquired.some((item) => item.dealId === ids.march), false)
})

test("MIC-116 a zero-cost batch displays undefined ROI rather than infinity", async () => {
  const report = await januaryReport(parseReportFilters(new URLSearchParams(`basis=cohort&from=2026-01-01&to=2026-01-31&batchIds=${ids.batchZero}`)))
  const zero = batchRow(report, ids.batchZero)
  assert.equal(zero.economics.purchaseCostCents, 0)
  assert.equal(zero.zeroCost, true)
  assert.equal(zero.fundedDealCount, 1)
  assert.equal(zero.economics.costPerFundedDealCents, 0)
  assert.equal(zero.economics.collectedRoi, null)
  assert.equal(zero.economics.collectedRoiDisplay, "undefined")
  assert.equal(formatRoiPercent(zero.economics.collectedRoi, zero.economics.purchaseCostCents), "Undefined")
  assert.equal(Number.isFinite(zero.economics.collectedRoi ?? NaN), false)
  assert.notEqual(zero.economics.collectedRoi, Infinity)
  assert.notEqual(zero.economics.collectedRoi, 0)
  assert.ok(report.warnings.some((item) => item.code === "zero_cost"))
})

test("MIC-116 renewals and repeat fundings do not inflate acquisition counts", async () => {
  const report = await januaryReport(parseReportFilters(new URLSearchParams(`basis=cohort&from=2026-01-01&to=2026-01-31&batchIds=${ids.batchPaid}`)))
  const paid = batchRow(report, ids.batchPaid)
  assert.equal(paid.acquiredCount, 3)
  assert.equal(paid.fundedDealCount, 2)
  assert.equal(paid.fundedMerchantCount, 1)
  assert.equal(report.drilldown.acquired.some((item) => item.dealId === ids.renewal), false)
  assert.equal(report.drilldown.funded.some((item) => item.dealId === ids.renewal), false)
  assert.equal(report.drilldown.followOn.some((item) => item.dealId === ids.renewal), true)
  const alpha = report.drilldown.funded.find((item) => item.dealId === ids.alpha)
  assert.ok(alpha)
  assert.equal(alpha.committedFundingCount, 2)
  assert.equal(alpha.collectedCommissionCents, 230_000)
  assert.equal(paid.economics.collectedCommissionCents, 230_000)
  assert.equal(paid.economics.followOnCollectedCents, 50_000)
  assert.notEqual(paid.economics.collectedRoi, paid.economics.followOnCollectedRoi)
  assert.ok(report.warnings.some((item) => item.code === "renewals_excluded"))
  assert.equal(LEAD_ROI_ATTRIBUTION.repeatFundings, "do_not_increment_funded_deal_count")
})

test("MIC-116 missing cost is a warning and CAC/ROI stay N/A or undefined, not $0", async () => {
  const report = await januaryReport(parseReportFilters(new URLSearchParams(`basis=cohort&from=2026-01-01&to=2026-01-31&batchIds=${ids.batchMissing}`)))
  const missing = batchRow(report, ids.batchMissing)
  assert.equal(missing.missingCost, true)
  assert.equal(missing.economics.purchaseCostCents, null)
  assert.equal(missing.economics.costComplete, false)
  assert.equal(missing.economics.costPerFundedDealCents, null)
  assert.equal(missing.economics.collectedRoi, null)
  assert.equal(missing.economics.collectedRoiDisplay, "undefined")
  assert.ok(report.warnings.some((item) => item.code === "missing_cost"))
  const all = await januaryReport()
  assert.equal(all.totals.economics.costComplete, false)
  assert.equal(all.totals.economics.purchaseCostCents, null)
  assert.ok(all.warnings.some((item) => item.code === "unassigned_deals"))
  assert.equal(all.unassigned?.acquiredCount, 1)
})

test("MIC-116 source, batch, and date filters plus event versus cohort", async () => {
  const source = await januaryReport(parseReportFilters(new URLSearchParams(`basis=cohort&from=2026-01-01&to=2026-01-31&sourceIds=${ids.sourceOther}`)))
  assert.equal(source.batches.length, 1)
  assert.equal(source.batches[0]?.batchId, ids.batchOther)
  assert.equal(source.totals.fundedDealCount, 1)
  assert.equal(source.totals.economics.collectedRoi, -0.5)
  const batch = await januaryReport(parseReportFilters(new URLSearchParams(`basis=cohort&from=2026-01-01&to=2026-01-31&batchIds=${ids.batchPaid}`)))
  assert.deepEqual(batch.drilldown.acquired.map((item) => item.dealId).sort(), [ids.alpha, ids.beta, ids.twin].sort())
  const eventJanuary = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-01&to=2026-01-31")))
  assert.equal(eventJanuary.drilldown.submitted.some((item) => item.dealId === ids.december), true)
  assert.equal(eventJanuary.drilldown.acquired.some((item) => item.dealId === ids.december), false)
  const cohortDecember = await januaryReport(parseReportFilters(new URLSearchParams("basis=cohort&from=2025-12-01&to=2025-12-31")))
  assert.equal(cohortDecember.totals.acquiredCount, 1)
  assert.equal(cohortDecember.totals.submittedCount, 1)
  assert.equal(cohortDecember.drilldown.acquired[0]?.dealId, ids.december)
})

test("MIC-116 drilldown reconciles to totals and zero denominators are N/A", async () => {
  const report = await januaryReport()
  assert.equal(drilldownReconcilesLeadRoi(report), true)
  const missing = batchRow(report, ids.batchMissing)
  const fundedRate = missing.conversions.find((item) => item.from === "approved" && item.to === "funded")
  assert.equal(fundedRate?.denominator, 0)
  assert.equal(fundedRate?.rate, null)
  const excel = report.sources.find((item) => item.sourceId === ids.sourceExcel)
  assert.ok(excel)
  assert.ok(excel.acquiredCount >= 3)
})

test("MIC-116 missing payment permission is restricted, not $0", async () => {
  const db = getDatabase()
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(hidden, ids.workspace)
  const report = await januaryReport()
  assert.equal(report.permission.paymentsVisible, false)
  assert.equal(report.permission.reason, "payment_permission_required")
  const paid = batchRow(report, ids.batchPaid)
  assert.equal(paid.economics.paymentsVisible, false)
  assert.equal(paid.economics.collectedCommissionCents, undefined)
  assert.equal(paid.economics.collectedRoi, null)
  assert.notEqual(paid.economics.collectedCommissionCents, 0)
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(actions, ids.workspace)
})

test("MIC-116 API permissions match the admin reports UI", async () => {
  const logs: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args) }
  try {
    const url = "http://localhost/api/mca/reports/lead-roi?basis=cohort&from=2026-01-01&to=2026-01-31"
    assert.equal((await GET(new Request(url))).status, 401)
    const rep = await GET(new Request(url, { headers: { cookie: "mca_session=roi-rep-token" } }))
    assert.equal(rep.status, 403)
    const manager = await GET(new Request(url, { headers: { cookie: "mca_session=roi-manager-token" } }))
    assert.equal(manager.status, 403)
    const admin = await GET(new Request(url, { headers: { cookie: "mca_session=roi-admin-token" } }))
    assert.equal(admin.status, 200)
    const payload = await admin.json() as LeadRoiReport
    assert.equal(batchRow(payload, ids.batchPaid).fundedDealCount, 2)
    assert.equal(drilldownReconcilesLeadRoi(payload), true)
    const invalid = await GET(new Request("http://localhost/api/mca/reports/lead-roi?basis=cohort&from=2026-02-01&to=2026-01-01", { headers: { cookie: "mca_session=roi-admin-token" } }))
    assert.equal(invalid.status, 422)
    const foreign = await GET(new Request(`${url}&sourceIds=${ids.sourceForeign}`, { headers: { cookie: "mca_session=roi-admin-token" } }))
    assert.equal(foreign.status, 422)
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(JSON.stringify({ reports: false, payments: true, integrations: true }), ids.workspace)
    const disabled = await GET(new Request(url, { headers: { cookie: "mca_session=roi-admin-token" } }))
    assert.equal(disabled.status, 403)
    assert.equal((await disabled.json() as { error: { code: string } }).error.code, "reports_disabled")
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(flags, ids.workspace)
    assert.equal(JSON.stringify(logs).includes("roi-admin-token"), false)
  } finally {
    console.log = original
  }
})

test("MIC-116 UI states cover loading empty validation success and failure", () => {
  const source = readFileSync(new URL("../src/components/mca/reports/lead-roi.tsx", import.meta.url), "utf8")
  assert.match(source, /Loading lead source CAC and ROI/)
  assert.match(source, /No lead sources or batches match these filters/)
  assert.match(source, /role="status"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /not shown as \$0/)
  assert.match(source, /Choose an event or cohort basis/)
  assert.match(source, /From date must be on or before the to date/)
  assert.match(source, /The report could not be loaded/)
  assert.match(source, /\{LEAD_ROI_COPY\.retry\}/)
  assert.match(source, /Undefined/)
  assert.match(source, /Restricted/)
  assert.match(source, /Missing cost/)
})
