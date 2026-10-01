import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET } from "../src/app/api/mca/reports/rep-funnel/route"
import {
  calendarDateInTimeZone,
  conversionRate,
  drilldownReconciles,
  getRepFunnelReport,
  parseReportFilters,
  requestedAmountToCents,
  SHARED_REP_ATTRIBUTION,
  type RepFunnelReport,
} from "../src/lib/mca/reports/rep-funnel"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-01T00:00:00.000Z"
const ids = {
  workspace: "ws-funnel",
  otherWorkspace: "ws-other",
  adminUser: "user-admin",
  adminMember: "member-admin",
  adaUser: "user-ada",
  ada: "member-ada",
  beauUser: "user-beau",
  beau: "member-beau",
  caraUser: "user-cara",
  cara: "member-cara",
  repUser: "user-rep",
  rep: "member-rep",
  managerUser: "user-manager",
  manager: "member-manager",
  otherUser: "user-other",
  otherMember: "member-other",
  harbor: "deal-harbor",
  beacon: "deal-beacon",
  unknown: "deal-unknown",
  december: "deal-december",
  unassigned: "deal-unassigned",
  timezone: "deal-timezone",
  reversed: "deal-reversed",
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
  activeMembershipIds: [ids.adminMember, ids.ada, ids.beau, ids.cara, ids.rep, ids.manager],
  source: "user",
  correlationId: "corr-funnel",
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
    ids.workspace, "Funnel Workspace", flags, pages, actions, now, now,
    ids.otherWorkspace, "Other Workspace", flags, pages, actions, now, now,
  )
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-ADMIN',?,?),(?,?,?,'APP-ADA',?,?),(?,?,?,'APP-BEAU',?,?),(?,?,?,'APP-CARA',?,?),
    (?,?,?,'APP-REP',?,?),(?,?,?,'APP-MGR',?,?),(?,?,?,'APP-OTHER',?,?)`).run(
    ids.adminUser, "admin@funnel.test", "Funnel Admin", now, now,
    ids.adaUser, "ada@funnel.test", "Ada Originator", now, now,
    ids.beauUser, "beau@funnel.test", "Beau Closer", now, now,
    ids.caraUser, "cara@funnel.test", "Cara Rep", now, now,
    ids.repUser, "rep@funnel.test", "Riley Rep", now, now,
    ids.managerUser, "manager@funnel.test", "Morgan Manager", now, now,
    ids.otherUser, "other@funnel.test", "Other Admin", now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'rep','active',?,?),
    (?,?,?,'rep','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'manager','active',?,?),
    (?,?,?,'admin','active',?,?)`).run(
    ids.adminMember, ids.workspace, ids.adminUser, now, now,
    ids.ada, ids.workspace, ids.adaUser, now, now,
    ids.beau, ids.workspace, ids.beauUser, now, now,
    ids.cara, ids.workspace, ids.caraUser, now, now,
    ids.rep, ids.workspace, ids.repUser, now, now,
    ids.manager, ids.workspace, ids.managerUser, now, now,
    ids.otherMember, ids.otherWorkspace, ids.otherUser, now, now,
  )
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-funnel-admin',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-funnel-rep',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-funnel-manager',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(
    ids.adminUser, ids.adminMember, hashOpaqueToken("funnel-admin-token"), now, now,
    ids.repUser, ids.rep, hashOpaqueToken("funnel-rep-token"), now, now,
    ids.managerUser, ids.manager, hashOpaqueToken("funnel-manager-token"), now, now,
  )

  for (let index = 1; index <= 5; index += 1) {
    await db.prepare(`INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run(`funder-${index}`, ids.workspace, `funder-key-${index}`, `Funder ${index}`, now, now)
  }
  await db.prepare(`INSERT INTO import_sources (id,workspace_id,name,kind,created_at) VALUES (?,?,?,'spreadsheet',?)`).run(ids.source, ids.workspace, "Alpha source", now)
  await db.prepare(`INSERT INTO lead_batches (id,workspace_id,source_id,name,created_at) VALUES (?,?,?,?,?)`).run(ids.batch, ids.workspace, ids.source, "Alpha batch", now)

  await insertDeal({ id: ids.harbor, name: "Harbor Bakery", requested: 50_000, createdAt: "2026-01-10T15:00:00.000Z", status: "funded" })
  await assign(ids.harbor, ids.ada, "originator")
  await assign(ids.harbor, ids.beau, "closer")
  await statusAt(ids.harbor, "submitted", "2026-01-12T15:00:00.000Z")
  await statusAt(ids.harbor, "offer", "2026-01-16T15:00:00.000Z", "submitted")
  await statusAt(ids.harbor, "funded", "2026-01-20T15:00:00.000Z", "offer")
  for (let index = 1; index <= 5; index += 1) {
    await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id)
      VALUES (?,?,?,?, 'sent', ?)`).run(`sub-harbor-${index}`, ids.workspace, ids.harbor, `Funder ${index}`, `funder-${index}`)
  }
  await db.prepare(`INSERT INTO mca_deal_acquisition_events (id,workspace_id,deal_id,source_id,batch_id,correlation_id,created_at)
    VALUES ('acq-harbor',?,?,?,?,?,?)`).run(ids.workspace, ids.harbor, ids.source, ids.batch, "corr-acq-harbor", now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-harbor',?,?, 'funder-1','Funder 1','manual','rev-harbor',?,?)`).run(ids.workspace, ids.harbor, "2026-01-16T15:00:00.000Z", "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at)
    VALUES ('rev-harbor',?,'offer-harbor',1,'funded',4000000,?,?,?)`).run(ids.workspace, "2026-01-16T15:00:00.000Z", "2026-01-30T15:00:00.000Z", "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_selections (id,workspace_id,deal_id,offer_id,offer_revision_id,active,selected_at)
    VALUES ('sel-harbor',?,?,'offer-harbor','rev-harbor',1,?)`).run(ids.workspace, ids.harbor, "2026-01-16T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,commission_cents,fee_cents,source,status,created_at,updated_at)
    VALUES ('adv-harbor',?,'event-harbor',?,'offer-harbor','rev-harbor','2026-01-20T15:00:00.000Z',4000000,5000000,320000,0,'live','active',?,?)`).run(ids.workspace, ids.harbor, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,source,state,created_at)
    VALUES ('event-harbor',?,?,'offer-harbor','rev-harbor','adv-harbor','fund-harbor','2026-01-20T15:00:00.000Z',4000000,320000,'live','committed',?)`).run(ids.workspace, ids.harbor, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,funding_event_id,type,origin,originator_membership_id,expected_amount_cents,received_amount_cents,expected_at,received_at,status,idempotency_key,created_at,updated_at)
    VALUES ('pay-harbor',?,'adv-harbor','event-harbor','commission','automatic',?,320000,320000,'2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','received','pay-harbor',?,?)`).run(ids.workspace, ids.ada, now, now)
  await db.prepare(`INSERT INTO mca_payment_distributions (id,workspace_id,payment_id,recipient_membership_id,percentage_basis_points,amount_cents,status,expected_at,paid_at,snapshot_json,idempotency_key,created_at,updated_at)
    VALUES ('dist-ada',?,'pay-harbor',?,6000,192000,'paid','2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','{}','dist-ada',?,?),
           ('dist-beau',?,'pay-harbor',?,4000,128000,'paid','2026-01-25T00:00:00.000Z','2026-01-28T00:00:00.000Z','{}','dist-beau',?,?),
           ('dist-void',?,'pay-harbor',?,1000,0,'void',NULL,NULL,'{}','dist-void',?,?)`).run(
    ids.workspace, ids.ada, now, now,
    ids.workspace, ids.beau, now, now,
    ids.workspace, ids.cara, now, now,
  )

  await insertDeal({ id: ids.beacon, name: "Beacon Bistro", requested: 10_000, createdAt: "2026-01-20T15:00:00.000Z" })
  await assign(ids.beacon, ids.ada, "originator")

  await insertDeal({ id: ids.unknown, name: "Unknown Terms LLC", requested: 8_000, createdAt: "2026-01-18T15:00:00.000Z", status: "offer" })
  await assign(ids.unknown, ids.ada, "originator")
  await statusAt(ids.unknown, "submitted", "2026-01-19T15:00:00.000Z")
  await statusAt(ids.unknown, "offer", "2026-01-21T15:00:00.000Z", "submitted")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id) VALUES ('sub-unknown',?,?,'Funder 2','approved','funder-2')`).run(ids.workspace, ids.unknown)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-unknown',?,?, 'funder-2','Funder 2','manual','rev-unknown',?,?)`).run(ids.workspace, ids.unknown, "2026-01-21T15:00:00.000Z", "2026-01-21T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,incomplete_fields_json,effective_at,expires_at,created_at)
    VALUES ('rev-unknown',?,'offer-unknown',1,'active',NULL,'["amountCents"]',?,?,?)`).run(ids.workspace, "2026-01-21T15:00:00.000Z", "2026-02-04T15:00:00.000Z", "2026-01-21T15:00:00.000Z")

  await insertDeal({ id: ids.december, name: "December Cohort Inc", requested: 12_000, createdAt: "2025-12-15T15:00:00.000Z", status: "submitted" })
  await assign(ids.december, ids.cara, "originator")
  await statusAt(ids.december, "submitted", "2026-01-05T15:00:00.000Z")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id) VALUES ('sub-december',?,?,'Funder 3','sent','funder-3')`).run(ids.workspace, ids.december)

  await insertDeal({ id: ids.unassigned, name: "Unassigned Merchant", requested: 3_000, createdAt: "2026-01-22T15:00:00.000Z" })
  await insertDeal({ id: ids.timezone, name: "Timezone Edge", requested: 1_000, createdAt: "2026-01-15T04:00:00.000Z" })
  await assign(ids.timezone, ids.ada, "originator")

  await insertDeal({ id: ids.reversed, name: "Reversed Funding", requested: 9_000, createdAt: "2026-01-25T15:00:00.000Z", status: "funded" })
  await assign(ids.reversed, ids.ada, "originator")
  await statusAt(ids.reversed, "submitted", "2026-01-26T15:00:00.000Z")
  await statusAt(ids.reversed, "funded", "2026-01-27T15:00:00.000Z", "submitted")
  await db.prepare(`INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status,funder_id) VALUES ('sub-reversed',?,?,'Funder 1','sent','funder-1')`).run(ids.workspace, ids.reversed)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES ('offer-reversed',?,?, 'funder-1','Funder 1','manual','rev-reversed',?,?)`).run(ids.workspace, ids.reversed, "2026-01-27T15:00:00.000Z", "2026-01-27T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,effective_at,expires_at,created_at)
    VALUES ('rev-reversed',?,'offer-reversed',1,'funded',900000,?,?,?)`).run(ids.workspace, "2026-01-27T15:00:00.000Z", "2026-02-10T15:00:00.000Z", "2026-01-27T15:00:00.000Z")
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,commission_cents,source,status,reversed_at,created_at,updated_at)
    VALUES ('adv-reversed',?,'event-reversed',?,'offer-reversed','rev-reversed','2026-01-27T15:00:00.000Z',900000,0,'live','reversed','2026-01-28T15:00:00.000Z',?,?)`).run(ids.workspace, ids.reversed, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,source,state,reversed_at,created_at)
    VALUES ('event-reversed',?,?,'offer-reversed','rev-reversed','adv-reversed','fund-reversed','2026-01-27T15:00:00.000Z',900000,'live','reversed','2026-01-28T15:00:00.000Z',?)`).run(ids.workspace, ids.reversed, now)

  await insertDeal({ id: ids.march, name: "March Deal", requested: 2_000, createdAt: "2026-03-01T15:00:00.000Z" })
  await assign(ids.march, ids.ada, "originator")
  await insertDeal({ id: ids.otherDeal, workspace: ids.otherWorkspace, name: "Other Workspace Deal", requested: 99_000, createdAt: "2026-01-10T15:00:00.000Z" })
}

