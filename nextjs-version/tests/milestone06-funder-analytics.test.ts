import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET } from "../src/app/api/mca/reports/funders/route"
import { GET as GET_FUNDER } from "../src/app/api/mca/reports/funders/[funderId]/route"
import {
  FUNDER_ANALYTICS_ATTRIBUTION,
  calendarDateInTimeZone,
  channelFromRouteKind,
  conversionRate,
  funderAnalyticsReconciles,
  getFunderAnalyticsReport,
  inReportPeriod,
  parseReportFilters,
  type FunderAnalyticsReport,
} from "../src/lib/mca/reports/funder-analytics"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-01T00:00:00.000Z"
const ids = {
  workspace: "ws-funders",
  otherWorkspace: "ws-other",
  adminUser: "user-admin",
  adminMember: "member-admin",
  repUser: "user-rep",
  rep: "member-rep",
  managerUser: "user-manager",
  manager: "member-manager",
  otherUser: "user-other",
  otherMember: "member-other",
  north: "funder-north",
  south: "funder-south",
  west: "funder-west",
  east: "funder-east",
  harbor: "deal-harbor",
  twin: "deal-twin",
  unknown: "deal-unknown",
  december: "deal-december",
  timezone: "deal-timezone",
  latepay: "deal-latepay",
  reversed: "deal-reversed",
  beacon: "deal-beacon",
  march: "deal-march",
  otherDeal: "deal-other",
  source: "source-alpha",
  batch: "batch-alpha",
}

const adminActor: DealActor = {
  workspaceId: ids.workspace,
  userId: ids.adminUser,
  membershipId: ids.adminMember,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [ids.adminMember, ids.rep, ids.manager],
  source: "user",
  correlationId: "corr-funders",
}

const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })

