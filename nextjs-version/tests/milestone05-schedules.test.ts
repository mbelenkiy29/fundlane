import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { saveSplitTemplate } from "../src/lib/mca/accounting/service"
import {
  amendDistributionSchedule,
  cancelDistributionSchedule,
  createReverseConsolidation,
  exceptOccurrence,
  listReverseConsolidations,
  markInstallmentPaid,
  pauseDistributionSchedule,
  runDistributionSchedules,
  weeklyOccurrenceDates,
} from "../src/lib/mca/accounting/schedules"
import { GET as getSchedules } from "../src/app/api/mca/accounting/schedules/route"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { SplitTemplateVersion } from "../src/lib/mca/accounting/contracts"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const ids = {
  workspace: "ws-schedules",
  user: "user-schedules-a",
  member: "member-schedules-a",
  userB: "user-schedules-b",
  memberB: "member-schedules-b",
  deal: "deal-schedules",
  offer: "offer-schedules",
  revision: "revision-schedules",
  event: "event-schedules",
  advance: "advance-schedules",
  offer2: "offer-schedules-2",
  revision2: "revision-schedules-2",
  event2: "event-schedules-2",
  advance2: "advance-schedules-2",
}
const now = "2026-01-01T00:00:00.000Z"
const actor: DealActor = {
  workspaceId: ids.workspace, userId: ids.user, membershipId: ids.member, role: "admin",
  managedMembershipIds: [], activeMembershipIds: [ids.member, ids.memberB], source: "user", correlationId: "corr-schedules",
}
const FROZEN_DATES = ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]
const sessionRequest = () => new Request("http://localhost/api/mca/accounting/schedules", { headers: { cookie: "mca_session=schedules-token" } })

function resultRows<T>(result: { rows: unknown }): T[] { return result.rows as T[] }

let template: SplitTemplateVersion

async function seed() {
  const db = getDatabase()
  await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,'America/New_York',5,?,?,?,?,?)`).run(ids.workspace, "Schedules Test",
    JSON.stringify({ reports: true, payments: true, integrations: true }),
    JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }),
    JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true }),
    now, now)
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'APP-SCHED-A',?,?),(?,?,?,'APP-SCHED-B',?,?)`).run(
    ids.user, "sched-a@example.test", "Alice Originator", now, now,
    ids.userB, "sched-b@example.test", "Bob Closer", now, now,
  )
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?)`).run(
    ids.member, ids.workspace, ids.user, now, now, ids.memberB, ids.workspace, ids.userB, now, now,
  )
  await db.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES ('session-schedules',?,?,?,'2027-01-01T00:00:00.000Z',?,?)`).run(ids.user, ids.member, hashOpaqueToken("schedules-token"), now, now)
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES (?,?,?,'Harbor Bakery','funded',1,'submission_ready','[]','{}',1,?,?)`).run(ids.deal, ids.workspace, "MCA-SCHED", now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id)
    VALUES ('assignment-sched-a',?,?,?,'originator',1,?,?)`).run(ids.workspace, ids.deal, ids.member, now, ids.user)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,'Northstar Capital','manual',?,?,?)`).run(ids.offer, ids.workspace, ids.deal, ids.revision, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES (?,?,?,1,'funded',4000000,1250000,10,500000,'monthly',320000,10000,?,?,?)`).run(ids.revision, ids.workspace, ids.offer, now, new Date(Date.parse(now) + 14 * 86_400_000).toISOString(), now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at)
    VALUES (?,?,?,'Second Capital','manual',?,?,?)`).run(ids.offer2, ids.workspace, ids.deal, ids.revision2, now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES (?,?,?,1,'funded',2000000,1200000,10,240000,'monthly',100000,0,?,?,?)`).run(ids.revision2, ids.workspace, ids.offer2, now, new Date(Date.parse(now) + 14 * 86_400_000).toISOString(), now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,4000000,5000000,500000,10,'monthly','calendar_days',320000,10000,'live','{}','active',1,?,?)`)
    .run(ids.advance, ids.workspace, ids.event, ids.deal, ids.offer, ids.revision, now, now, now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,2000000,2400000,240000,10,'monthly','calendar_days',100000,0,'live','{}','active',1,?,?)`)
    .run(ids.advance2, ids.workspace, ids.event2, ids.deal, ids.offer2, ids.revision2, now, now, now)
}