function januaryFilters() {
  return parseReportFilters(new URLSearchParams("basis=event&from=2026-01-01&to=2026-01-31"))
}

async function januaryReport(overrides: Parameters<typeof getRepFunnelReport>[1] | null = null, nowIso = "2026-02-01T17:00:00.000Z") {
  return getRepFunnelReport(adminActor, overrides ?? januaryFilters(), nowIso)
}

function row(report: RepFunnelReport, membershipId: string) {
  const found = report.reps.find((item) => item.membershipId === membershipId)
  assert.ok(found, `missing rep row ${membershipId}`)
  return found
}

function resultRows<T>(result: { rows: unknown }): T[] {
  return result.rows as T[]
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_rep_funnel")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("parseReportFilters and conversion helpers reject invented values", () => {
  assert.throws(() => parseReportFilters(new URLSearchParams("from=2026-01-01")), /basis/)
  assert.throws(() => parseReportFilters(new URLSearchParams("basis=event&from=2026-02-01&to=2026-01-01")), /from must be on or before to/)
  assert.throws(() => parseReportFilters(new URLSearchParams("basis=weekly")), /basis/)
  assert.equal(conversionRate(1, 0), null)
  assert.equal(conversionRate(1, 4), 0.25)
  assert.equal(requestedAmountToCents(50_000), 5_000_000)
  assert.equal(requestedAmountToCents(null), null)
  assert.equal(calendarDateInTimeZone("2026-01-15T04:00:00.000Z", "America/New_York"), "2026-01-14")
  assert.equal(SHARED_REP_ATTRIBUTION.companyTotals, "unique_deals")
})