async function insertDeal(input: { id: string; workspace?: string; name: string; requested?: number; createdAt: string; status?: string }) {
  const db = getDatabase()
  const workspace = input.workspace ?? ids.workspace
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,requested_amount,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'submission_ready','[]','{}',1,?,?)`).run(
    input.id, workspace, input.id.replace("deal-", "MCA-").toUpperCase(), input.name, input.requested ?? null, input.status ?? "lead", input.createdAt, input.createdAt,
  )
  await db.prepare(`INSERT INTO deal_activity (id,workspace_id,deal_id,action,actor_user_id,source,summary,from_status,to_status,record_version,correlation_id,created_at)
    VALUES (?,?,?,'created',?,'manual','Deal created',NULL,NULL,1,?,?)`).run(`act-${input.id}`, workspace, input.id, ids.adminUser, `corr-${input.id}`, input.createdAt)
}

async function insertJob(input: { id: string; dealId: string; funderId: string; name: string; routeKind: "email" | "api"; at: string; status?: string }) {
  const db = getDatabase()
  await db.prepare(`INSERT INTO mca_submission_jobs
    (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'{}','sent',?,?,1,'[]','{"documentIds":[]}','[]',?,?)`).run(
    input.id, ids.workspace, input.dealId, input.funderId, input.name, input.routeKind, `confirm-${input.id}`, `attempt-${input.id}`, input.at, input.at,
  )
  await db.prepare(`INSERT INTO deal_submissions
    (id,workspace_id,deal_id,funder_name,status,funder_id,job_id,route_kind)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    `sub-${input.id}`, ids.workspace, input.dealId, input.name, input.status ?? "sent", input.funderId, input.id, input.routeKind,
  )
}

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',8,?,?,?,?,?),(?,?,'America/New_York',5,?,?,?,?,?)`).run(
    ids.workspace, "Funder Workspace", flags, pages, actions, now, now,
    ids.otherWorkspace, "Other Workspace", flags, pages, actions, now, now,
  )
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-ADMIN',?,?),(?,?,?,'APP-REP',?,?),(?,?,?,'APP-MGR',?,?),(?,?,?,'APP-OTHER',?,?)`).run(
    ids.adminUser, "admin@funders.test", "Funder Admin", now, now,
    ids.repUser, "rep@funders.test", "Riley Rep", now, now,
    ids.managerUser, "manager@funders.test", "Morgan Manager", now, now,
    ids.otherUser, "other@funders.test", "Other Admin", now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'manager','active',?,?),(?,?,?,'admin','active',?,?)`).run(
    ids.adminMember, ids.workspace, ids.adminUser, now, now,
    ids.rep, ids.workspace, ids.repUser, now, now,
    ids.manager, ids.workspace, ids.managerUser, now, now,
    ids.otherMember, ids.otherWorkspace, ids.otherUser, now, now,
  )
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-funder-admin',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-funder-rep',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-funder-manager',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(
    ids.adminUser, ids.adminMember, hashOpaqueToken("funder-admin-token"), now, now,
    ids.repUser, ids.rep, hashOpaqueToken("funder-rep-token"), now, now,
    ids.managerUser, ids.manager, hashOpaqueToken("funder-manager-token"), now, now,
  )
  for (const [id, name] of [[ids.north, "North Capital"], [ids.south, "South Advance"], [ids.west, "West Funding"], [ids.east, "East Partners"]] as const) {
    await db.prepare(`INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(
      id, ids.workspace, id, name, now, now,
    )
  }
  await db.prepare(`INSERT INTO import_sources (id,workspace_id,name,kind,created_at) VALUES (?,?,?,'spreadsheet',?)`).run(ids.source, ids.workspace, "Alpha source", now)
  await db.prepare(`INSERT INTO lead_batches (id,workspace_id,source_id,name,created_at) VALUES (?,?,?,?,?)`).run(ids.batch, ids.workspace, ids.source, "Alpha batch", now)

  await insertDeal({ id: ids.harbor, name: "Harbor Bakery", requested: 50_000, createdAt: "2026-01-10T15:00:00.000Z", status: "funded" })
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES (?,?,?,?, 'originator',1,?)`).run(
    "asg-harbor-admin", ids.workspace, ids.harbor, ids.adminMember, now,
  )
  await db.prepare(`INSERT INTO mca_deal_acquisition_events (id,workspace_id,deal_id,source_id,batch_id,correlation_id,created_at)
    VALUES ('acq-harbor',?,?,?,?,?,?)`).run(ids.workspace, ids.harbor, ids.source, ids.batch, "corr-acq-harbor", now)
  await insertJob({ id: "job-harbor-north-1", dealId: ids.harbor, funderId: ids.north, name: "North Capital", routeKind: "email", at: "2026-01-12T15:00:00.000Z" })
  await insertJob({ id: "job-harbor-north-2", dealId: ids.harbor, funderId: ids.north, name: "North Capital", routeKind: "email", at: "2026-01-13T15:00:00.000Z" })
  await insertJob({ id: "job-harbor-south", dealId: ids.harbor, funderId: ids.south, name: "South Advance", routeKind: "api", at: "2026-01-12T15:00:00.000Z" })
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,submission_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-harbor',?,?, 'job-harbor-north-1',?,'North Capital','email','rev-harbor-3',?,?)`).run(
    ids.workspace, ids.harbor, ids.north, "2026-01-16T15:00:00.000Z", "2026-01-16T15:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at)
    VALUES ('rev-harbor-1',?,'offer-harbor',1,'superseded',3500000,?,?,?),
           ('rev-harbor-2',?,'offer-harbor',2,'superseded',3800000,?,?,?),
           ('rev-harbor-3',?,'offer-harbor',3,'funded',4000000,?,?,?)`).run(
    ids.workspace, "2026-01-16T15:00:00.000Z", "2026-01-30T15:00:00.000Z", "2026-01-16T15:00:00.000Z",
    ids.workspace, "2026-01-17T15:00:00.000Z", "2026-01-31T15:00:00.000Z", "2026-01-17T15:00:00.000Z",
    ids.workspace, "2026-01-18T15:00:00.000Z", "2026-02-01T15:00:00.000Z", "2026-01-18T15:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_offer_selections (id,workspace_id,deal_id,offer_id,offer_revision_id,active,selected_at)
    VALUES ('sel-harbor',?,?,'offer-harbor','rev-harbor-3',1,?)`).run(ids.workspace, ids.harbor, "2026-01-18T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,commission_cents,fee_cents,source,status,created_at,updated_at)
    VALUES ('adv-harbor',?,'event-harbor',?,'offer-harbor','rev-harbor-3','2026-01-20T15:00:00.000Z',4000000,5000000,320000,10000,'live','active',?,?)`).run(ids.workspace, ids.harbor, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,fee_cents,source,state,created_at)
    VALUES ('event-harbor',?,?,'offer-harbor','rev-harbor-3','adv-harbor','fund-harbor','2026-01-20T15:00:00.000Z',4000000,320000,10000,'live','committed',?)`).run(ids.workspace, ids.harbor, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,funding_event_id,type,origin,expected_amount_cents,received_amount_cents,expected_at,received_at,status,idempotency_key,created_at,updated_at)
    VALUES ('pay-harbor-commission',?,'adv-harbor','event-harbor','commission','automatic',320000,320000,'2026-01-25T15:00:00.000Z','2026-01-28T15:00:00.000Z','received','pay-harbor-commission',?,?),
           ('pay-harbor-fee',?,'adv-harbor','event-harbor','fee','automatic',10000,10000,'2026-01-25T15:00:00.000Z','2026-01-28T15:00:00.000Z','received','pay-harbor-fee',?,?),
           ('pay-harbor-void',?,'adv-harbor','event-harbor','commission','manual',50000,0,NULL,NULL,'void','pay-harbor-void',?,?)`).run(
    ids.workspace, now, now,
    ids.workspace, now, now,
    ids.workspace, now, now,
  )

  await insertDeal({ id: ids.twin, name: "Twin Merchants LLC", requested: 12_000, createdAt: "2026-01-08T15:00:00.000Z" })
  await insertJob({ id: "job-twin-north", dealId: ids.twin, funderId: ids.north, name: "North Capital", routeKind: "email", at: "2026-01-14T15:00:00.000Z" })

  await insertDeal({ id: ids.unknown, name: "Unknown Terms LLC", requested: 8_000, createdAt: "2026-01-18T15:00:00.000Z", status: "offer" })
  await insertJob({ id: "job-unknown-south", dealId: ids.unknown, funderId: ids.south, name: "South Advance", routeKind: "api", at: "2026-01-19T15:00:00.000Z", status: "approved" })
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,submission_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-unknown',?,?, 'job-unknown-south',?,'South Advance','api','rev-unknown',?,?)`).run(
    ids.workspace, ids.unknown, ids.south, "2026-01-21T15:00:00.000Z", "2026-01-21T15:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,incomplete_fields_json,effective_at,expires_at,created_at)
    VALUES ('rev-unknown',?,'offer-unknown',1,'active',NULL,'["amountCents"]',?,?,?)`).run(ids.workspace, "2026-01-21T15:00:00.000Z", "2026-02-04T15:00:00.000Z", "2026-01-21T15:00:00.000Z")

  await insertDeal({ id: ids.december, name: "December Cohort Inc", requested: 12_000, createdAt: "2025-12-15T15:00:00.000Z", status: "submitted" })
  await insertJob({ id: "job-december-west", dealId: ids.december, funderId: ids.west, name: "West Funding", routeKind: "email", at: "2026-01-05T15:00:00.000Z" })

  await insertDeal({ id: ids.timezone, name: "Timezone Edge", requested: 1_000, createdAt: "2026-01-14T15:00:00.000Z" })
  await insertJob({ id: "job-timezone-west", dealId: ids.timezone, funderId: ids.west, name: "West Funding", routeKind: "email", at: "2026-01-15T04:00:00.000Z" })

  await insertDeal({ id: ids.latepay, name: "Late Pay LLC", requested: 10_000, createdAt: "2026-01-24T15:00:00.000Z", status: "funded" })
  await insertJob({ id: "job-latepay-east", dealId: ids.latepay, funderId: ids.east, name: "East Partners", routeKind: "api", at: "2026-01-24T15:00:00.000Z" })
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,submission_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-latepay',?,?, 'job-latepay-east',?,'East Partners','api','rev-latepay',?,?)`).run(
    ids.workspace, ids.latepay, ids.east, "2026-01-24T18:00:00.000Z", "2026-01-24T18:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at)
    VALUES ('rev-latepay',?,'offer-latepay',1,'funded',1000000,?,?,?)`).run(ids.workspace, "2026-01-24T18:00:00.000Z", "2026-02-07T18:00:00.000Z", "2026-01-24T18:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,commission_cents,source,status,created_at,updated_at)
    VALUES ('adv-latepay',?,'event-latepay',?,'offer-latepay','rev-latepay','2026-01-25T15:00:00.000Z',1000000,80000,'live','active',?,?)`).run(ids.workspace, ids.latepay, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,source,state,created_at)
    VALUES ('event-latepay',?,?,'offer-latepay','rev-latepay','adv-latepay','fund-latepay','2026-01-25T15:00:00.000Z',1000000,80000,'live','committed',?)`).run(ids.workspace, ids.latepay, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,funding_event_id,type,origin,expected_amount_cents,received_amount_cents,expected_at,received_at,status,idempotency_key,created_at,updated_at)
    VALUES ('pay-latepay',?,'adv-latepay','event-latepay','commission','automatic',80000,80000,'2026-01-30T15:00:00.000Z','2026-02-05T15:00:00.000Z','received','pay-latepay',?,?)`).run(
    ids.workspace, now, now,
  )

  await insertDeal({ id: ids.reversed, name: "Reversed Funding", requested: 9_000, createdAt: "2026-01-25T15:00:00.000Z", status: "funded" })
  await insertJob({ id: "job-reversed-south", dealId: ids.reversed, funderId: ids.south, name: "South Advance", routeKind: "api", at: "2026-01-26T15:00:00.000Z" })
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,submission_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-reversed',?,?, 'job-reversed-south',?,'South Advance','api','rev-reversed',?,?)`).run(
    ids.workspace, ids.reversed, ids.south, "2026-01-27T15:00:00.000Z", "2026-01-27T15:00:00.000Z",
  )
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at)
    VALUES ('rev-reversed',?,'offer-reversed',1,'funded',900000,?,?,?)`).run(ids.workspace, "2026-01-27T15:00:00.000Z", "2026-02-10T15:00:00.000Z", "2026-01-27T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,commission_cents,source,status,reversed_at,created_at,updated_at)
    VALUES ('adv-reversed',?,'event-reversed',?,'offer-reversed','rev-reversed','2026-01-27T15:00:00.000Z',900000,0,'live','reversed','2026-01-28T15:00:00.000Z',?,?)`).run(ids.workspace, ids.reversed, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,source,state,reversed_at,created_at)
    VALUES ('event-reversed',?,?,'offer-reversed','rev-reversed','adv-reversed','fund-reversed','2026-01-27T15:00:00.000Z',900000,'live','reversed','2026-01-28T15:00:00.000Z',?)`).run(ids.workspace, ids.reversed, now)

  await insertDeal({ id: ids.beacon, name: "Beacon Bistro", requested: 10_000, createdAt: "2026-01-20T15:00:00.000Z" })
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES ('sub-beacon',?,?,'Unknown Inbox','sent')`).run(ids.workspace, ids.beacon)

  await insertDeal({ id: ids.march, name: "March Deal", requested: 2_000, createdAt: "2026-03-01T15:00:00.000Z" })
  await insertJob({ id: "job-march-east", dealId: ids.march, funderId: ids.east, name: "East Partners", routeKind: "api", at: "2026-03-02T15:00:00.000Z" })

  await insertDeal({ id: ids.otherDeal, workspace: ids.otherWorkspace, name: "Other Workspace Deal", requested: 99_000, createdAt: "2026-01-10T15:00:00.000Z" })
}