function frozenInput(idempotencyKey: string) {
  return {
    dealId: ids.deal,
    referencedAdvanceIds: [ids.advance, ids.advance2],
    startDate: "2026-10-05",
    installmentCount: 4,
    installmentCents: 100_000,
    splitTemplateId: template.templateId,
    splitTemplateVersion: template.version,
    idempotencyKey,
  }
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone05_schedules")
  Object.assign(process.env, fixture.env())
  await seed()
  template = await saveSplitTemplate({ ...actor, correlationId: "corr-split" }, {
    name: "Sixty forty",
    allocations: [
      { recipientMembershipId: ids.member, percentageBasisPoints: 6000 },
      { recipientMembershipId: ids.memberB, percentageBasisPoints: 4000 },
    ],
  })
})
after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
})

test("MIC-111 frozen example materializes eight Monday installment rows at 60/40", async () => {
  assert.deepEqual(weeklyOccurrenceDates("2026-10-05", 4), FROZEN_DATES)
  assert.equal(new Date(Date.UTC(2026, 9, 5, 12, 0, 0)).getUTCDay(), 1)
  const created = await createReverseConsolidation({ ...actor, correlationId: "corr-create" }, frozenInput("rc-frozen-1"))
  assert.equal(created.created, true)
  assert.equal(created.schedule.status, "active")
  assert.equal(created.schedule.version, 1)
  assert.equal(created.schedule.startDate, "2026-10-05")
  assert.equal(created.schedule.installmentCents, 100_000)
  const first = await runDistributionSchedules({ ...actor, correlationId: "corr-run-1" }, { nowIso: "2026-10-26T12:00:00.000Z", scheduleId: created.schedule.id })
  assert.equal(first.inserted, 8)
  const rows = resultRows<{ occurrence_date: string; recipient_membership_id: string; amount_cents: number; status: string }>(
    await fixture.query(`SELECT occurrence_date, recipient_membership_id, amount_cents, status
      FROM mca_scheduled_installments WHERE schedule_id=$1 ORDER BY occurrence_date, amount_cents DESC`, [created.schedule.id]),
  )
  assert.equal(rows.length, 8)
  assert.deepEqual([...new Set(rows.map((row) => row.occurrence_date))], FROZEN_DATES)
  assert.ok(rows.every((row) => row.status === "expected"))
  for (const date of FROZEN_DATES) {
    const day = rows.filter((row) => row.occurrence_date === date)
    assert.deepEqual(day.map((row) => row.amount_cents), [60_000, 40_000])
    assert.equal(day.reduce((sum, row) => sum + row.amount_cents, 0), 100_000)
  }
  assert.equal(rows.reduce((sum, row) => sum + row.amount_cents, 0), 400_000)
  const replayCreate = await createReverseConsolidation({ ...actor, correlationId: "corr-create-replay" }, frozenInput("rc-frozen-1"))
  assert.equal(replayCreate.created, false)
  assert.equal(replayCreate.consolidation.id, created.consolidation.id)
})

test("MIC-111 second scheduler run inserts zero extra rows", async () => {
  const listed = await listReverseConsolidations(actor)
  const schedule = listed.schedules.find((item) => item.startDate === "2026-10-05" && item.version === 1) ?? listed.schedules[0]
  const before = resultRows<{ count: number }>(await fixture.query(
    `SELECT count(*)::int count FROM mca_scheduled_installments WHERE schedule_id=$1`, [schedule.id],
  ))[0].count
  const second = await runDistributionSchedules({ ...actor, correlationId: "corr-run-2" }, { nowIso: "2026-10-26T12:00:00.000Z", scheduleId: schedule.id })
  assert.equal(second.inserted, 0)
  assert.equal(second.skipped, 8)
  const after = resultRows<{ count: number }>(await fixture.query(
    `SELECT count(*)::int count FROM mca_scheduled_installments WHERE schedule_id=$1`, [schedule.id],
  ))[0].count
  assert.equal(after, before)
  assert.equal(after, 8)
})