test("MIC-104 a deal submitted to five funders counts as one submitted deal", async () => {
  const submissions = resultRows<{ count: number }>(await fixture.query("SELECT count(*)::int AS count FROM deal_submissions WHERE deal_id=$1", [ids.harbor]))
  assert.equal(submissions[0]?.count, 5)
  const report = await januaryReport()
  assert.equal(report.drilldown.submitted.filter((item) => item.dealId === ids.harbor).length, 1)
  assert.equal(report.totals.stages.submitted.dealCount, 4)
  assert.ok(report.drilldown.submitted.some((item) => item.dealId === ids.harbor))
})

test("MIC-104 report total reconciles to drilldown and shared reps do not inflate unique totals", async () => {
  const report = await januaryReport()
  assert.equal(drilldownReconciles(report), true)
  assert.equal(report.totals.stages.created.dealCount, 6)
  assert.equal(report.totals.stages.submitted.dealCount, 4)
  assert.equal(report.totals.stages.approved.dealCount, 3)
  assert.equal(report.totals.stages.funded.dealCount, 1)
  const ada = row(report, ids.ada)
  const beau = row(report, ids.beau)
  assert.equal(ada.stages.created.dealCount, 5)
  assert.equal(beau.stages.created.dealCount, 1)
  assert.ok(ada.stages.created.dealCount + beau.stages.created.dealCount + (report.unassigned?.stages.created.dealCount ?? 0) > report.totals.stages.created.dealCount)
  assert.equal(report.drilldown.created.filter((item) => item.dealId === ids.harbor && item.shared).length, 1)
  assert.equal(report.unassigned?.stages.created.dealCount, 1)
  assert.equal(report.attribution.dealCredit, "full_per_assigned_rep")
})