function januaryFilters() {
  return parseReportFilters(new URLSearchParams("basis=event&from=2026-01-01&to=2026-01-31"))
}

async function januaryReport(overrides: Parameters<typeof getFunderAnalyticsReport>[1] | null = null, nowIso = "2026-02-01T17:00:00.000Z") {
  return getFunderAnalyticsReport(adminActor, overrides ?? januaryFilters(), nowIso)
}

function funder(report: FunderAnalyticsReport, funderId: string) {
  const found = report.funders.find((item) => item.funderId === funderId)
  assert.ok(found, `missing funder row ${funderId}`)
  return found
}

function resultRows<T>(result: { rows: unknown }): T[] {
  return result.rows as T[]
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_funder_analytics")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("parse helpers keep unknown denominators and lifetime dates honest", () => {
  assert.throws(() => parseReportFilters(new URLSearchParams("from=2026-01-01")), /basis/)
  assert.throws(() => parseReportFilters(new URLSearchParams("basis=event&from=2026-02-01&to=2026-01-01")), /from must be on or before to/)
  assert.equal(conversionRate(1, 0), null)
  assert.equal(channelFromRouteKind("api"), "api")
  assert.equal(channelFromRouteKind("email"), "email")
  assert.equal(calendarDateInTimeZone("2026-01-15T04:00:00.000Z", "America/New_York"), "2026-01-14")
  assert.equal(inReportPeriod(null, { basis: "event" }, "2026-01-01"), true)
  assert.equal(inReportPeriod(null, { basis: "event", from: "2026-01-01", to: "2026-01-31" }, "2026-01-01"), false)
  assert.equal(FUNDER_ANALYTICS_ATTRIBUTION.revisedOffers, "do_not_double_count")
  assert.equal(FUNDER_ANALYTICS_ATTRIBUTION.commissions, "ledger_received_non_void")
})

