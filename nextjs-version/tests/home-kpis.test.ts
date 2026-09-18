import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { getHomeKpis } from "../src/lib/mca/home/kpis"
import { GET } from "../src/app/api/mca/home/kpis/route"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const nowIso = "2026-03-15T17:00:00.000Z"
const ids = {
  workspace: "ws-kpis",
  none: "ws-kpis-none",
  hidden: "ws-kpis-hidden",
  other: "ws-kpis-other",
  adminUser: "user-kpis-admin",
  adminMember: "member-kpis-admin",
  repUser: "user-kpis-rep",
  repMember: "member-kpis-rep",
  outsiderUser: "user-kpis-outsider",
  outsiderMember: "member-kpis-outsider",
  noneUser: "user-kpis-none",
  noneMember: "member-kpis-none",
  hiddenUser: "user-kpis-hidden",
  hiddenMember: "member-kpis-hidden",
  otherUser: "user-kpis-other",
  otherMember: "member-kpis-other",
  merchantShared: "merchant-shared",
  merchantDefault: "merchant-default",
  merchantClosed: "merchant-closed",
  merchantRenewed: "merchant-renewed",
  merchantA: "merchant-a-new",
  merchantB: "merchant-b-renew",
  merchantC: "merchant-c-later",
  openA: "deal-open-a",
  openB: "deal-open-b",
  fundedMtd: "deal-funded-mtd",
  fundedYtd: "deal-funded-ytd",
  fundedLy: "deal-funded-ly",
  closed: "deal-closed",
  advShared1: "deal-adv-shared-1",
  advShared2: "deal-adv-shared-2",
  advOrphan: "deal-adv-orphan",
  advDefault: "deal-adv-default",
  advClosed: "deal-adv-closed",
  advRenewed: "deal-adv-renewed",
  dealA: "deal-merchant-a",
  dealB1: "deal-merchant-b-first",
  dealB2: "deal-merchant-b-second",
  dealC: "deal-merchant-c",
  noneDeal: "deal-none",
  hiddenDeal: "deal-hidden",
}

const admin: DealActor = {
  workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.adminMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.adminMember, ids.repMember, ids.outsiderMember],
  source: "user", correlationId: "corr-kpis-admin",
}
const outsider: DealActor = {
  ...admin, userId: ids.outsiderUser, membershipId: ids.outsiderMember, role: "rep",
  managedMembershipIds: [], activeMembershipIds: [ids.outsiderMember], correlationId: "corr-kpis-outsider",
}
const noneAdmin: DealActor = {
  workspaceId: ids.none, userId: ids.noneUser, membershipId: ids.noneMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.noneMember], source: "user", correlationId: "corr-kpis-none",
}
const hiddenAdmin: DealActor = {
  workspaceId: ids.hidden, userId: ids.hiddenUser, membershipId: ids.hiddenMember, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.hiddenMember], source: "user", correlationId: "corr-kpis-hidden",
}

const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
const hiddenActions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: false })

function cookieRequest(path: string, token: string) {
  return new Request(`http://localhost${path}`, { headers: { cookie: `mca_session=${token}`, origin: "http://localhost" } })
}

function bearerRequest(path: string, secret: string) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer mca_${secret}`, origin: "http://localhost" } })
}

async function insertWorkspace(id: string, name: string, actionJson = actions, timezone = "America/New_York") {
  await getDatabase().prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?, ?, ?, 8, ?, ?, ?, ?, ?)`).run(id, name, timezone, flags, pages, actionJson, nowIso, nowIso)
}

async function insertUser(userId: string, memberId: string, email: string, workspaceId: string, role: string) {
  const db = getDatabase()
  await db.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, nowIso, nowIso)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
    VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, nowIso, nowIso)
}