test("MIC-104 event versus cohort basis uses workspace-local dates", async () => {
  const eventJanuary = await januaryReport()
  assert.equal(eventJanuary.drilldown.created.some((item) => item.dealId === ids.december), false)
  assert.equal(eventJanuary.drilldown.submitted.some((item) => item.dealId === ids.december), true)
  const cohortDecember = await januaryReport(parseReportFilters(new URLSearchParams("basis=cohort&from=2025-12-01&to=2025-12-31")))
  assert.equal(cohortDecember.totals.stages.created.dealCount, 1)
  assert.equal(cohortDecember.totals.stages.submitted.dealCount, 1)
  assert.equal(cohortDecember.drilldown.created[0]?.dealId, ids.december)
  const eventJan15 = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-15&to=2026-01-15")))
  assert.equal(eventJan15.drilldown.created.some((item) => item.dealId === ids.timezone), false)
  const eventJan14 = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-14&to=2026-01-14")))
  assert.equal(eventJan14.drilldown.created.some((item) => item.dealId === ids.timezone), true)
})

test("MIC-104 unknown amounts, reversed funding, and zero denominators stay honest", async () => {
  const report = await januaryReport()
  assert.equal(report.totals.stages.approved.unknownAmountCount, 1)
  assert.equal(report.totals.stages.approved.knownAmountCents, 4_900_000)
  assert.equal(report.totals.stages.approved.complete, false)
  assert.equal(report.totals.stages.funded.knownAmountCents, 4_000_000)
  assert.equal(report.drilldown.funded.some((item) => item.dealId === ids.reversed), false)
  const cara = await januaryReport(parseReportFilters(new URLSearchParams(`basis=event&from=2026-01-01&to=2026-01-31&membershipIds=${ids.cara}`)))
  const createdToSubmitted = cara.totals.conversions.find((item) => item.from === "created" && item.to === "submitted")
  assert.equal(createdToSubmitted?.denominator, 0)
  assert.equal(createdToSubmitted?.rate, null)
  assert.equal(createdToSubmitted?.rate ?? null, null)
})