test("MIC-114 revised offers do not create multiple approval counts for one submission", async () => {
  const revisions = resultRows<{ count: number }>(await fixture.query("SELECT count(*)::int AS count FROM mca_offer_revisions WHERE offer_id=$1", ["offer-harbor"]))
  assert.equal(revisions[0]?.count, 3)
  const report = await januaryReport()
  const north = funder(report, ids.north)
  assert.equal(north.approvals.count, 1)
  const harborApprovals = report.drilldown.approvals.filter((item) => item.dealId === ids.harbor)
  assert.equal(harborApprovals.length, 1)
  assert.equal(harborApprovals[0]?.revisionCount, 3)
  assert.equal(harborApprovals[0]?.amountCents, 4_000_000)
  assert.equal(report.totals.approvals.count, 4)
  assert.equal(funderAnalyticsReconciles(report), true)
})

test("MIC-114 funder earned totals reconcile to the payment ledger", async () => {
  const report = await januaryReport()
  const ledgerJanuary = resultRows<{ total: number }>(await fixture.query(
    `SELECT coalesce(sum(received_amount_cents),0)::int AS total
     FROM mca_accounting_payments
     WHERE workspace_id=$1 AND type='commission' AND status <> 'void'
       AND received_at >= '2026-01-01T00:00:00.000Z' AND received_at <= '2026-01-31T23:59:59.000Z'`,
    [ids.workspace],
  ))
  assert.equal(report.totals.commissions.visible, true)
  assert.equal(report.totals.commissions.collectedCents, 320_000)
  assert.equal(report.totals.commissions.collectedCents, ledgerJanuary[0]?.total)
  assert.equal(funder(report, ids.north).commissions.collectedCents, 320_000)
  assert.equal(funder(report, ids.east).commissions.collectedCents, 0)
  assert.equal(report.drilldown.payments.some((item) => item.type === "fee"), true)
  assert.equal(report.drilldown.payments.some((item) => item.id === "pay-harbor-void"), false)
  const fee = report.drilldown.payments.find((item) => item.type === "fee")
  assert.equal(fee?.collectedCents, 10_000)
  const commissionSum = report.drilldown.payments.filter((item) => item.type === "commission").reduce((sum, item) => sum + item.collectedCents, 0)
  assert.equal(commissionSum, report.totals.commissions.collectedCents)
  assert.equal(funderAnalyticsReconciles(report), true)

  const lifetime = await januaryReport(parseReportFilters(new URLSearchParams("basis=event")), "2026-03-10T17:00:00.000Z")
  const ledgerLifetime = resultRows<{ total: number }>(await fixture.query(
    `SELECT coalesce(sum(received_amount_cents),0)::int AS total
     FROM mca_accounting_payments WHERE workspace_id=$1 AND type='commission' AND status <> 'void'`,
    [ids.workspace],
  ))
  assert.equal(lifetime.totals.commissions.collectedCents, 400_000)
  assert.equal(lifetime.totals.commissions.collectedCents, ledgerLifetime[0]?.total)
  assert.equal(funder(lifetime, ids.east).commissions.collectedCents, 80_000)
})