test("MIC-111 paying first date then amending leaves paid rows and regenerates unpaid future", async () => {
  const listed = await listReverseConsolidations(actor)
  const schedule = listed.schedules[0]
  const firstDate = listed.installments.filter((item) => item.scheduleId === schedule.id && item.occurrenceDate === "2026-10-05")
  assert.equal(firstDate.length, 2)
  const paidAt = "2026-10-05T12:00:00.000Z"
  const paid = []
  for (const row of firstDate) {
    paid.push(await markInstallmentPaid({ ...actor, correlationId: `corr-pay-${row.id}` }, schedule.id, { installmentId: row.id, paidAt }))
  }
  assert.ok(paid.every((row) => row.status === "paid" && row.paidAt === paidAt && row.amountCents === (row.recipientMembershipId === ids.member ? 60_000 : 40_000)))
  const replayPay = await markInstallmentPaid({ ...actor, correlationId: "corr-pay-replay" }, schedule.id, {
    installmentId: firstDate[0].id, paidAt: "2026-11-01T12:00:00.000Z",
  })
  assert.equal(replayPay.paidAt, paidAt)
  assert.equal(replayPay.status, "paid")

  const amended = await amendDistributionSchedule({ ...actor, correlationId: "corr-amend" }, schedule.id, {
    startDate: "2026-10-12",
    installmentCount: 3,
    installmentCents: 100_000,
    splitTemplateId: template.templateId,
    splitTemplateVersion: template.version,
    reason: "Remaining unpaid Mondays",
  })
  assert.equal(amended.version, 2)
  assert.equal(amended.startDate, "2026-10-12")
  assert.equal(amended.installmentCount, 3)

  const rows = resultRows<{
    id: string; schedule_version: number; occurrence_date: string; recipient_membership_id: string
    amount_cents: number; status: string; paid_at: string | null
  }>(await fixture.query(
    `SELECT id, schedule_version, occurrence_date, recipient_membership_id, amount_cents, status, paid_at
     FROM mca_scheduled_installments WHERE schedule_id=$1 ORDER BY schedule_version, occurrence_date, amount_cents DESC`,
    [schedule.id],
  ))
  const paidRows = rows.filter((row) => row.status === "paid")
  assert.equal(paidRows.length, 2)
  assert.ok(paidRows.every((row) => row.schedule_version === 1 && row.occurrence_date === "2026-10-05" && row.paid_at === paidAt))
  assert.deepEqual(paidRows.map((row) => row.amount_cents), [60_000, 40_000])
  const voided = rows.filter((row) => row.status === "void")
  assert.equal(voided.length, 6)
  assert.ok(voided.every((row) => row.schedule_version === 1 && row.occurrence_date !== "2026-10-05"))
  const regenerated = rows.filter((row) => row.schedule_version === 2)
  assert.equal(regenerated.length, 6)
  assert.ok(regenerated.every((row) => row.status === "expected"))
  assert.deepEqual([...new Set(regenerated.map((row) => row.occurrence_date))], ["2026-10-12", "2026-10-19", "2026-10-26"])
  assert.equal(rows.filter((row) => row.status === "expected").length, 6)
})

test("MIC-111 cancel voids unpaid installments and leaves paid rows immutable", async () => {
  const listed = await listReverseConsolidations(actor)
  const schedule = listed.schedules[0]
  const beforePaid = resultRows<{ id: string; paid_at: string; amount_cents: number }>(await fixture.query(
    `SELECT id, paid_at, amount_cents FROM mca_scheduled_installments WHERE schedule_id=$1 AND status='paid' ORDER BY id`,
    [schedule.id],
  ))
  assert.equal(beforePaid.length, 2)
  const cancelled = await cancelDistributionSchedule({ ...actor, correlationId: "corr-cancel" }, schedule.id)
  assert.equal(cancelled.status, "cancelled")
  const rows = resultRows<{ status: string; paid_at: string | null; id: string; amount_cents: number }>(await fixture.query(
    `SELECT id, status, paid_at, amount_cents FROM mca_scheduled_installments WHERE schedule_id=$1 ORDER BY id`, [schedule.id],
  ))
  assert.equal(rows.filter((row) => row.status === "expected").length, 0)
  const paid = rows.filter((row) => row.status === "paid")
  assert.equal(paid.length, 2)
  assert.deepEqual(paid.map((row) => ({ id: row.id, paid_at: row.paid_at, amount_cents: row.amount_cents })), beforePaid)
  assert.ok(rows.filter((row) => row.status === "void").length >= 6)
  const rerun = await runDistributionSchedules({ ...actor, correlationId: "corr-run-cancelled" }, { scheduleId: schedule.id })
  assert.equal(rerun.inserted, 0)
})