test("MIC-104 attributed distributions use recipients and do not double-count", async () => {
  const report = await januaryReport()
  assert.equal(report.totals.distributions.visible, true)
  assert.equal(report.totals.distributions.paidCents, 320_000)
  const ada = row(report, ids.ada)
  const beau = row(report, ids.beau)
  assert.equal(ada.distributions.paidCents, 192_000)
  assert.equal(beau.distributions.paidCents, 128_000)
  assert.equal((ada.distributions.paidCents ?? 0) + (beau.distributions.paidCents ?? 0), report.totals.distributions.paidCents)
})

test("MIC-104 funder and source filters keep unique-deal submitted counts", async () => {
  const funder = await januaryReport(parseReportFilters(new URLSearchParams("basis=event&from=2026-01-01&to=2026-01-31&funderIds=funder-1")))
  assert.equal(funder.drilldown.submitted.filter((item) => item.dealId === ids.harbor).length, 1)
  assert.equal(funder.totals.stages.submitted.dealCount, 2)
  const source = await januaryReport(parseReportFilters(new URLSearchParams(`basis=event&from=2026-01-01&to=2026-01-31&sourceIds=${ids.source}`)))
  assert.deepEqual(source.drilldown.created.map((item) => item.dealId).sort(), [ids.harbor])
})

test("MIC-104 incomplete periods are labeled and other workspaces are excluded", async () => {
  const complete = await januaryReport(null, "2026-02-01T17:00:00.000Z")
  assert.equal(complete.period.complete, true)
  const incomplete = await januaryReport(null, "2026-01-31T17:00:00.000Z")
  assert.equal(incomplete.period.complete, false)
  assert.match(incomplete.period.label, /incomplete/i)
  const report = await januaryReport()
  assert.equal(report.drilldown.created.some((item) => item.dealId === ids.otherDeal), false)
  assert.equal(report.drilldown.created.some((item) => item.dealId === ids.march), false)
})

test("MIC-104 missing payment permission is restricted, not $0", async () => {
  const db = getDatabase()
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(hidden, ids.workspace)
  const report = await januaryReport()
  assert.equal(report.permission.paymentsVisible, false)
  assert.equal(report.permission.reason, "payment_permission_required")
  assert.equal(report.totals.distributions.visible, false)
  assert.equal(report.totals.distributions.paidCents, undefined)
  assert.equal(report.totals.distributions.reason, "payment_permission_required")
  await db.prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(actions, ids.workspace)
})

test("MIC-104 API permissions match the admin reports UI", async () => {
  const logs: unknown[][] = []
  const original = console.log
  console.log = (...args: unknown[]) => { logs.push(args) }
  try {
    const url = "http://localhost/api/mca/reports/rep-funnel?basis=event&from=2026-01-01&to=2026-01-31"
    assert.equal((await GET(new Request(url))).status, 401)
    const rep = await GET(new Request(url, { headers: { cookie: "mca_session=funnel-rep-token" } }))
    assert.equal(rep.status, 403)
    const manager = await GET(new Request(url, { headers: { cookie: "mca_session=funnel-manager-token" } }))
    assert.equal(manager.status, 403)
    const admin = await GET(new Request(url, { headers: { cookie: "mca_session=funnel-admin-token" } }))
    assert.equal(admin.status, 200)
    const payload = await admin.json() as RepFunnelReport
    assert.equal(payload.totals.stages.submitted.dealCount, 4)
    assert.equal(drilldownReconciles(payload), true)
    const invalid = await GET(new Request("http://localhost/api/mca/reports/rep-funnel?basis=event&from=2026-02-01&to=2026-01-01", { headers: { cookie: "mca_session=funnel-admin-token" } }))
    assert.equal(invalid.status, 422)
    const foreign = await GET(new Request(`${url}&membershipIds=${ids.otherMember}`, { headers: { cookie: "mca_session=funnel-admin-token" } }))
    assert.equal(foreign.status, 422)
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(JSON.stringify({ reports: false, payments: true, integrations: true }), ids.workspace)
    const disabled = await GET(new Request(url, { headers: { cookie: "mca_session=funnel-admin-token" } }))
    assert.equal(disabled.status, 403)
    assert.equal((await disabled.json() as { error: { code: string } }).error.code, "reports_disabled")
    await getDatabase().prepare("UPDATE workspaces SET feature_flags=? WHERE id=?").run(flags, ids.workspace)
    assert.equal(JSON.stringify(logs).includes("funnel-admin-token"), false)
  } finally {
    console.log = original
  }
})