test("MIC-114 January event scenario groups submissions unique merchants approvals fundings and channels", async () => {
  const report = await januaryReport()
  assert.equal(report.totals.submissions.count, 9)
  assert.equal(report.totals.uniqueMerchants.count, 7)
  assert.equal(report.totals.approvals.count, 4)
  assert.equal(report.totals.approvals.unknownAmountCount, 1)
  assert.equal(report.totals.approvals.knownAmountCents, 5_900_000)
  assert.equal(report.totals.approvals.complete, false)
  assert.equal(report.totals.fundings.count, 2)
  assert.equal(report.totals.fundings.knownAmountCents, 5_000_000)
  assert.equal(report.drilldown.advances.some((item) => item.dealId === ids.reversed), false)
  const north = funder(report, ids.north)
  assert.equal(north.submissions.count, 3)
  assert.equal(north.uniqueMerchants.count, 2)
  assert.equal(north.channels.email, 3)
  assert.equal(north.channels.api, 0)
  const south = funder(report, ids.south)
  assert.equal(south.submissions.count, 3)
  assert.equal(south.uniqueMerchants.count, 3)
  assert.equal(south.channels.api, 3)
  assert.equal(south.approvals.count, 2)
  assert.equal(south.fundings.count, 0)
  const west = funder(report, ids.west)
  assert.equal(west.submissions.count, 2)
  const fundingRate = west.conversions.find((item) => item.from === "approvals" && item.to === "fundings")
  assert.equal(fundingRate?.denominator, 0)
  assert.equal(fundingRate?.rate, null)
  assert.equal(report.totals.channels.api, 4)
  assert.equal(report.totals.channels.email, 5)
  assert.equal(report.unattributed, null)
  assert.equal(funderAnalyticsReconciles(report), true)
  const harborNorth = report.drilldown.submissions.filter((item) => item.dealId === ids.harbor && item.funderId === ids.north)
  assert.equal(harborNorth.length, 2)
  assert.ok(harborNorth.every((item) => item.channel === "email"))
  assert.ok(report.drilldown.submissions.some((item) => item.dealId === ids.harbor && item.channel === "api"))
})