async function insertDeal(input: {
  id: string
  workspace?: string
  name: string
  status: string
  requested?: number
  merchantId?: string | null
  industry?: string
  state?: string
  createdAt?: string
}) {
  const db = getDatabase()
  const workspace = input.workspace ?? ids.workspace
  const createdAt = input.createdAt ?? nowIso
  await db.prepare(`INSERT INTO deals
    (id, workspace_id, display_id, legal_name, requested_amount, industry, address_json, merchant_id, status,
     pipeline_version, draft_state, missing_required_json, field_sources_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'submission_ready', '[]', '{}', 1, ?, ?)`).run(
    input.id, workspace, input.id.replace("deal-", "MCA-").toUpperCase(), input.name,
    input.requested ?? null, input.industry ?? null,
    JSON.stringify(input.state ? { state: input.state } : {}),
    input.merchantId ?? null, input.status, createdAt, createdAt,
  )
}

async function assign(dealId: string, membershipId: string, workspaceId = ids.workspace) {
  await getDatabase().prepare(`INSERT INTO deal_assignments
    (id, workspace_id, deal_id, membership_id, kind, is_primary, assigned_at)
    VALUES (?, ?, ?, ?, 'originator', 1, ?)`).run(`asg-${dealId}-${membershipId}`, workspaceId, dealId, membershipId, nowIso)
}

async function insertMerchant(id: string, name: string) {
  await getDatabase().prepare(`INSERT INTO mca_merchants (id, workspace_id, legal_name, address_json, created_at, updated_at)
    VALUES (?, ?, ?, '{}', ?, ?)`).run(id, ids.workspace, name, nowIso, nowIso)
}