test("MIC-104 UI states cover loading empty validation success and failure", () => {
  const source = readFileSync(new URL("../src/components/mca/reports/rep-funnel.tsx", import.meta.url), "utf8")
  assert.match(source, /Loading rep funnel/)
  assert.match(source, /No deals match these filters/)
  assert.match(source, /role="status"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /not shown as \$0/)
  assert.match(source, /Choose an event or cohort basis/)
  assert.match(source, /From date must be on or before the to date/)
  assert.match(source, /The report could not be loaded/)
  assert.match(source, /\{REP_FUNNEL_COPY\.retry\}/)
  assert.match(source, /Restricted/)
})

test("T7 performance counts unique stage deals and reconciles funding and commissions", async () => {
  const { getPerformanceReport } = await import("../src/lib/mca/reports/performance")
  const report = await getPerformanceReport(adminActor, januaryFilters(), "2026-02-01T17:00:00.000Z")
  assert.equal(report.stages.submitted.dealCount, 4)
  assert.equal(report.stages.submitted.deals.filter((item) => item.dealId === ids.harbor).length, 1)
  assert.equal(report.finance.fundedVolume.visible, true)
  if (report.finance.fundedVolume.visible) {
    assert.equal(report.finance.fundedVolume.knownCents, 4_000_000)
    assert.equal(report.finance.fundedVolume.records.length, 1)
  }
  if (report.finance.recordedFundingCommission.visible) assert.equal(report.finance.recordedFundingCommission.knownCents, 320_000)
  if (report.finance.collectedCommission.visible) assert.equal(report.finance.collectedCommission.knownCents, 320_000)
  assert.equal(report.timezone, "America/New_York")
  assert.equal(report.pipeline.deals.some((item) => item.dealId === ids.otherDeal), false)
  await assert.rejects(getPerformanceReport(adminActor, { ...januaryFilters(), membershipIds: [ids.otherMember] }), /not in this workspace/)
})

test("T7 finance restriction removes values and record identities from report and CSV", async () => {
  const { getPerformanceReport, performanceCsv } = await import("../src/lib/mca/reports/performance")
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: false })
  await getDatabase().prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(hidden, ids.workspace)
  try {
    const report = await getPerformanceReport(adminActor, januaryFilters())
    for (const metric of Object.values(report.finance)) assert.deepEqual(metric, { visible: false })
    for (const stage of Object.values(report.stages)) assert.equal(stage.deals.every((item) => item.amountCents === null), true)
    const csv = performanceCsv(report)
    assert.ok(csv.includes("Restricted"))
    assert.ok(!csv.includes("event-harbor"))
    assert.ok(!csv.includes("320000"))
  } finally {
    await getDatabase().prepare("UPDATE workspaces SET action_visibility=? WHERE id=?").run(actions, ids.workspace)
  }
})

