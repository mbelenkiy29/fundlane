import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { persistInstallments, recordReceipt, runMissedPaymentAlerts } from "../src/lib/mca/deals/remittance"
import { listDealBook } from "../src/lib/mca/deals/book"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = { workspace: "ws-book", user: "user-book", member: "member-book", deal: "deal-book", offer: "offer-book", revision: "revision-book", event: "event-book", advance: "advance-book" }
const now = "2026-01-01T00:00:00.000Z"
const actor: DealActor = { workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.member], source: "user", correlationId: "corr-book" }

before(async () => {
  fixture = await createPostgresTestDatabase("deals_book")
  Object.assign(process.env, fixture.env())
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,?,?,?,?)`).run(ids.workspace, "Book Test",
      JSON.stringify({ reports: true, payments: true, integrations: true }),
      JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
      JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,'APP-BOOK',?,?)`).run(ids.user, "book@example.test", "Ada Book", now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)`).run(ids.member, ids.workspace, ids.user, now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('session-book',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(ids.user, ids.member, hashOpaqueToken("book-token"), now, now)
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,dba_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,'Harbor Bakery','Harbor','funded',1,'submission_ready','[]','{}',1,?,?)`).run(ids.deal, ids.workspace, "MCA-BOOK", now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id)
    VALUES ('assignment-book',?,?,?,'originator',1,?,?)`).run(ids.workspace, ids.deal, ids.member, now, ids.user)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,'Northstar Capital','manual',?,?,?)`).run(ids.offer, ids.workspace, ids.deal, ids.revision, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,created_at)
    VALUES (?,?,?,1,'funded',4000000,1250000,10,100000,'daily',320000,0,?,?)`).run(ids.revision, ids.workspace, ids.offer, now, now)
  await db.prepare(`INSERT INTO mca_funding_events (id,workspace_id,deal_id,offer_id,offer_revision_id,advance_id,idempotency_key,funded_at,amount_cents,commission_cents,fee_cents,source,state,created_at)
    VALUES (?,?,?,?,?,?,'fund-book',?,4000000,320000,0,'live','committed',?)`).run(ids.event, ids.workspace, ids.deal, ids.offer, ids.revision, ids.advance, now, now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,4000000,5000000,100000,10,'daily','calendar_days',320000,0,'live','{}','active',1,?,?)`).run(ids.advance, ids.workspace, ids.event, ids.deal, ids.offer, ids.revision, now, now, now)
})

after(async () => { await closeDatabaseForTests(); await fixture.close() })

test("installments persist once and missed alerts are idempotent", async () => {
  const first = await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: now, paymentCount: 10, paymentFrequency: "daily",
    calendarConvention: "calendar_days", periodicPaymentCents: 100_000, paybackCents: 5_000_000, createdAt: now,
  })
  const replay = await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: now, paymentCount: 10, paymentFrequency: "daily",
    calendarConvention: "calendar_days", periodicPaymentCents: 100_000, paybackCents: 5_000_000, createdAt: now,
  })
  assert.equal(first, 10)
  assert.equal(replay, 0)
  const alerts = await runMissedPaymentAlerts(actor, "2026-01-05T00:00:00.000Z")
  const replayAlerts = await runMissedPaymentAlerts(actor, "2026-01-05T00:00:00.000Z")
  assert.ok(alerts.created >= 1)
  assert.equal(replayAlerts.created, 0)
})

test("book list sorts by funded date and records receipts as completed payments", async () => {
  await recordReceipt(actor, ids.advance, { amountCents: 100_000, receivedAt: "2026-01-02", origin: "manual", idempotencyKey: "receipt-1" })
  const book = await listDealBook(actor, { asOf: "2026-01-05T12:00:00.000Z", missedWindow: "week", completedWindow: "week" })
  assert.equal(book.total, 1)
  assert.equal(book.rows[0].legalName, "Harbor Bakery")
  assert.equal(book.rows[0].advanceNumber, 1)
  assert.equal(book.rows[0].factorRate, 1.25)
  assert.equal(book.rows[0].servicingStatus, "active")
  assert.equal(book.dashboard.completed.count, 1)
  assert.equal(book.dashboard.completed.amountCents, 100_000)
  assert.ok(book.dashboard.missed.count >= 1)
})