async function insertFunder(id: string, name: string, workspaceId = ids.workspace) {
  await getDatabase().prepare(`INSERT INTO mca_funders (id, workspace_id, idempotency_key, legal_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, workspaceId, id, name, nowIso, nowIso)
}

async function fundDeal(input: {
  dealId: string
  suffix: string
  fundedAt: string
  amountCents: number
  commissionCents?: number
  feeCents?: number
  funderName?: string
  workspace?: string
}) {
  const db = getDatabase()
  const workspace = input.workspace ?? ids.workspace
  const offerId = `offer-${input.suffix}`
  const revisionId = `rev-${input.suffix}`
  const advanceId = `adv-${input.suffix}`
  const eventId = `event-${input.suffix}`
  const funderName = input.funderName ?? "North Capital"
  await db.prepare(`INSERT INTO mca_offers
    (id, workspace_id, deal_id, funder_name, source, current_revision_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`).run(offerId, workspace, input.dealId, funderName, revisionId, input.fundedAt, input.fundedAt)
  await db.prepare(`INSERT INTO mca_offer_revisions
    (id, workspace_id, offer_id, revision_number, state, amount_cents, effective_at, created_at)
    VALUES (?, ?, ?, 1, 'funded', ?, ?, ?)`).run(revisionId, workspace, offerId, input.amountCents, input.fundedAt, input.fundedAt)
  await db.prepare(`INSERT INTO mca_advances
    (id, workspace_id, funding_event_id, deal_id, offer_id, offer_revision_id, funded_at, principal_cents,
     commission_cents, fee_cents, source, calculation_snapshot_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', '{}', 'active', ?, ?)`).run(
    advanceId, workspace, eventId, input.dealId, offerId, revisionId, input.fundedAt, input.amountCents,
    input.commissionCents ?? 0, input.feeCents ?? 0, input.fundedAt, input.fundedAt,
  )
  await db.prepare(`INSERT INTO mca_funding_events
    (id, workspace_id, deal_id, offer_id, offer_revision_id, advance_id, idempotency_key, funded_at,
     amount_cents, commission_cents, fee_cents, splits_json, accounting_record_ids_json, source, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'live', 'committed', ?)`).run(
    eventId, workspace, input.dealId, offerId, revisionId, advanceId, `fund-${input.suffix}`, input.fundedAt,
    input.amountCents, input.commissionCents ?? 0, input.feeCents ?? 0, input.fundedAt,
  )
  return { offerId, revisionId, advanceId, eventId }
}

async function insertPayment(input: {
  id: string
  advanceId: string
  type: "commission" | "fee"
  expectedCents: number
  receivedCents: number
  expectedAt: string | null
  receivedAt: string | null
  status: "expected" | "partial" | "received" | "void"
  eventId?: string
}) {
  await getDatabase().prepare(`INSERT INTO mca_accounting_payments
    (id, workspace_id, advance_id, funding_event_id, type, origin, expected_amount_cents, received_amount_cents,
     expected_at, received_at, status, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'automatic', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.id, ids.workspace, input.advanceId, input.eventId ?? null, input.type,
    input.expectedCents, input.receivedCents, input.expectedAt, input.receivedAt, input.status, input.id, nowIso, nowIso,
  )
}

async function insertPerformance(advanceId: string, status: string, workspaceId = ids.workspace, at = "2025-08-02T15:00:00.000Z") {
  await getDatabase().prepare(`INSERT INTO mca_advance_status_history
    (id, workspace_id, advance_id, status, reason, effective_at, actor_user_id, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `hist-${advanceId}`, workspaceId, advanceId, status, status, at, ids.adminUser, `corr-${advanceId}`, at,
  )
}

async function insertJob(input: { id: string; dealId: string; funderId: string; name: string; at: string; status?: string }) {
  const db = getDatabase()
  await db.prepare(`INSERT INTO mca_submission_jobs
    (id, workspace_id, deal_id, funder_id, display_funder_name, route_kind, route_json, state, confirmation_key, attempt_key,
     deal_version, document_versions_json, package_json, preflight_errors_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'email', '{}', 'sent', ?, ?, 1, '[]', '{"documentIds":[]}', '[]', ?, ?)`).run(
    input.id, ids.workspace, input.dealId, input.funderId, input.name, `confirm-${input.id}`, `attempt-${input.id}`, input.at, input.at,
  )
  await db.prepare(`INSERT INTO deal_submissions
    (id, workspace_id, deal_id, funder_name, status, funder_id, job_id, route_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'email')`).run(
    `sub-${input.id}`, ids.workspace, input.dealId, input.name, input.status ?? "sent", input.funderId, input.id,
  )
}

async function seed() {
  const db = getDatabase()
  await insertWorkspace(ids.workspace, "KPI Workspace")
  await insertWorkspace(ids.none, "KPI None")
  await insertWorkspace(ids.hidden, "KPI Hidden", hiddenActions)
  await insertWorkspace(ids.other, "KPI Other")
  await insertUser(ids.adminUser, ids.adminMember, "kpis-admin@example.test", ids.workspace, "admin")
  await insertUser(ids.repUser, ids.repMember, "kpis-rep@example.test", ids.workspace, "rep")
  await insertUser(ids.outsiderUser, ids.outsiderMember, "kpis-outsider@example.test", ids.workspace, "rep")
  await insertUser(ids.noneUser, ids.noneMember, "kpis-none@example.test", ids.none, "admin")
  await insertUser(ids.hiddenUser, ids.hiddenMember, "kpis-hidden@example.test", ids.hidden, "admin")
  await insertUser(ids.otherUser, ids.otherMember, "kpis-other@example.test", ids.other, "admin")
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("kpis-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("kpis-admin-token"), nowIso, nowIso)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("kpis-hidden-session", ids.hiddenUser, ids.hiddenMember, hashOpaqueToken("kpis-hidden-token"), nowIso, nowIso)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'read', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("kpis-read-key", ids.workspace, hashOpaqueToken("mca_read-secret"), JSON.stringify(["deals:read"]), ids.adminUser, nowIso)
  await db.prepare(`INSERT INTO api_keys
    (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
    VALUES (?, ?, 'intake', 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run("kpis-intake-key", ids.workspace, hashOpaqueToken("mca_intake-secret"), JSON.stringify(["intake:write"]), ids.adminUser, nowIso)

  await insertMerchant(ids.merchantShared, "Shared Merchant LLC")
  await insertMerchant(ids.merchantDefault, "Default Merchant LLC")
  await insertMerchant(ids.merchantClosed, "Closed Merchant LLC")
  await insertMerchant(ids.merchantRenewed, "Renewed Merchant LLC")
  await insertMerchant(ids.merchantA, "New Deal Alpha LLC")
  await insertMerchant(ids.merchantB, "Renewal Bravo LLC")
  await insertMerchant(ids.merchantC, "New Deal Charlie LLC")
  await insertFunder("funder-north", "North Capital")
  await insertFunder("funder-south", "South Advance")

  await insertDeal({ id: ids.openA, name: "Open Alpha LLC", status: "lead", requested: 100000, industry: "Food", state: "NY" })
  await insertDeal({ id: ids.openB, name: "Open Beta LLC", status: "submitted", requested: 50000, industry: "Retail", state: "NJ" })
  await insertDeal({ id: ids.fundedMtd, name: "Funded March LLC", status: "funded", requested: 40000, industry: "Food", state: "NY" })
  await insertDeal({ id: ids.fundedYtd, name: "Funded January LLC", status: "funded", requested: 10000, industry: "Retail", state: "CA" })
  await insertDeal({ id: ids.fundedLy, name: "Funded Last Year LLC", status: "funded", requested: 25000, industry: "Food", state: "NY" })
  await insertDeal({ id: ids.closed, name: "Closed LLC", status: "closed", requested: 1, industry: "Food", state: "NY" })
  await insertDeal({ id: ids.advShared1, name: "Shared One LLC", status: "funded", requested: 8000, merchantId: ids.merchantShared })
  await insertDeal({ id: ids.advShared2, name: "Shared Two LLC", status: "funded", requested: 8000, merchantId: ids.merchantShared })
  await insertDeal({ id: ids.advOrphan, name: "Orphan Advance LLC", status: "funded", requested: 8000 })
  await insertDeal({ id: ids.advDefault, name: "Default Advance LLC", status: "default", requested: 8000, merchantId: ids.merchantDefault })
  await insertDeal({ id: ids.advClosed, name: "Closed Advance LLC", status: "closed", requested: 8000, merchantId: ids.merchantClosed })
  await insertDeal({ id: ids.advRenewed, name: "Renewed Advance LLC", status: "renewed", requested: 8000, merchantId: ids.merchantRenewed })
  await insertDeal({ id: ids.dealA, name: "New Deal Alpha LLC", status: "funded", requested: 12000, merchantId: ids.merchantA, createdAt: "2026-03-02T15:00:00.000Z" })
  await insertDeal({ id: ids.dealB1, name: "Renewal Bravo First LLC", status: "funded", requested: 15000, merchantId: ids.merchantB, createdAt: "2026-01-05T15:00:00.000Z" })
  await insertDeal({ id: ids.dealB2, name: "Renewal Bravo Second LLC", status: "funded", requested: 18000, merchantId: ids.merchantB, createdAt: "2026-03-07T15:00:00.000Z" })
  await insertDeal({ id: ids.dealC, name: "New Deal Charlie LLC", status: "funded", requested: 9000, merchantId: ids.merchantC, createdAt: "2026-03-04T15:00:00.000Z" })
  await insertDeal({ id: ids.noneDeal, workspace: ids.none, name: "Empty Funnel LLC", status: "lead", requested: 10000 })
  await insertDeal({ id: ids.hiddenDeal, workspace: ids.hidden, name: "Hidden Dollars LLC", status: "funded", requested: 20000 })

  for (const dealId of [ids.openA, ids.openB, ids.fundedMtd, ids.fundedYtd, ids.fundedLy, ids.closed, ids.advShared1, ids.advShared2, ids.advOrphan, ids.advDefault, ids.advClosed, ids.advRenewed, ids.dealA, ids.dealB1, ids.dealB2, ids.dealC]) {
    await assign(dealId, ids.adminMember)
  }
  await assign(ids.openA, ids.repMember)
  await assign(ids.openB, ids.repMember)
  await assign(ids.noneDeal, ids.noneMember, ids.none)
  await assign(ids.hiddenDeal, ids.hiddenMember, ids.hidden)

  const mtd = await fundDeal({ dealId: ids.fundedMtd, suffix: "mtd", fundedAt: "2026-03-10T15:00:00.000Z", amountCents: 4_000_000, commissionCents: 320_000, funderName: "North Capital" })
  const ytd = await fundDeal({ dealId: ids.fundedYtd, suffix: "ytd", fundedAt: "2026-01-20T15:00:00.000Z", amountCents: 1_000_000, commissionCents: 80_000, funderName: "South Advance" })
  const ly = await fundDeal({ dealId: ids.fundedLy, suffix: "ly", fundedAt: "2025-06-15T15:00:00.000Z", amountCents: 2_500_000, commissionCents: 10_000, funderName: "North Capital" })
  const hidden = await fundDeal({ dealId: ids.hiddenDeal, suffix: "hidden", fundedAt: "2026-03-08T15:00:00.000Z", amountCents: 900_000, workspace: ids.hidden })

  const shared1 = await fundDeal({ dealId: ids.advShared1, suffix: "shared-1", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  const shared2 = await fundDeal({ dealId: ids.advShared2, suffix: "shared-2", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  await fundDeal({ dealId: ids.advOrphan, suffix: "orphan", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  const def = await fundDeal({ dealId: ids.advDefault, suffix: "default", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  const closedAdv = await fundDeal({ dealId: ids.advClosed, suffix: "closed-perf", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  const renewed = await fundDeal({ dealId: ids.advRenewed, suffix: "renewed-perf", fundedAt: "2025-08-01T15:00:00.000Z", amountCents: 500_000 })
  const merchantBFirst = await fundDeal({ dealId: ids.dealB1, suffix: "merchant-b-first", fundedAt: "2026-01-10T15:00:00.000Z", amountCents: 100_000 })
  const merchantBSecond = await fundDeal({ dealId: ids.dealB2, suffix: "merchant-b-second", fundedAt: "2026-03-08T15:00:00.000Z", amountCents: 200_000 })

  await insertPerformance(shared1.advanceId, "on_track")
  await insertPerformance(shared2.advanceId, "missed_payment")
  await insertPerformance(def.advanceId, "default")
  await insertPerformance(closedAdv.advanceId, "closed")
  await insertPerformance(renewed.advanceId, "renewed")
  await insertPerformance(merchantBFirst.advanceId, "closed")
  await insertPerformance(merchantBSecond.advanceId, "closed")
  await insertPerformance(mtd.advanceId, "closed")
  await insertPerformance(ytd.advanceId, "closed")
  await insertPerformance(ly.advanceId, "closed")
  await insertPerformance(hidden.advanceId, "closed", ids.hidden)

  await insertPayment({
    id: "pay-commission-mtd", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "commission",
    expectedCents: 320000, receivedCents: 320000, expectedAt: "2026-03-05T15:00:00.000Z", receivedAt: "2026-03-10T15:00:00.000Z", status: "received",
  })
  await insertPayment({
    id: "pay-commission-ytd", advanceId: ytd.advanceId, eventId: ytd.eventId, type: "commission",
    expectedCents: 80000, receivedCents: 80000, expectedAt: "2026-01-22T15:00:00.000Z", receivedAt: "2026-01-22T15:00:00.000Z", status: "received",
  })
  await insertPayment({
    id: "pay-commission-void", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "commission",
    expectedCents: 50000, receivedCents: 0, expectedAt: nowIso, receivedAt: nowIso, status: "void",
  })
  await insertPayment({
    id: "pay-expected-today", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "commission",
    expectedCents: 40000, receivedCents: 0, expectedAt: "2026-03-16T03:30:00.000Z", receivedAt: null, status: "expected",
  })
  await insertPayment({
    id: "pay-expected-today-fee", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "fee",
    expectedCents: 10000, receivedCents: 0, expectedAt: "2026-03-15T17:00:00.000Z", receivedAt: null, status: "expected",
  })
  await insertPayment({
    id: "pay-received-today-fee", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "fee",
    expectedCents: 25000, receivedCents: 25000, expectedAt: "2026-03-01T15:00:00.000Z", receivedAt: "2026-03-15T17:00:00.000Z", status: "received",
  })
  await insertPayment({
    id: "pay-expected-yesterday-ny", advanceId: mtd.advanceId, eventId: mtd.eventId, type: "commission",
    expectedCents: 99999, receivedCents: 0, expectedAt: "2026-03-15T03:30:00.000Z", receivedAt: null, status: "expected",
  })

  await insertJob({ id: "job-open-b-1", dealId: ids.openB, funderId: "funder-north", name: "North Capital", at: "2026-03-02T15:00:00.000Z", status: "approved" })
  await insertJob({ id: "job-open-b-2", dealId: ids.openB, funderId: "funder-south", name: "South Advance", at: "2026-03-03T15:00:00.000Z" })
}

before(async () => {
  fixture = await createPostgresTestDatabase("home_kpis")
  Object.assign(process.env, fixture.env())
  await seed()
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("pipeline volume sums requestedAmount for open deals only", async () => {
  const kpis = await getHomeKpis(admin, { period: "mtd", nowIso })
  assert.equal(kpis.pipeline.count, 2)
  assert.equal(kpis.pipeline.volumeDollars, 150000)
  assert.equal(kpis.pipeline.dollarsHidden, false)
  assert.equal(kpis.empty, false)
  assert.equal(kpis.timezone, "America/New_York")
  assert.equal(kpis.asOf, nowIso)
  assert.equal(kpis.period, "mtd")
})

test("funded MTD ignores last year and YTD includes it", async () => {
  const mtd = await getHomeKpis(admin, { period: "mtd", nowIso })
  assert.equal(mtd.funded.count, 2)
  assert.equal(mtd.funded.amountCents, 4_200_000)
  assert.equal(mtd.commission.count, 1)
  assert.equal(mtd.commission.amountCents, 320_000)

  const ytd = await getHomeKpis(admin, { period: "ytd", nowIso })
  assert.equal(ytd.funded.count, 4)
  assert.equal(ytd.funded.amountCents, 5_300_000)
  assert.equal(ytd.commission.count, 2)
  assert.equal(ytd.commission.amountCents, 400_000)
  const june = ytd.series.fundedByMonth.find((row) => row.month === "2025-06")
  assert.equal(june?.fundedCents, 2_500_000)
  assert.equal(ytd.series.pipelineByMonth.length, 12)
  assert.equal(ytd.series.approvalByMonth.length, 12)
  assert.equal(ytd.series.collectionsByDay.length, 14)
  assert.equal(ytd.series.collectionsByDay.at(-1)?.day, "2026-03-15")
})

test("active merchants count only on_track and missed_payment advances", async () => {
  const kpis = await getHomeKpis(admin, { period: "mtd", nowIso })
  assert.equal(kpis.activeMerchants.count, 2)
})

test("approval rate is N/A when submissions are zero", async () => {
  const kpis = await getHomeKpis(noneAdmin, { period: "mtd", nowIso })
  assert.equal(kpis.approvalRate.numerator, 0)
  assert.equal(kpis.approvalRate.denominator, 0)
  assert.equal(kpis.approvalRate.rate, null)
})

test("approval rate is unique approvals over unique submissions", async () => {
  const kpis = await getHomeKpis(admin, { period: "mtd", nowIso })
  assert.equal(kpis.approvalRate.numerator, 1)
  assert.equal(kpis.approvalRate.denominator, 2)
  assert.equal(kpis.approvalRate.rate, 0.5)
})

test("collections today splits expected vs received on calendar date in workspace TZ", async () => {
  const kpis = await getHomeKpis(admin, { period: "mtd", nowIso })
  assert.equal(kpis.collectionsToday.source, "accounting_payments")
  assert.equal(kpis.collectionsToday.expectedCents, 50_000)
  assert.equal(kpis.collectionsToday.receivedCents, 25_000)
  assert.equal(kpis.collectionsToday.dollarsHidden, false)
})

test("empty is true when the actor sees no deals", async () => {
  const kpis = await getHomeKpis(outsider, { period: "mtd", nowIso })
  assert.equal(kpis.empty, true)
  assert.equal(kpis.pipeline.count, 0)
  assert.equal(kpis.funded.count, 0)
  assert.equal(kpis.activeMerchants.count, 0)
})

test("dollarsHidden when viewCompanyFinancials is false", async () => {
  const kpis = await getHomeKpis(hiddenAdmin, { period: "mtd", nowIso })
  assert.equal(kpis.funded.amountCents, null)
  assert.equal(typeof kpis.funded.count, "number")
  assert.equal(kpis.funded.count, 1)
  assert.equal(kpis.funded.dollarsHidden, true)
  assert.equal(kpis.pipeline.volumeDollars, null)
  assert.equal(kpis.pipeline.count, 0)
  assert.equal(kpis.pipeline.dollarsHidden, true)
})

test("new deals and renewals are separate period counts", async () => {
  const kpis = await getHomeKpis(admin, { period: "mtd", nowIso })
  // first-time originations created in March 2026 are new deals
  assert.ok(kpis.newDeals.count >= 1)
  // a later committed funding on merchant-renewed is a renewal, not a new deal
  assert.ok("renewals" in kpis)
  assert.equal(typeof kpis.renewals.count, "number")
  // a renewed merchant's first deal must not also sit in newDeals
  const growth = kpis.series.merchantGrowth.find((row) => row.month === "2026-03")
  assert.ok(growth)
  assert.equal("renewals" in growth, true)
  assert.equal("returning" in growth, false)
  assert.equal(kpis.newDeals.count, 5)
  assert.equal(kpis.renewals.count, 2)
  assert.equal(growth.new, 5)
  assert.equal(growth.renewals, 2)
})

test("GET /api/mca/home/kpis requires period mtd|ytd and does not store", async () => {
  const unauth = await GET(new Request("http://localhost/api/mca/home/kpis?period=mtd"))
  assert.equal(unauth.status, 401)

  const invalid = await GET(cookieRequest("/api/mca/home/kpis?period=weekly", "kpis-admin-token"))
  assert.equal(invalid.status, 422)
  const invalidBody = await invalid.json() as { error: { code: string; fieldErrors?: Record<string, string[]> } }
  assert.equal(invalidBody.error.code, "invalid_filter")
  assert.ok(invalidBody.error.fieldErrors?.period)

  const missing = await GET(cookieRequest("/api/mca/home/kpis", "kpis-admin-token"))
  assert.equal(missing.status, 422)

  const res = await GET(cookieRequest(`/api/mca/home/kpis?period=mtd&now=${encodeURIComponent(nowIso)}`, "kpis-admin-token"))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("cache-control"), "no-store")
  const body = await res.json() as { pipeline: { count: number }; period: string }
  assert.equal(body.period, "mtd")
  assert.equal(body.pipeline.count, 2)

  const keyRes = await GET(bearerRequest(`/api/mca/home/kpis?period=mtd&now=${encodeURIComponent(nowIso)}`, "read-secret"))
  assert.equal(keyRes.status, 200)
  const denied = await GET(bearerRequest(`/api/mca/home/kpis?period=mtd&now=${encodeURIComponent(nowIso)}`, "intake-secret"))
  assert.equal(denied.status, 403)
})