test("T7 API applies admin role/filter gates and CSV snapshot parity", async () => {
  const { GET: performanceGet } = await import("../src/app/api/mca/reports/performance/route")
  const url = "http://localhost/api/mca/reports/performance?basis=event&from=2026-01-01&to=2026-01-31"
  assert.equal((await performanceGet(new Request(url))).status, 401)
  for (const token of ["funnel-rep-token", "funnel-manager-token"]) {
    assert.equal((await performanceGet(new Request(url, { headers: { cookie: `mca_session=${token}` } }))).status, 403)
  }
  const headers = { cookie: "mca_session=funnel-admin-token" }
  for (const query of ["basis=weekly", "basis=event&from=2026-02-30", `basis=event&membershipIds=${ids.otherMember}`, `basis=event&funderIds=foreign-funder`, "basis=event&format=xlsx"]) {
    assert.equal((await performanceGet(new Request(`http://localhost/api/mca/reports/performance?${query}`, { headers }))).status, 422)
  }
  const response = await performanceGet(new Request(url, { headers }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const payload = await response.json()
  const { performanceCsv } = await import("../src/lib/mca/reports/performance")
  assert.equal(payload.csvSnapshot, performanceCsv(payload.report))
  assert.ok(payload.csvSnapshot.includes("finance,fundedVolume,,,,1,4000000,0,Complete"))
  assert.ok(payload.csvSnapshot.includes("stage,submitted,,,,4"))
  const csvResponse = await performanceGet(new Request(`${url}&format=csv`, { headers }))
  assert.equal(csvResponse.status, 200)
  assert.ok(csvResponse.headers.get("content-type")?.includes("text/csv"))
})

test("T7 later funding dates reconcile independently and expected payments do not masquerade as collections", async () => {
  const { getPerformanceReport } = await import("../src/lib/mca/reports/performance")
  const db = getDatabase()
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,source,state,created_at)
    VALUES ('event-t7-later',?,?,'offer-harbor','rev-harbor','adv-t7-later','fund-t7-later','2026-02-01T04:00:00.000Z',100000,5000,'historical','committed',?)`).run(ids.workspace, ids.harbor, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,type,origin,expected_amount_cents,received_amount_cents,status,idempotency_key,created_at,updated_at)
    VALUES ('pay-t7-expected',?,'adv-harbor','commission','manual',7000,0,'expected','pay-t7-expected',?,?)`).run(ids.workspace, now, now)
  try {
    const filters = parseReportFilters(new URLSearchParams("basis=event&from=2026-01-31&to=2026-01-31"))
    const report = await getPerformanceReport(adminActor, filters)
    assert.equal(report.stages.funded.dealCount, 1)
    if (report.finance.fundedVolume.visible) assert.equal(report.finance.fundedVolume.knownCents, 100_000)
    const cohort = await getPerformanceReport(adminActor, { ...januaryFilters(), basis: "cohort" })
    if (cohort.finance.collectedCommission.visible) assert.equal(cohort.finance.collectedCommission.records.some((row) => row.recordId === "pay-t7-expected"), false)
  } finally {
    await db.prepare("DELETE FROM mca_funding_events WHERE id='event-t7-later'").run()
    await db.prepare("DELETE FROM mca_accounting_payments WHERE id='pay-t7-expected'").run()
  }
})

test("T7 renewals deduplicate source advances, fees/voids are excluded and broker payouts use recipients", async () => {
  const { getPerformanceReport } = await import("../src/lib/mca/reports/performance")
  const db = getDatabase()
  await db.prepare(`INSERT INTO mca_renewal_actions (id,workspace_id,source_advance_id,renewed_deal_id,policy_version,eligible_at,state,message_subject,message_body,idempotency_key,created_at,updated_at)
    VALUES ('t7-renew-1',?,'adv-harbor',?,1,'2026-01-28T15:00:00.000Z','converted','fixture','fixture','t7-renew-1',?,?),
    ('t7-renew-2',?,'adv-harbor',?,1,'2026-01-28T15:00:00.000Z','converted','fixture','fixture','t7-renew-2',?,?)`).run(ids.workspace, ids.beacon, now, now, ids.workspace, ids.otherDeal, now, now)
  await db.prepare(`INSERT INTO mca_accounting_payments (id,workspace_id,advance_id,type,origin,expected_amount_cents,received_amount_cents,received_at,status,idempotency_key,created_at,updated_at)
    VALUES ('t7-fee',?,'adv-harbor','fee','manual',9000,9000,'2026-01-28T15:00:00.000Z','received','t7-fee',?,?),
    ('t7-void',?,'adv-harbor','commission','manual',9999,9999,'2026-01-28T15:00:00.000Z','void','t7-void',?,?)`).run(ids.workspace, now, now, ids.workspace, now, now)
  try {
    const report = await getPerformanceReport(adminActor, januaryFilters())
    assert.equal(report.renewals.eligibleAdvanceCount, 1)
    assert.equal(report.renewals.convertedAdvanceCount, 1)
    assert.equal(report.renewals.records.find((row) => row.renewedDealId === ids.otherDeal), undefined)
    if (report.finance.collectedCommission.visible) assert.equal(report.finance.collectedCommission.knownCents, 320_000)
    if (report.finance.reversedFunding.visible) assert.equal(report.finance.reversedFunding.knownCents, 900_000)
    const broker = await getPerformanceReport(adminActor, { ...januaryFilters(), membershipIds: [ids.ada] })
    if (broker.finance.paidBrokerCommission.visible) assert.equal(broker.finance.paidBrokerCommission.knownCents, 192_000)
  } finally {
    await db.prepare("DELETE FROM mca_renewal_actions WHERE id IN ('t7-renew-1','t7-renew-2')").run()
    await db.prepare("DELETE FROM mca_accounting_payments WHERE id IN ('t7-fee','t7-void')").run()
  }
})
