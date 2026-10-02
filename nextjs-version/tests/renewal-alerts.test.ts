import "./helpers/business-auth"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { saveRenewalPolicy } from "../src/lib/mca/renewals/service"
import { runScheduledCommsJobs } from "../src/lib/mca/comms/scheduler"
import { notificationInput } from "../src/lib/mca/notifications/service"
import type { NotificationRow } from "../src/lib/mca/notifications/contracts"
import { runScheduledNotifications, setNotificationTransportForTests } from "../src/lib/mca/notifications/worker"
import type { DealActor } from "../src/lib/mca/deals/schema"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const now = "2026-01-01T00:00:00.000Z"
const early = "2026-01-15T00:00:00.000Z"
const late = "2026-06-02T00:00:00.000Z"
const actor: DealActor = { workspaceId: "ws-renew", userId: "u-renew", membershipId: "m-renew", role: "admin",
  managedMembershipIds: [], activeMembershipIds: ["m-renew"], source: "user", correlationId: "renew-alerts" }

async function alerts() {
  return getDatabase().prepare<{ event_key: string; audience: string; channel: string; recipient_user_id: string }>(
    `SELECT event_key,audience,channel,recipient_user_id FROM mca_notifications WHERE kind='renewal'`).all()
}

before(async () => {
  fixture = await createPostgresTestDatabase("renewal_alerts"); Object.assign(process.env, fixture.env())
  const db = getDatabase()
  for (const ws of ["ws-renew", "ws-nopolicy"]) {
    await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?,?,'UTC',5,'{"integrations":true}','{"deals":true,"integrations":true}','{"createDeal":true}',?,?)`).run(ws, ws, now, now)
  }
  await db.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES ('u-renew','broker@example.test','Broker','APP-R',?,?)`).run(now, now)
  await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ('m-renew','ws-renew','u-renew','admin','active',?,?)`).run(now, now)
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES ('d-renew','ws-renew','MCA-R','Harbor Bakery','funded',1,'submission_ready','[]','{}',1,?,?)`).run(now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id)
    VALUES ('a-renew','ws-renew','d-renew','m-renew','originator',1,?,'u-renew')`).run(now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at) VALUES ('o-renew','ws-renew','d-renew','Northstar Capital','manual','r-renew',?,?)`).run(now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES ('r-renew','ws-renew','o-renew',1,'funded',4000000,1250000,10,500000,'monthly',0,0,?,?,?)`).run(now, "2026-01-15T00:00:00.000Z", now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES ('adv-renew','ws-renew','ev-renew','d-renew','o-renew','r-renew',?,4000000,5000000,500000,10,'monthly','calendar_days',0,0,'live','{}','active',1,?,?)`).run(now, now, now)
  await saveRenewalPolicy(actor, { paidInThresholdBasisPoints: 5000, minimumDaysSinceFunding: 0 })
})
after(async () => { delete process.env.MCA_RENEWAL_ALERTS_ENABLED; await closeDatabaseForTests(); await fixture.close() })

test("flag off: the tick enqueues nothing", async () => {
  delete process.env.MCA_RENEWAL_ALERTS_ENABLED
  await runScheduledCommsJobs(late)
  assert.equal((await alerts()).length, 0)
  assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM mca_renewal_actions").get())!.n, 0)
})

test("flag on: below threshold nothing, crossing threshold yields one broker alert, rerun adds none; no-policy company is skipped", async () => {
  process.env.MCA_RENEWAL_ALERTS_ENABLED = "true"
  await runScheduledCommsJobs(early)
  assert.equal((await alerts()).length, 0)
  const tick = await runScheduledCommsJobs(late)
  assert.deepEqual(tick.renewalAlerts, { companies: 1, enqueued: 1, failed: 0 }) // ws-nopolicy is never selected
  const first = await alerts()
  assert.equal(first.length, 1)
  assert.deepEqual([first[0].audience, first[0].channel, first[0].recipient_user_id], ["broker", "email", "u-renew"])
  assert.equal(first[0].event_key, "renewal:v1:adv-renew")
  await runScheduledCommsJobs("2026-06-03T00:00:00.000Z")
  assert.equal((await alerts()).length, 1)
})

