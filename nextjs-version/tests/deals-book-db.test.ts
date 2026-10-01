import { assertPendingProfileHidden } from "./helpers/pending-profile"
import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { persistInstallments, recordReceipt, runMissedPaymentAlerts, voidReceipt } from "../src/lib/mca/deals/remittance"
import { getDealBookRow, listDealBook } from "../src/lib/mca/deals/book"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = {
  workspace: "ws-book", user: "user-book", member: "member-book",
  managerUser: "user-book-manager", managerMember: "member-book-manager",
  repUser: "user-book-rep", repMember: "member-book-rep",
  deal: "deal-book", offer: "offer-book", revision: "revision-book", event: "event-book", advance: "advance-book",
}
const now = "2026-01-01T00:00:00.000Z"
const actor: DealActor = { workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.member, ids.managerMember, ids.repMember], source: "user", correlationId: "corr-book" }
const managerActor: DealActor = { ...actor, userId: ids.managerUser, membershipId: ids.managerMember, role: "manager", correlationId: "corr-book-manager" }
const repActor: DealActor = { ...actor, userId: ids.repUser, membershipId: ids.repMember, role: "rep", correlationId: "corr-book-rep" }

before(async () => {
  fixture = await createPostgresTestDatabase("deals_book")
  Object.assign(process.env, fixture.env())
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,?,?,?,?)`).run(ids.workspace, "Book Test",
      JSON.stringify({ reports: true, payments: true, integrations: true }),
      JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
      JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }), now, now)
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-BOOK',?,?),(?,?,?,'APP-BOOK-MGR',?,?),(?,?,?,'APP-BOOK-REP',?,?)`).run(
    ids.user, "book@example.test", "Ada Book", now, now,
    ids.managerUser, "book-manager@example.test", "Moe Manager", now, now,
    ids.repUser, "book-rep@example.test", "Rita Rep", now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'manager','active',?,?),(?,?,?,'rep','active',?,?)`).run(
    ids.member, ids.workspace, ids.user, now, now,
    ids.managerMember, ids.workspace, ids.managerUser, now, now,
    ids.repMember, ids.workspace, ids.repUser, now, now)
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-book',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-book-manager',?,?,?,'2027-01-01T00:00:00.000Z',?,?),
    ('session-book-rep',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(
    ids.user, ids.member, hashOpaqueToken("book-token"), now, now,
    ids.managerUser, ids.managerMember, hashOpaqueToken("book-manager-token"), now, now,
    ids.repUser, ids.repMember, hashOpaqueToken("book-rep-token"), now, now)
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,dba_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,'Harbor Bakery','Harbor','funded',1,'submission_ready','[]','{}',1,?,?)`).run(ids.deal, ids.workspace, "MCA-BOOK", now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id) VALUES
    ('assignment-book',?,?,?,'originator',1,?,?),
    ('assignment-book-manager',?,?,?,'closer',1,?,?)`).run(
    ids.workspace, ids.deal, ids.member, now, ids.user,
    ids.workspace, ids.deal, ids.managerMember, now, ids.user)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,'Northstar Capital','manual',?,?,?)`).run(ids.offer, ids.workspace, ids.deal, ids.revision, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES (?,?,?,1,'funded',4000000,1250000,10,100000,'daily',320000,0,?,?,?)`).run(ids.revision, ids.workspace, ids.offer, now, new Date(Date.parse(now) + 14 * 86_400_000).toISOString(), now)
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
  await recordReceipt(actor, ids.advance, { amountCents: 100_000, receivedAt: "2026-01-06", origin: "manual", idempotencyKey: "receipt-1" })
  const book = await listDealBook(actor, { asOf: "2026-01-07T12:00:00.000Z", missedWindow: "week", completedWindow: "week" })
  assert.equal(book.total, 1)
  assert.equal(book.rows[0].legalName, "Harbor Bakery")
  assert.equal(book.rows[0].advanceNumber, 1)
  assert.equal(book.rows[0].factorRate, 1.25)
  assert.equal(book.rows[0].servicingStatus, "active")
  assert.equal(book.dashboard.completed.count, 1)
  assert.equal(book.dashboard.completed.amountCents, 100_000)
  assert.ok(book.dashboard.missed.count >= 1)
})

test("large repayment schedules use bounded batches and preserve every installment on retry", async () => {
  const db = getDatabase()
  await db.prepare("DELETE FROM mca_servicing_alerts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_receipts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_installments WHERE advance_id=?").run(ids.advance)
  let inserts = 0
  const counted = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("INSERT INTO mca_merchant_installments")) inserts += 1
        return target.prepare(sql)
      }
      return Reflect.get(target, property)
    },
  })
  const input = { workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2030-01-01", paymentCount: 1086,
    paymentFrequency: "daily", calendarConvention: "business_days", periodicPaymentCents: 100, paybackCents: 108550, createdAt: now }
  const { generateExpectedInstallments } = await import("../src/lib/mca/advances/performance")
  assert.equal(await persistInstallments(counted, input), 1086)
  assert.equal(inserts, 5)
  const rows = await db.prepare<{ sequence: number; occurrenceDate: string; amountCents: number }>(`SELECT sequence,
    occurrence_date AS "occurrenceDate", amount_cents AS "amountCents" FROM mca_merchant_installments
    WHERE advance_id=? AND occurrence_date > '2030-01-01' ORDER BY sequence`).all(ids.advance)
  assert.deepEqual(rows, generateExpectedInstallments(input))
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 108550)
  assert.equal(await persistInstallments(counted, input), 0)
  assert.equal(inserts, 10)
})

test("leftover last installment of 0 persists and sums to payback", async () => {
  const db = getDatabase()
  await db.prepare("DELETE FROM mca_servicing_alerts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_receipts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_installments WHERE advance_id=?").run(ids.advance)
  const input = {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08", paymentCount: 10,
    paymentFrequency: "daily", calendarConvention: "calendar_days", periodicPaymentCents: 1000, paybackCents: 9000, createdAt: now,
  }
  assert.equal(await persistInstallments(db, input), 10)
  const rows = await db.prepare<{ amountCents: number }>(
    `SELECT amount_cents AS "amountCents" FROM mca_merchant_installments WHERE advance_id=? ORDER BY sequence`,
  ).all(ids.advance)
  assert.equal(rows.at(-1)?.amountCents, 0)
  assert.equal(rows.reduce((sum, row) => sum + row.amountCents, 0), 9000)
})

test("receipts and missed alerts use workspace calendar dates not UTC slices", async () => {
  const db = getDatabase()
  await db.prepare("DELETE FROM mca_servicing_alerts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_receipts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_installments WHERE advance_id=?").run(ids.advance)

  assert.equal(await persistInstallments(db, {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-13T02:00:00.000Z",
    paymentCount: 2, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 100_000, paybackCents: 200_000, createdAt: now, timeZone: "America/New_York",
  }), 2)
  const fundedDates = await db.prepare<{ occurrenceDate: string }>(
    `SELECT occurrence_date AS "occurrenceDate" FROM mca_merchant_installments WHERE advance_id=? ORDER BY sequence`,
  ).all(ids.advance)
  assert.deepEqual(fundedDates.map((row) => row.occurrenceDate), ["2026-09-13", "2026-09-14"])

  await db.prepare("DELETE FROM mca_merchant_installments WHERE advance_id=?").run(ids.advance)
  assert.equal(await persistInstallments(db, {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08",
    paymentCount: 10, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 100_000, paybackCents: 1_000_000, createdAt: now, timeZone: "America/New_York",
  }), 10)

  const receipt = await recordReceipt(actor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-13T02:00:00.000Z", origin: "manual", idempotencyKey: "tz-receipt-ny",
  })
  assert.equal(receipt.received_on, "2026-09-12")
  assert.ok(receipt.installment_id)
  const matched = await db.prepare<{ occurrence_date: string }>(
    `SELECT occurrence_date FROM mca_merchant_installments WHERE id=?`,
  ).get(receipt.installment_id)
  assert.equal(matched?.occurrence_date, "2026-09-12")

  const alerts = await runMissedPaymentAlerts(actor, "2026-09-13T06:00:00.000Z")
  assert.ok(alerts.created >= 1)
  const byDate = await db.prepare<{ occurrence_date: string; count: number }>(
    `SELECT occurrence_date, count(*)::int AS count FROM mca_servicing_alerts
     WHERE advance_id=? AND kind='missed_payment' AND occurrence_date IN ('2026-09-12','2026-09-13')
     GROUP BY occurrence_date`,
  ).all(ids.advance)
  const counts = Object.fromEntries(byDate.map((row) => [row.occurrence_date, row.count]))
  assert.equal(counts["2026-09-12"], undefined)
  assert.equal(counts["2026-09-13"], 1)

  const detail = await getDealBookRow(actor, ids.advance, { asOf: "2026-09-13T02:00:00.000Z" })
  assert.equal(detail.installments.find((item) => item.occurrenceDate === "2026-09-12")?.received, true)
  assert.equal(detail.installments.find((item) => item.occurrenceDate === "2026-09-13")?.received, false)

  await db.prepare("UPDATE workspaces SET timezone='UTC' WHERE id=?").run(ids.workspace)
  const utcReceipt = await recordReceipt(actor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-13T02:00:00.000Z", origin: "manual", idempotencyKey: "tz-receipt-utc",
  })
  assert.equal(utcReceipt.received_on, "2026-09-13")
  assert.ok(utcReceipt.installment_id)
  const utcMatched = await db.prepare<{ occurrence_date: string }>(
    `SELECT occurrence_date FROM mca_merchant_installments WHERE id=?`,
  ).get(utcReceipt.installment_id)
  assert.equal(utcMatched?.occurrence_date, "2026-09-13")
  await db.prepare("UPDATE workspaces SET timezone='America/New_York' WHERE id=?").run(ids.workspace)
})

async function resetAdvanceRemittance() {
  const db = getDatabase()
  await db.prepare("DELETE FROM mca_servicing_alerts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_receipts WHERE advance_id=?").run(ids.advance)
  await db.prepare("DELETE FROM mca_merchant_installments WHERE advance_id=?").run(ids.advance)
}

test("$1 on a $1,000 due date does not clear missed alerts or book received", async () => {
  await resetAdvanceRemittance()
  assert.equal(await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08",
    paymentCount: 3, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 100_000, paybackCents: 300_000, createdAt: now,
  }), 3)
  await recordReceipt(actor, ids.advance, {
    amountCents: 100, receivedAt: "2026-09-09", origin: "manual", idempotencyKey: "partial-dollar",
  })
  const alerts = await runMissedPaymentAlerts(actor, "2026-09-11T12:00:00.000Z")
  assert.equal(alerts.created, 3)
  const byDate = await getDatabase().prepare<{ occurrence_date: string; count: number }>(
    `SELECT occurrence_date, count(*)::int AS count FROM mca_servicing_alerts
     WHERE advance_id=? AND kind='missed_payment' GROUP BY occurrence_date`,
  ).all(ids.advance)
  const counts = Object.fromEntries(byDate.map((row) => [row.occurrence_date, row.count]))
  assert.equal(counts["2026-09-09"], 1)
  const detail = await getDealBookRow(actor, ids.advance, { asOf: "2026-09-11T12:00:00.000Z" })
  assert.equal(detail.installments.find((item) => item.occurrenceDate === "2026-09-09")?.received, false)
  assert.equal(detail.missedCount >= 1, true)
})

test("$0 last installment is never missed", async () => {
  await resetAdvanceRemittance()
  assert.equal(await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08",
    paymentCount: 10, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 1000, paybackCents: 9000, createdAt: now,
  }), 10)
  const last = await getDatabase().prepare<{ id: string; occurrence_date: string; amount_cents: number }>(
    `SELECT id, occurrence_date, amount_cents FROM mca_merchant_installments WHERE advance_id=? ORDER BY sequence DESC LIMIT 1`,
  ).get(ids.advance)
  assert.equal(last?.amount_cents, 0)
  const alerts = await runMissedPaymentAlerts(actor, `${last!.occurrence_date}T12:00:00.000Z`)
  assert.ok(alerts.created >= 1)
  const lastAlert = await getDatabase().prepare<{ count: number }>(
    `SELECT count(*)::int AS count FROM mca_servicing_alerts WHERE installment_id=? AND kind='missed_payment'`,
  ).get(last!.id)
  assert.equal(lastAlert?.count, 0)
  const detail = await getDealBookRow(actor, ids.advance, { asOf: `${last!.occurrence_date}T12:00:00.000Z` })
  assert.equal(detail.installments.find((item) => item.id === last!.id)?.received, true)
})

test("receipt idempotency key plus a different amount is a conflict", async () => {
  await resetAdvanceRemittance()
  assert.equal(await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08",
    paymentCount: 2, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 100_000, paybackCents: 200_000, createdAt: now,
  }), 2)
  const first = await recordReceipt(actor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-09", origin: "manual", idempotencyKey: "receipt-amount-key",
  })
  const replay = await recordReceipt(actor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-09", origin: "manual", idempotencyKey: "receipt-amount-key",
  })
  assert.equal(replay.id, first.id)
  await assert.rejects(
    () => recordReceipt(actor, ids.advance, {
      amountCents: 100, receivedAt: "2026-09-09", origin: "manual", idempotencyKey: "receipt-amount-key",
    }),
    (error: { code?: string; status?: number }) => error.code === "idempotency_conflict" && error.status === 409,
  )
})

test("managers can void receipts, replay is ok, and reps are forbidden", async () => {
  await resetAdvanceRemittance()
  assert.equal(await persistInstallments(getDatabase(), {
    workspaceId: ids.workspace, advanceId: ids.advance, fundedAt: "2026-09-08",
    paymentCount: 2, paymentFrequency: "daily", calendarConvention: "calendar_days",
    periodicPaymentCents: 100_000, paybackCents: 200_000, createdAt: now,
  }), 2)
  const receipt = await recordReceipt(managerActor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-09", origin: "manual", idempotencyKey: "void-target",
  })
  const voided = await voidReceipt(managerActor, ids.advance, receipt.id, {
    reason: "NSF return", idempotencyKey: "void-nsf-1",
  })
  assert.equal(voided.status, "void")
  const replay = await voidReceipt(managerActor, ids.advance, receipt.id, {
    reason: "NSF return", idempotencyKey: "void-nsf-1",
  })
  assert.equal(replay.id, receipt.id)
  assert.equal(replay.status, "void")
  await assert.rejects(
    () => voidReceipt(repActor, ids.advance, receipt.id, { reason: "rep attempt", idempotencyKey: "void-rep" }),
    (error: { code?: string; status?: number }) => error.code === "permission_denied" && error.status === 403,
  )
  const alerts = await runMissedPaymentAlerts(actor, "2026-09-10T12:00:00.000Z")
  assert.ok(alerts.created >= 1)
  const detail = await getDealBookRow(actor, ids.advance, { asOf: "2026-09-10T12:00:00.000Z" })
  assert.equal(detail.receipts.find((item) => item.id === receipt.id)?.status, "void")
  assert.equal(detail.installments.find((item) => item.occurrenceDate === "2026-09-09")?.received, false)

  const { PATCH } = await import("../src/app/api/mca/deals/book/[advanceId]/receipts/[receiptId]/route")
  const replacement = await recordReceipt(actor, ids.advance, {
    amountCents: 100_000, receivedAt: "2026-09-10", origin: "manual", idempotencyKey: "void-http-target",
  })
  const adminRequest = new Request(`http://localhost/api/mca/deals/book/${ids.advance}/receipts/${replacement.id}`, {
    method: "PATCH",
    headers: { cookie: "mca_session=book-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "void", reason: "Bank return", idempotencyKey: "void-http-1" }),
  })
  const adminResponse = await PATCH(adminRequest, { params: Promise.resolve({ advanceId: ids.advance, receiptId: replacement.id }) })
  assert.equal(adminResponse.status, 200)
  const body = await adminResponse.json() as { status: string; id: string }
  assert.equal(body.status, "void")
  assert.equal(body.id, replacement.id)
  const replayResponse = await PATCH(new Request(`http://localhost/api/mca/deals/book/${ids.advance}/receipts/${replacement.id}`, {
    method: "PATCH",
    headers: { cookie: "mca_session=book-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "void", reason: "Bank return", idempotencyKey: "void-http-1" }),
  }), { params: Promise.resolve({ advanceId: ids.advance, receiptId: replacement.id }) })
  assert.equal(replayResponse.status, 200)
  const repResponse = await PATCH(new Request(`http://localhost/api/mca/deals/book/${ids.advance}/receipts/${replacement.id}`, {
    method: "PATCH",
    headers: { cookie: "mca_session=book-rep-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "void", reason: "rep http", idempotencyKey: "void-http-rep" }),
  }), { params: Promise.resolve({ advanceId: ids.advance, receiptId: replacement.id }) })
  assert.equal(repResponse.status, 403)
  const managerResponse = await PATCH(new Request(`http://localhost/api/mca/deals/book/${ids.advance}/receipts/${replacement.id}`, {
    method: "PATCH",
    headers: { cookie: "mca_session=book-manager-token", "content-type": "application/json" },
    body: JSON.stringify({ status: "void", reason: "Bank return", idempotencyKey: "void-http-1" }),
  }), { params: Promise.resolve({ advanceId: ids.advance, receiptId: replacement.id }) })
  assert.equal(managerResponse.status, 200)
})

test("pending shared profiles are masked in advance list/detail and deal book list/detail", async () => {
  const { listAdvanceRows, findAdvanceRow } = await import("../src/lib/mca/advances/repository")
  for (const read of [
    () => listAdvanceRows(ids.workspace),
    () => findAdvanceRow(ids.workspace, ids.advance),
    () => listDealBook(actor),
    () => getDealBookRow(actor, ids.advance),
  ]) {
    await assertPendingProfileHidden(ids.managerMember, read)
    await assertPendingProfileHidden(ids.member, read)
  }
})

test("pending shared originators are masked in submission dashboards and the all-deals/owners export", async () => {
  const { listVisibleSubmissionRows } = await import("../src/lib/mca/submissions/dashboard")
  const { captureExportSnapshot } = await import("../src/lib/mca/exports/query")
  await getDatabase().prepare("INSERT INTO deal_submissions (id,workspace_id,deal_id,funder_name,status) VALUES ('profile-submission',?,?,'Synthetic funder','sent')").run(ids.workspace, ids.deal)
  await assertPendingProfileHidden(ids.member, () => listVisibleSubmissionRows(actor))
  await assertPendingProfileHidden(ids.member, () => captureExportSnapshot(actor, "all_deals_owners", {}, now))
})
