import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET } from "../src/app/api/mca/reports/team-profit/route"
import { getRepFunnelReport, parseReportFilters } from "../src/lib/mca/reports/rep-funnel"
import {
  SHARED_REP_ATTRIBUTION,
  buildGrossContribution,
  companyDealCountsMatchFunnel,
  expectedGrossContributionCents,
  getTeamProfitReport,
  grossContributionCents,
  parseTeamProfitFilters,
  summedUserDealCount,
  type TeamProfitReport,
} from "../src/lib/mca/reports/team-profit"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-01T00:00:00.000Z"
const asOf = "2026-02-01T17:00:00.000Z"
const ids = {
  workspace: "ws-profit",
  otherWorkspace: "ws-profit-other",
  adminUser: "user-profit-admin",
  adminMember: "member-profit-admin",
  adaUser: "user-profit-ada",
  ada: "member-profit-ada",
  beauUser: "user-profit-beau",
  beau: "member-profit-beau",
  caraUser: "user-profit-cara",
  cara: "member-profit-cara",
  managerUser: "user-profit-manager",
  manager: "member-profit-manager",
  repUser: "user-profit-rep",
  rep: "member-profit-rep",
  otherUser: "user-profit-other",
  otherMember: "member-profit-other",
  harbor: "deal-profit-harbor",
  beacon: "deal-profit-beacon",
  december: "deal-profit-december",
  unassigned: "deal-profit-unassigned",
  reversed: "deal-profit-reversed",
  march: "deal-profit-march",
  otherDeal: "deal-profit-other",
  source: "source-profit",
  batch: "batch-profit",
}

const adminActor: DealActor = {
  workspaceId: ids.workspace,
  userId: ids.adminUser,
  membershipId: ids.adminMember,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [ids.adminMember, ids.ada, ids.beau, ids.cara, ids.rep, ids.manager],
  source: "user",
  correlationId: "corr-profit",
}

const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })

async function insertDeal(input: { id: string; workspace?: string; name: string; requested?: number; createdAt: string; status?: string }) {
  const db = getDatabase()
  const workspace = input.workspace ?? ids.workspace
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,requested_amount,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'submission_ready','[]','{}',1,?,?)`).run(
    input.id, workspace, input.id.replace("deal-profit-", "MCA-").toUpperCase(), input.name, input.requested ?? null, input.status ?? "lead", input.createdAt, input.createdAt,
  )
  await db.prepare(`INSERT INTO deal_activity (id,workspace_id,deal_id,action,actor_user_id,source,summary,from_status,to_status,record_version,correlation_id,created_at)
    VALUES (?,?,?,'created',?,'manual','Deal created',NULL,NULL,1,?,?)`).run(`act-${input.id}`, workspace, input.id, ids.adminUser, `corr-${input.id}`, input.createdAt)
}

async function assign(dealId: string, membershipId: string, kind: "originator" | "closer") {
  await getDatabase().prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at)
    VALUES (?,?,?,?,?,1,?)`).run(`asg-${dealId}-${membershipId}-${kind}`, ids.workspace, dealId, membershipId, kind, now)
}