test("editing the action after the first alert causes no failure and no duplicate", async () => {
  await getDatabase().prepare("UPDATE mca_renewal_actions SET message_subject='Edited subject', message_body='Edited body' WHERE source_advance_id='adv-renew'").run()
  const tick = await runScheduledCommsJobs("2026-06-04T00:00:00.000Z")
  assert.deepEqual(tick.renewalAlerts, { companies: 1, enqueued: 0, failed: 0 })
  assert.equal((await alerts()).length, 1)
})

test("an over-long multiline action text is normalized to the notification limits", async () => {
  const db = getDatabase(), name = `Long\nName ${"x".repeat(3000)}`
  await db.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at)
    VALUES ('d-long','ws-renew','MCA-L',?,'funded',1,'submission_ready','[]','{}',1,?,?)`).run(name, now, now)
  await db.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id) VALUES ('a-long','ws-renew','d-long','m-renew','originator',1,?,'u-renew')`).run(now)
  await db.prepare(`INSERT INTO mca_offers (id,workspace_id,deal_id,funder_name,source,current_revision_id,created_at,updated_at) VALUES ('o-long','ws-renew','d-long','Northstar Capital','manual','r-long',?,?)`).run(now, now)
  await db.prepare(`INSERT INTO mca_offer_revisions (id,workspace_id,offer_id,revision_number,state,amount_cents,factor_rate_millionths,term_months,payment_amount_cents,payment_frequency,commission_cents,fee_cents,effective_at,expires_at,created_at)
    VALUES ('r-long','ws-renew','o-long',1,'funded',4000000,1250000,10,500000,'monthly',0,0,?,?,?)`).run(now, "2026-01-15T00:00:00.000Z", now)
  await db.prepare(`INSERT INTO mca_advances (id,workspace_id,funding_event_id,deal_id,offer_id,offer_revision_id,funded_at,principal_cents,payback_cents,periodic_payment_cents,payment_count,payment_frequency,calendar_convention,commission_cents,fee_cents,source,calculation_snapshot_json,status,status_version,created_at,updated_at)
    VALUES ('adv-long','ws-renew','ev-long','d-long','o-long','r-long',?,4000000,5000000,500000,10,'monthly','calendar_days',0,0,'live','{}','active',1,?,?)`).run(now, now, now)
  const tick = await runScheduledCommsJobs("2026-06-05T00:00:00.000Z")
  assert.deepEqual(tick.renewalAlerts, { companies: 1, enqueued: 1, failed: 0 })
  const row = (await db.prepare<NotificationRow>("SELECT * FROM mca_notifications WHERE event_key='renewal:v1:adv-long'").get())!
  const { payload } = notificationInput(row)
  assert.ok(payload!.title.length <= 200 && !/[\r\n]/.test(payload!.title)); assert.ok(payload!.message.length <= 2000)
  assert.equal((await alerts()).length, 2)
})

test("a queued alert is suppressed, not sent, once its action is no longer eligible", async () => {
  const db = getDatabase(); let sent = 0
  setNotificationTransportForTests(async () => { sent++; return { state: "accepted" } })
  process.env.MCA_NOTIFICATION_RUNTIME = "enabled"
  try {
    // adv-renew: action dismissed; adv-long: policy version moved on.
    await db.prepare("UPDATE mca_renewal_actions SET state='dismissed' WHERE source_advance_id='adv-renew'").run()
    await saveRenewalPolicy(actor, { paidInThresholdBasisPoints: 5000, minimumDaysSinceFunding: 1 })
    await runScheduledNotifications(new Date().toISOString(), 25, { deadlineMs: Date.now() + 230_000 })
    const rows = await db.prepare<{ state: string }>("SELECT state FROM mca_notifications WHERE kind='renewal'").all()
    assert.equal(rows.length, 2); assert.ok(rows.every((r) => r.state === "suppressed")); assert.equal(sent, 0)
  } finally { setNotificationTransportForTests(); delete process.env.MCA_NOTIFICATION_RUNTIME }
})