test("MIC-114 lifetime includes undated and later events that date filters exclude", async () => {
  const lifetime = await januaryReport(parseReportFilters(new URLSearchParams("basis=event")), "2026-03-10T17:00:00.000Z")
  assert.equal(lifetime.period.lifetime, true)
  assert.equal(lifetime.period.complete, false)
  assert.match(lifetime.period.label, /Lifetime/i)
  assert.equal(lifetime.totals.submissions.count, 11)
  assert.equal(lifetime.totals.uniqueMerchants.count, 9)
  assert.equal(lifetime.unattributed?.submissions.count, 1)
  assert.equal(lifetime.drilldown.submissions.some((item) => item.dealId === ids.beacon), true)
  assert.equal(lifetime.drilldown.submissions.some((item) => item.dealId === ids.march), true)
  const january = await januaryReport()
  assert.equal(january.drilldown.submissions.some((item) => item.dealId === ids.beacon), false)
  assert.equal(january.drilldown.submissions.some((item) => item.dealId === ids.march), false)
  assert.equal(january.period.complete, true)
  const incomplete = await januaryReport(null, "2026-01-31T17:00:00.000Z")
  assert.equal(incomplete.period.complete, false)
  assert.match(incomplete.period.label, /incomplete/i)
})

test("MIC-114 event versus cohort uses workspace-local dates and explicit denominators", async () => {
  const eventJanuary = await januaryReport()
  assert.equal(eventJanuary.drilldown.submissions.some((item) => item.dealId === ids.december), true)
  const cohortDecember = await januaryReport(parseReportFilters(new URLSearchParams("basis=cohort&from=2025-12-01&to=2025-12-31")))
  assert.equal(cohortDecember.totals.submissions.count, 1)
  assert.equal(cohortDecember.totals.uniqueMerchants.count, 1)
  assert.equal(cohortDecember.drilldown.submissions[0]?.dealId, ids.december)
  const eventJan15 = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-15&to=2026-01-15")))
  assert.equal(eventJan15.drilldown.submissions.some((item) => item.dealId === ids.timezone), false)
  const eventJan14 = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-14&to=2026-01-14")))
  assert.equal(eventJan14.drilldown.submissions.some((item) => item.dealId === ids.timezone), true)
  const cohortJanuary = await januaryReport(parseReportFilters(new URLSearchParams("basis=cohort&from=2026-01-01&to=2026-01-31")))
  assert.equal(cohortJanuary.totals.commissions.collectedCents, 400_000)
  assert.equal(eventJanuary.totals.commissions.collectedCents, 320_000)
})