test("MIC-111 pause makes run a no-op and exception voids one unpaid occurrence", async () => {
  const created = await createReverseConsolidation({ ...actor, correlationId: "corr-pause-create" }, frozenInput("rc-pause-1"))
  await runDistributionSchedules({ ...actor, correlationId: "corr-pause-run-1" }, { scheduleId: created.schedule.id })
  const paused = await pauseDistributionSchedule({ ...actor, correlationId: "corr-pause" }, created.schedule.id)
  assert.equal(paused.status, "paused")
  const pausedRun = await runDistributionSchedules({ ...actor, correlationId: "corr-pause-run-2" }, { scheduleId: created.schedule.id })
  assert.equal(pausedRun.inserted, 0)
  assert.equal(resultRows<{ count: number }>(await fixture.query(
    `SELECT count(*)::int count FROM mca_scheduled_installments WHERE schedule_id=$1`, [created.schedule.id],
  ))[0].count, 8)

  const exceptedSchedule = await createReverseConsolidation({ ...actor, correlationId: "corr-except-create" }, frozenInput("rc-except-1"))
  await runDistributionSchedules({ ...actor, correlationId: "corr-except-run" }, { scheduleId: exceptedSchedule.schedule.id })
  await exceptOccurrence({ ...actor, correlationId: "corr-except" }, exceptedSchedule.schedule.id, { occurrenceDate: "2026-10-19" })
  const exceptRows = resultRows<{ status: string; occurrence_date: string }>(await fixture.query(
    `SELECT status, occurrence_date FROM mca_scheduled_installments WHERE schedule_id=$1`, [exceptedSchedule.schedule.id],
  ))
  assert.equal(exceptRows.filter((row) => row.occurrence_date === "2026-10-19" && row.status === "void").length, 2)
  assert.equal(exceptRows.filter((row) => row.status === "expected").length, 6)
})

test("MIC-111 rejects non-Monday starts, reversed advances, and conflicting retries", async () => {
  await assert.rejects(
    () => createReverseConsolidation({ ...actor, correlationId: "corr-tuesday" }, { ...frozenInput("rc-tuesday"), startDate: "2026-10-06" }),
    /Monday/,
  )
  await getDatabase().prepare(`UPDATE mca_advances SET status='reversed', reversed_at=?, updated_at=? WHERE workspace_id=? AND id=?`)
    .run(now, now, ids.workspace, ids.advance2)
  await assert.rejects(
    () => createReverseConsolidation({ ...actor, correlationId: "corr-reversed" }, frozenInput("rc-reversed")),
    /reversed advance/,
  )
  await getDatabase().prepare(`UPDATE mca_advances SET status='active', reversed_at=NULL, updated_at=? WHERE workspace_id=? AND id=?`)
    .run(now, ids.workspace, ids.advance2)
  await assert.rejects(
    () => createReverseConsolidation({ ...actor, correlationId: "corr-conflict" }, { ...frozenInput("rc-frozen-1"), installmentCount: 3 }),
    /already identifies a different reverse consolidation/,
  )
})

test("MIC-111 direct GET enforces the same payment permissions as the Payments UI", async () => {
  const hidden = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: false, viewCompanyFinancials: true })
  await getDatabase().prepare(`UPDATE workspaces SET action_visibility=? WHERE id=?`).run(hidden, ids.workspace)
  assert.equal((await getSchedules(sessionRequest())).status, 403)
  const visible = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const disabledFeature = JSON.stringify({ reports: true, payments: false, integrations: true })
  await getDatabase().prepare(`UPDATE workspaces SET action_visibility=?,feature_flags=? WHERE id=?`).run(visible, disabledFeature, ids.workspace)
  assert.equal((await getSchedules(sessionRequest())).status, 403)
  const enabledFeature = JSON.stringify({ reports: true, payments: true, integrations: true })
  const hiddenPage = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: false, workspace: true, integrations: true })
  await getDatabase().prepare(`UPDATE workspaces SET feature_flags=?,page_visibility=? WHERE id=?`).run(enabledFeature, hiddenPage, ids.workspace)
  assert.equal((await getSchedules(sessionRequest())).status, 403)
  const visiblePage = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  await getDatabase().prepare(`UPDATE workspaces SET page_visibility=?,action_visibility=? WHERE id=?`).run(visiblePage, visible, ids.workspace)
  const allowed = await getSchedules(sessionRequest())
  assert.equal(allowed.status, 200)
  const body = await allowed.json() as { schedules: unknown[]; installments: unknown[] }
  assert.ok(Array.isArray(body.schedules))
  assert.ok(Array.isArray(body.installments))
})