async function statusAt(dealId: string, toStatus: string, at: string, fromStatus = "lead") {
  await getDatabase().prepare(`INSERT INTO deal_activity (id,workspace_id,deal_id,action,actor_user_id,source,summary,from_status,to_status,record_version,correlation_id,created_at)
    VALUES (?,?,?,'status_changed',?,'manual',?,?,?,2,?,?)`).run(
    `act-${dealId}-${toStatus}`, ids.workspace, dealId, ids.adminUser, `Moved to ${toStatus}`, fromStatus, toStatus, `corr-${dealId}-${toStatus}`, at,
  )
}

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',8,?,?,?,?,?),(?,?,'America/New_York',5,?,?,?,?,?)`).run(
    ids.workspace, "Profit Workspace", flags, pages, actions, now, now,
    ids.otherWorkspace, "Other Profit Workspace", flags, pages, actions, now, now,
  )
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-PROFIT-ADMIN',?,?),(?,?,?,'APP-PROFIT-ADA',?,?),(?,?,?,'APP-PROFIT-BEAU',?,?),
    (?,?,?,'APP-PROFIT-CARA',?,?),(?,?,?,'APP-PROFIT-MGR',?,?),(?,?,?,'APP-PROFIT-REP',?,?),(?,?,?,'APP-PROFIT-OTHER',?,?)`).run(
    ids.adminUser, "admin@profit.test", "Profit Admin", now, now,
    ids.adaUser, "ada@profit.test", "Ada Originator", now, now,
    ids.beauUser, "beau@profit.test", "Beau Closer", now, now,
    ids.caraUser, "cara@profit.test", "Cara Rep", now, now,
    ids.managerUser, "manager@profit.test", "Morgan Manager", now, now,
    ids.repUser, "rep@profit.test", "Riley Rep", now, now,
    ids.otherUser, "other@profit.test", "Other Admin", now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'manager','active',?,?)`).run(
    ids.adminMember, ids.workspace, ids.adminUser, now, now,
    ids.manager, ids.workspace, ids.managerUser, now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,created_at,updated_at) VALUES
    (?,?,?,'rep',?,'active',?,?),(?,?,?,'rep',?,'active',?,?),(?,?,?,'rep',?,'active',?,?),
    (?,?,?,'rep',NULL,'active',?,?),(?,?,?,'admin',NULL,'active',?,?)`).run(
    ids.ada, ids.workspace, ids.adaUser, ids.manager, now, now,
    ids.beau, ids.workspace, ids.beauUser, ids.manager, now, now,
    ids.cara, ids.workspace, ids.caraUser, ids.manager, now, now,
    ids.rep, ids.workspace, ids.repUser, now, now,
    ids.otherMember, ids.otherWorkspace, ids.otherUser, now, now,
  )
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-profit-admin',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-profit-rep',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-profit-manager',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(
    ids.adminUser, ids.adminMember, hashOpaqueToken("profit-admin-token"), now, now,
    ids.repUser, ids.rep, hashOpaqueToken("profit-rep-token"), now, now,
    ids.managerUser, ids.manager, hashOpaqueToken("profit-manager-token"), now, now,
  )

  await db.prepare(`INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at)
    VALUES (?,?,?,?,?,?),(?,?,?,?,?,?)`).run(
    "funder-profit-1", ids.workspace, "funder-profit-1", "Funder One", now, now,
    "funder-profit-2", ids.workspace, "funder-profit-2", "Funder Two", now, now,
  )
  await db.prepare(`INSERT INTO import_sources (id,workspace_id,name,kind,created_at) VALUES (?,?,?,'spreadsheet',?)`).run(ids.source, ids.workspace, "Profit source", now)
  await db.prepare(`INSERT INTO lead_batches (id,workspace_id,source_id,name,purchased_on,cost_cents,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(ids.batch, ids.workspace, ids.source, "Profit batch", "2026-01-05", 50_000, now)

  await insertDeal({ id: ids.harbor, name: "Harbor Bakery", requested: 50_000, createdAt: "2026-01-10T15:00:00.000Z", status: "funded" })
  await assign(ids.harbor, ids.ada, "originator")
  await assign(ids.harbor, ids.beau, "closer")
  await statusAt(ids.harbor, "submitted", "2026-01-12T15:00:00.000Z")
  await statusAt(ids.harbor, "offer", "2026-01-16T15:00:00.000Z", "submitted")
  await statusAt(ids.harbor, "funded", "2026-01-20T15:00:00.000Z", "offer")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id)
    VALUES ('sub-profit-harbor',?,?,'Funder One','sent','funder-profit-1')`).run(ids.workspace, ids.harbor)
  await db.prepare(`INSERT INTO mca_deal_acquisition_events (id,workspace_id,deal_id,source_id,batch_id,correlation_id,created_at)
    VALUES ('acq-profit-harbor',?,?,?,?,?,?)`).run(ids.workspace, ids.harbor, ids.source, ids.batch, "corr-acq-profit-harbor", now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-profit-harbor',?,?, 'funder-profit-1','Funder One','manual','rev-profit-harbor',?,?)`).run(ids.workspace, ids.harbor, "2026-01-16T15:00:00.000Z", "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,created_at)
    VALUES ('rev-profit-harbor',?,'offer-profit-harbor',1,'funded',4000000,?,?)`).run(ids.workspace, "2026-01-16T15:00:00.000Z", "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_selections (id,workspace_id,deal_id,offer_id,offer_revision_id,active,selected_at)
    VALUES ('sel-profit-harbor',?,?,'offer-profit-harbor','rev-profit-harbor',1,?)`).run(ids.workspace, ids.harbor, "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,commission_cents,fee_cents,source,status,created_at,updated_at)
    VALUES ('adv-profit-harbor',?,'event-profit-harbor',?,'offer-profit-harbor','rev-profit-harbor','2026-01-20T15:00:00.000Z',4000000,5000000,320000,20000,'live','active',?,?)`).run(ids.workspace, ids.harbor, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,fee_cents,source,state,created_at)
    VALUES ('event-profit-harbor',?,?,'offer-profit-harbor','rev-profit-harbor','adv-profit-harbor','fund-profit-harbor','2026-01-20T15:00:00.000Z',4000000,320000,20000,'live','committed',?)`).run(ids.workspace, ids.harbor, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,funding_event_id,type,origin,originator_membership_id,expected_amount_cents,received_amount_cents,expected_at,received_at,status,idempotency_key,created_at,updated_at)
    VALUES ('pay-harbor-commission',?,'adv-profit-harbor','event-profit-harbor','commission','automatic',?,320000,320000,'2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','received','pay-harbor-commission',?,?),
           ('pay-harbor-fee',?,'adv-profit-harbor','event-profit-harbor','fee','automatic',?,20000,20000,'2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','received','pay-harbor-fee',?,?),
           ('pay-harbor-expected',?,'adv-profit-harbor','event-profit-harbor','fee','manual',?,10000,0,'2026-01-29T00:00:00.000Z',NULL,'expected','pay-harbor-expected',?,?),
           ('pay-harbor-voided',?,'adv-profit-harbor','event-profit-harbor','fee','manual',?,5000,5000,'2026-01-11T00:00:00.000Z','2026-01-11T00:00:00.000Z','void','pay-harbor-voided',?,?)`).run(
    ids.workspace, ids.ada, now, now,
    ids.workspace, ids.ada, now, now,
    ids.workspace, ids.ada, now, now,
    ids.workspace, ids.ada, "2026-01-12T00:00:00.000Z", "2026-01-12T00:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_accounting_adjustments (id,workspace_id,payment_id,amount_cents,reason,actor_user_id,correlation_id,created_at)
    VALUES ('adj-harbor-expected',?,'pay-harbor-expected',-1000,'Correction after review',?,'corr-adj-harbor-expected','2026-01-29T18:00:00.000Z')`).run(ids.workspace, ids.adminUser)
  await db.prepare(`INSERT INTO mca_payment_distributions (id,workspace_id,payment_id,recipient_membership_id,percentage_basis_points,amount_cents,status,expected_at,paid_at,snapshot_json,idempotency_key,created_at,updated_at)
    VALUES ('dist-profit-ada',?,'pay-harbor-commission',?,6000,192000,'paid','2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','{}','dist-profit-ada',?,?),
           ('dist-profit-beau',?,'pay-harbor-commission',?,4000,128000,'paid','2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','{}','dist-profit-beau',?,?),
           ('dist-profit-void',?,'pay-harbor-commission',?,1000,0,'void',NULL,NULL,'{}','dist-profit-void',?,?)`).run(
    ids.workspace, ids.ada, now, now,
    ids.workspace, ids.beau, now, now,
    ids.workspace, ids.cara, now, now,
  )
  await db.prepare(`INSERT INTO audit_events (id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES ('aud-voided',?,?,'user','accounting.payment.voided','accounting_payment','pay-harbor-voided',?,'corr-void-harbor','2026-01-12T00:00:00.000Z'),
           ('aud-adjusted',?,?,'user','accounting.payment.adjusted','accounting_payment','pay-harbor-expected',?,'corr-adj-harbor-expected','2026-01-29T18:00:00.000Z')`).run(
    ids.workspace, ids.adminUser, JSON.stringify({ reason: "Duplicate fee reversed" }),
    ids.workspace, ids.adminUser, JSON.stringify({ adjustmentId: "adj-harbor-expected" }),
  )

  await insertDeal({ id: ids.beacon, name: "Beacon Bistro", requested: 10_000, createdAt: "2026-01-20T15:00:00.000Z" })
  await assign(ids.beacon, ids.ada, "originator")

  await insertDeal({ id: ids.december, name: "December Cohort Inc", requested: 12_000, createdAt: "2025-12-15T15:00:00.000Z", status: "submitted" })
  await assign(ids.december, ids.cara, "originator")
  await statusAt(ids.december, "submitted", "2026-01-05T15:00:00.000Z")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id)
    VALUES ('sub-profit-december',?,?,'Funder Two','sent','funder-profit-2')`).run(ids.workspace, ids.december)

  await insertDeal({ id: ids.unassigned, name: "Unassigned Merchant", requested: 3_000, createdAt: "2026-01-22T15:00:00.000Z" })

  await insertDeal({ id: ids.reversed, name: "Reversed Funding", requested: 9_000, createdAt: "2026-01-25T15:00:00.000Z", status: "offer" })
  await assign(ids.reversed, ids.ada, "originator")
  await statusAt(ids.reversed, "submitted", "2026-01-26T15:00:00.000Z")
  await statusAt(ids.reversed, "funded", "2026-01-27T15:00:00.000Z", "submitted")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id)
    VALUES ('sub-profit-reversed',?,?,'Funder One','sent','funder-profit-1')`).run(ids.workspace, ids.reversed)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-profit-reversed',?,?, 'funder-profit-1','Funder One','manual','rev-profit-reversed',?,?)`).run(ids.workspace, ids.reversed, "2026-01-27T15:00:00.000Z", "2026-01-27T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,created_at)
    VALUES ('rev-profit-reversed',?,'offer-profit-reversed',1,'active',900000,?,?)`).run(ids.workspace, "2026-01-27T15:00:00.000Z", "2026-01-27T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,commission_cents,source,status,reversed_at,created_at,updated_at)
    VALUES ('adv-profit-reversed',?,'event-profit-reversed',?,'offer-profit-reversed','rev-profit-reversed','2026-01-27T15:00:00.000Z',900000,0,'live','reversed','2026-01-28T15:00:00.000Z',?,?)`).run(ids.workspace, ids.reversed, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,source,state,reversed_at,created_at)
    VALUES ('event-profit-reversed',?,?,'offer-profit-reversed','rev-profit-reversed','adv-profit-reversed','fund-profit-reversed','2026-01-27T15:00:00.000Z',900000,'live','reversed','2026-01-28T15:00:00.000Z',?)`).run(ids.workspace, ids.reversed, now)
  await db.prepare(`INSERT INTO audit_events (id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES ('aud-reversed',?,?,'user','funding.reversed','funding_event','event-profit-reversed',?,'corr-reverse-profit','2026-01-28T15:00:00.000Z')`).run(
    ids.workspace, ids.adminUser, JSON.stringify({ reason: "Merchant declined funding", reversedAt: "2026-01-28T15:00:00.000Z", transferPerformed: false }),
  )

  await insertDeal({ id: ids.march, name: "March Deal", requested: 2_000, createdAt: "2026-03-01T15:00:00.000Z" })
  await assign(ids.march, ids.ada, "originator")
  await insertDeal({ id: ids.otherDeal, workspace: ids.otherWorkspace, name: "Other Workspace Deal", requested: 99_000, createdAt: "2026-01-10T15:00:00.000Z" })
}

function januaryFilters() {
  return parseReportFilters(new URLSearchParams("basis=event&from=2026-01-01&to=2026-01-31"))
}

async function januaryReport() {
  return getTeamProfitReport(adminActor, januaryFilters(), asOf, "collected")
}

function userRow(report: TeamProfitReport, membershipId: string) {
  const found = report.users.find((item) => item.membershipId === membershipId)
  assert.ok(found, `missing user row ${membershipId}`)
  return found
}

function managerRow(report: TeamProfitReport) {
  const found = report.managers.find((item) => item.membershipId === ids.manager)
  assert.ok(found, "missing Morgan manager row")
  return found
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_team_profit")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("parseTeamProfitFilters and gross helpers stay honest", () => {
  assert.throws(() => parseTeamProfitFilters(new URLSearchParams("from=2026-01-01")), /basis/)
  assert.throws(() => parseTeamProfitFilters(new URLSearchParams("basis=event&from=2026-02-01&to=2026-01-01")), /from must be on or before to/)
  assert.throws(() => parseTeamProfitFilters(new URLSearchParams("basis=event&recognition=cash")), /recognition/)
  assert.equal(parseTeamProfitFilters(new URLSearchParams("basis=event&recognition=expected")).recognition, "expected")
  assert.equal(grossContributionCents(340_000, 320_000), 20_000)
  assert.equal(expectedGrossContributionCents(349_000, 320_000, 0), 29_000)
  assert.equal(SHARED_REP_ATTRIBUTION.companyTotals, "unique_deals")
  assert.equal(SHARED_REP_ATTRIBUTION.dealCredit, "full_per_assigned_rep")
})

test("MIC-101 company totals are not inflated by a deal assigned to multiple reps", async () => {
  const funnel = await getRepFunnelReport(adminActor, januaryFilters(), asOf)
  const report = await januaryReport()
  assert.equal(report.attribution, SHARED_REP_ATTRIBUTION)
  assert.equal(companyDealCountsMatchFunnel(report, funnel), true)
  assert.equal(report.company.stages.created.dealCount, funnel.totals.stages.created.dealCount)
  assert.equal(report.company.stages.created.dealCount, 4)
  assert.equal(report.company.stages.submitted.dealCount, 3)
  assert.equal(report.company.stages.funded.dealCount, 1)
  const ada = userRow(report, ids.ada)
  const beau = userRow(report, ids.beau)
  assert.equal(ada.stages.created.dealCount, 3)
  assert.equal(beau.stages.created.dealCount, 1)
  assert.ok(summedUserDealCount(report, "created") > report.company.stages.created.dealCount)
  assert.equal(ada.stages.funded.dealCount + beau.stages.funded.dealCount, 2)
  assert.equal(report.company.stages.funded.dealCount, 1)
  assert.notEqual(
    (ada.revenue.collectedCents ?? 0) + (beau.revenue.collectedCents ?? 0),
    report.company.revenue.collectedCents,
  )
  assert.equal(report.company.revenue.collectedCents, 340_000)
  assert.equal(funnel.totals.distributions.paidCents, 320_000)
  assert.equal(report.company.distributions.paidCents, funnel.totals.distributions.paidCents)
})

test("MIC-101 manager grouping unions shared deals once", async () => {
  const report = await januaryReport()
  const morgan = managerRow(report)
  const ada = userRow(report, ids.ada)
  const beau = userRow(report, ids.beau)
  const cara = userRow(report, ids.cara)
  assert.equal(morgan.stages.created.dealCount, 3)
  assert.ok(ada.stages.created.dealCount + beau.stages.created.dealCount + cara.stages.created.dealCount > morgan.stages.created.dealCount)
  assert.equal(morgan.stages.funded.dealCount, 1)
  assert.equal(morgan.revenue.collectedCents, 340_000)
  assert.equal(morgan.distributions.paidCents, 320_000)
  assert.equal(morgan.grossContribution.collectedCents, 20_000)
  assert.ok(morgan.memberIds.includes(ids.ada))
  assert.ok(morgan.memberIds.includes(ids.beau))
  assert.ok(morgan.memberIds.includes(ids.cara))
})

test("MIC-101 gross contribution is collected commission and fees minus paid distributions", async () => {
  const report = await januaryReport()
  assert.equal(report.company.revenue.collectedCents, 340_000)
  assert.equal(report.company.revenue.expectedCents, 349_000)
  assert.equal(report.company.distributions.paidCents, 320_000)
  assert.equal(report.company.grossContribution.collectedCents, 20_000)
  assert.equal(report.company.grossContribution.expectedCents, 29_000)
  assert.equal(report.company.grossContribution.formula, "collected_commission_and_fees_minus_paid_distributions")
  assert.equal(report.company.grossContribution.excludesOperatingCosts, true)
  assert.equal(report.otherOperatingCosts.visible, true)
  assert.equal(report.otherOperatingCosts.knownCents, 50_000)
  assert.equal(report.otherOperatingCosts.excludedFromGrossContribution, true)
  assert.notEqual(report.company.grossContribution.collectedCents, 20_000 - 50_000)
  assert.equal(
    report.company.grossContribution.collectedCents,
    grossContributionCents(report.company.revenue.collectedCents ?? 0, report.company.distributions.paidCents ?? 0),
  )
  const hidden = buildGrossContribution(
    { visible: false, reason: "payment_permission_required" },
    { visible: false, reason: "payment_permission_required" },
    { allowed: true, paymentsVisible: false, companyTotalsVisible: true, reason: "payment_permission_required" },
    true,
  )
  assert.equal(hidden.visible, false)
  assert.equal(hidden.collectedCents, undefined)
})

test("MIC-101 reversing a ledger entry updates the report with traceable evidence", async () => {
  const before = await januaryReport()
  assert.equal(before.company.revenue.collectedCents, 340_000)
  assert.equal(before.company.grossContribution.collectedCents, 20_000)
  assert.ok(before.evidence.some((item) => item.recordId === "pay-harbor-voided" && item.kind === "payment_void" && item.correlationId === "corr-void-harbor"))
  assert.ok(before.evidence.some((item) => item.recordId === "event-profit-reversed" && item.kind === "funding_reversal" && item.correlationId === "corr-reverse-profit"))
  assert.ok(before.evidence.some((item) => item.recordId === "adj-harbor-expected" && item.kind === "adjustment" && item.amountCents === -1_000))

  const db = getDatabase()
  await db.prepare("UPDATE mca_accounting_payments SET status='void', updated_at=? WHERE id=?").run("2026-01-30T12:00:00.000Z", "pay-harbor-fee")
  await db.prepare(`INSERT INTO audit_events (id,workspace_id,actor_user_id,source,action,resource_type,resource_id,metadata,correlation_id,created_at)
    VALUES ('aud-fee-void',?,?,'user','accounting.payment.voided','accounting_payment','pay-harbor-fee',?,'corr-void-harbor-fee','2026-01-30T12:00:00.000Z')`).run(
    ids.workspace, ids.adminUser, JSON.stringify({ reason: "Fee reversed after funding correction" }),
  )
  const after = await januaryReport()
  assert.equal(after.company.revenue.collectedCents, 320_000)
  assert.equal(after.company.grossContribution.collectedCents, 0)
  const voided = after.evidence.find((item) => item.recordId === "pay-harbor-fee")
  assert.ok(voided)
  assert.equal(voided.kind, "payment_void")
  assert.equal(voided.correlationId, "corr-void-harbor-fee")
  assert.equal(voided.amountCents, 20_000)
  assert.match(voided.reason ?? "", /reversed|void/i)

  await db.prepare("UPDATE mca_accounting_payments SET status='received', updated_at=? WHERE id=?").run(now, "pay-harbor-fee")
  await db.prepare("DELETE FROM audit_events WHERE id='aud-fee-void'").run()
  const restored = await januaryReport()
  assert.equal(restored.company.revenue.collectedCents, 340_000)
  assert.equal(restored.company.grossContribution.collectedCents, 20_000)
})

test("MIC-101 missing payment permission is Restricted, not $0", async () => {
  const db = getDatabase()
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(hidden, ids.workspace)
  const report = await januaryReport()
  assert.equal(report.permission.paymentsVisible, false)
  assert.equal(report.company.revenue.visible, false)
  assert.equal(report.company.revenue.collectedCents, undefined)
  assert.equal(report.company.grossContribution.visible, false)
  assert.equal(report.company.grossContribution.collectedCents, undefined)
  assert.equal(report.company.distributions.visible, false)
  assert.equal(report.otherOperatingCosts.visible, false)
  assert.equal(report.otherOperatingCosts.knownCents, undefined)
  assert.equal(report.evidence.length, 0)
  assert.equal(report.company.stages.created.dealCount, 4)
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(actions, ids.workspace)
})

test("MIC-101 API permissions match the admin reports UI and GET creates no records", async () => {
  const logs: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args) }
  const db = getDatabase()
  const beforeAudits = await db.prepare<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=?").get(ids.workspace)
  try {
    const url = "http://localhost/api/mca/reports/team-profit?basis=event&from=2026-01-01&to=2026-01-31&recognition=collected"
    assert.equal((await GET(new Request(url))).status, 401)
    const rep = await GET(new Request(url, { headers: { cookie: "mca_session=profit-rep-token" } }))
    assert.equal(rep.status, 403)
    const manager = await GET(new Request(url, { headers: { cookie: "mca_session=profit-manager-token" } }))
    assert.equal(manager.status, 403)
    const admin = await GET(new Request(url, { headers: { cookie: "mca_session=profit-admin-token" } }))
    assert.equal(admin.status, 200)
    const payload = await admin.json() as TeamProfitReport
    assert.equal(payload.company.stages.funded.dealCount, 1)
    assert.equal(payload.company.grossContribution.collectedCents, 20_000)
    const invalid = await GET(new Request("http://localhost/api/mca/reports/team-profit?basis=event&from=2026-02-01&to=2026-01-01", { headers: { cookie: "mca_session=profit-admin-token" } }))
    assert.equal(invalid.status, 422)
    const foreign = await GET(new Request(`${url}&membershipIds=${ids.otherMember}`, { headers: { cookie: "mca_session=profit-admin-token" } }))
    assert.equal(foreign.status, 422)
    await db.prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(JSON.stringify({ reports: false, payments: true, integrations: true }), ids.workspace)
    const disabled = await GET(new Request(url, { headers: { cookie: "mca_session=profit-admin-token" } }))
    assert.equal(disabled.status, 403)
    assert.equal((await disabled.json() as { error: { code: string } }).error.code, "reports_disabled")
    await db.prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(flags, ids.workspace)
    const afterAudits = await db.prepare<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=?").get(ids.workspace)
    assert.equal(afterAudits?.count, beforeAudits?.count)
    assert.equal(JSON.stringify(logs).includes("profit-admin-token"), false)
  } finally {
    console.log = original
  }
})

test("MIC-101 UI states cover loading empty validation success and failure", () => {
  const source = readFileSync(new URL("../src/components/mca/reports/team-profit.tsx", import.meta.url), "utf8")
  assert.match(source, /Loading team profit/)
  assert.match(source, /No deals or ledger activity match these filters/)
  assert.match(source, /role="status"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /not shown as \$0/)
  assert.match(source, /Choose an event or cohort basis/)
  assert.match(source, /From date must be on or before the to date/)
  assert.match(source, /The report could not be loaded/)
  assert.match(source, /\{TEAM_PROFIT_COPY\.retry\}/)
  assert.match(source, /Restricted/)
  assert.match(source, /Collected/)
  assert.match(source, /Expected/)
  assert.match(source, /Managers/)
  assert.match(source, /Excluded from gross contribution/)
  assert.match(source, /id="mca-reports-team-profit"/)
})