test("MIC-114 missing payment permission is restricted, not $0", async () => {
  const db = getDatabase()
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(hidden, ids.workspace)
  const report = await januaryReport()
  assert.equal(report.permission.paymentsVisible, false)
  assert.equal(report.permission.reason, "payment_permission_required")
  assert.equal(report.totals.commissions.visible, false)
  assert.equal(report.totals.commissions.collectedCents, undefined)
  assert.equal(report.totals.commissions.reason, "payment_permission_required")
  assert.equal(report.drilldown.payments.length, 0)
  assert.equal(funder(report, ids.north).commissions.visible, false)
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(actions, ids.workspace)
})

test("MIC-114 API permissions match the admin reports UI", async () => {
  const logs: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args) }
  try {
    const url = "http://localhost/api/mca/reports/funders?basis=event&from=2026-01-01&to=2026-01-31"
    assert.equal((await GET(new Request(url))).status, 401)
    const rep = await GET(new Request(url, { headers: { cookie: "mca_session=funder-rep-token" } }))
    assert.equal(rep.status, 403)
    const manager = await GET(new Request(url, { headers: { cookie: "mca_session=funder-manager-token" } }))
    assert.equal(manager.status, 403)
    const admin = await GET(new Request(url, { headers: { cookie: "mca_session=funder-admin-token" } }))
    assert.equal(admin.status, 200)
    const payload = await admin.json() as FunderAnalyticsReport
    assert.equal(payload.totals.submissions.count, 9)
    assert.equal(funderAnalyticsReconciles(payload), true)
    const before = resultRows<{ count: number }>(await fixture.query("SELECT count(*)::int AS count FROM mca_accounting_payments WHERE workspace_id=$1", [ids.workspace]))
    const invalid = await GET(new Request("http://localhost/api/mca/reports/funders?basis=event&from=2026-02-01&to=2026-01-01", { headers: { cookie: "mca_session=funder-admin-token" } }))
    assert.equal(invalid.status, 422)
    const foreign = await GET(new Request(`${url}&funderIds=${ids.otherMember}`, { headers: { cookie: "mca_session=funder-admin-token" } }))
    assert.equal(foreign.status, 422)
    const nested = await GET_FUNDER(new Request(`${url}`, { headers: { cookie: "mca_session=funder-admin-token" } }), { params: Promise.resolve({ funderId: ids.north }) })
    assert.equal(nested.status, 200)
    const nestedPayload = await nested.json() as FunderAnalyticsReport
    assert.equal(nestedPayload.funders.length, 1)
    assert.equal(nestedPayload.funders[0]?.funderId, ids.north)
    assert.equal(nestedPayload.totals.submissions.count, 3)
    const after = resultRows<{ count: number }>(await fixture.query("SELECT count(*)::int AS count FROM mca_accounting_payments WHERE workspace_id=$1", [ids.workspace]))
    assert.equal(after[0]?.count, before[0]?.count)
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(JSON.stringify({ reports: false, payments: true, integrations: true }), ids.workspace)
    const disabled = await GET(new Request(url, { headers: { cookie: "mca_session=funder-admin-token" } }))
    assert.equal(disabled.status, 403)
    assert.equal((await disabled.json() as { error: { code: string } }).error.code, "reports_disabled")
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(flags, ids.workspace)
    assert.equal(JSON.stringify(logs).includes("funder-admin-token"), false)
  } finally {
    console.log = original
  }
})

test("MIC-114 UI states cover loading empty validation success and failure", () => {
  const source = readFileSync(new URL("../src/components/mca/reports/funder-analytics.tsx", import.meta.url), "utf8")
  assert.match(source, /Loading funder analytics/)
  assert.match(source, /No funder activity matches these filters/)
  assert.match(source, /role="status"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /not shown as \$0/)
  assert.match(source, /Missing term data is labeled unknown, not \$0/)
  assert.match(source, /Choose an event or cohort basis/)
  assert.match(source, /From date must be on or before the to date/)
  assert.match(source, /The report could not be loaded/)
  assert.match(source, /\{FUNDER_ANALYTICS_COPY\.retry\}/)
  assert.match(source, /Restricted/)
  assert.match(source, /Lifetime/)
  assert.match(source, /Revised offers do not create multiple approval counts/)
  assert.match(source, /reconcile to the payment ledger/)
  assert.match(source, /API and email stay distinct/)
})
