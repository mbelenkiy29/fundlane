import test, { before, after, beforeEach, type TestContext } from "node:test"
import assert from "node:assert/strict"
import Stripe from "stripe"
import { authDatabase, liveIdentity, provider, resetAuthProvider } from "./helpers/onboarding-auth"
import { getDatabase, newId, nowIso } from "../src/lib/mca/db"
import { startEnrollmentCheckout } from "../src/lib/mca/onboarding/checkout"
import { runEnrollmentMaintenance } from "../src/lib/mca/onboarding/maintenance"
import { captureEnrollmentStripeEvent, reconcileEnrollment } from "../src/lib/mca/onboarding/reconcile"
import { verifyStripeBillingEvent } from "../src/lib/mca/billing"
import { claimEnrollment } from "../src/lib/mca/onboarding/claim"
import { findEnrollment } from "../src/lib/mca/onboarding/store"
import { runOnboardingEmails } from "../src/lib/mca/onboarding/email-worker"
import { getBusinessBasics, saveBusinessBasics } from "../src/lib/mca/onboarding/business-profile"
import { getCompanyAccess, evaluateCompanyAccess, assertCompanyOperational } from "../src/lib/mca/company-access"
import { requireSuperAdmin } from "../src/lib/mca/platform-auth"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"
import { encryptSensitive } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { enrollmentTestEnv, stripeFixture, resumeSecret } from "./helpers/onboarding-billing"

const instant = "2030-01-01T12:00:00.000Z", clock = Date.parse(instant)
let close: () => Promise<void>
before(async () => { close = await authDatabase("onboarding_acceptance") })
after(async () => { await close?.() })
beforeEach(async t => {
  (t as TestContext).mock.timers.enable({ apis: ["Date"], now: clock })
  resetAuthProvider(); Object.assign(process.env, enrollmentTestEnv)
  delete process.env.MCA_ONBOARDING_EMAIL_ENABLED
  await getDatabase().execute("TRUNCATE mca_enrollments CASCADE")
})
async function started(f = stripeFixture()) {
  const checkout = await startEnrollmentCheckout({ resumeSecret: resumeSecret() }, f.client)
  return { ...f, id: checkout.enrollmentId }
}
async function due(id: string, stamp = instant) {
  await getDatabase().execute("UPDATE mca_enrollments SET next_reconcile_at=?,revision=revision+1 WHERE id=?", [stamp, id])
}
async function actor(workspaceId: string, sessionId: string): Promise<DealActor> {
  const member = (await getDatabase().queryOne<{ id: string; user_id: string }>("SELECT id,user_id FROM memberships WHERE workspace_id=? AND status='active'", [workspaceId]))!
  return { workspaceId, membershipId: member.id, userId: member.user_id, role: "admin", source: "user", sessionId, managedMembershipIds: [], activeMembershipIds: [member.id], correlationId: "integrated-onboarding-acceptance" }
}

test("closed-browser signed webhook repairs under creation rollback, creates two intents and admits CRM despite failed mail and missing profile", async t => {
  const f = await started(), session = f.complete()
  const event = { id: `evt_${newId()}`, object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(clock / 1000), data: { object: session } }
  const body = JSON.stringify(event), signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: process.env.STRIPE_BILLING_WEBHOOK_SECRET!, timestamp: Math.floor(clock / 1000) })
  process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "false"
  await assert.rejects(startEnrollmentCheckout({ resumeSecret: resumeSecret() }, f.client), { code: "enrollment_creation_disabled" })
  const verified = verifyStripeBillingEvent(body, signature)
  assert.deepEqual(await captureEnrollmentStripeEvent(verified), { handled: true, enrollmentId: f.id })
  assert.equal((await findEnrollment(f.id))?.activatedAt, null)
  assert.deepEqual(await runEnrollmentMaintenance({ client: f.client, limit: 1 }), { checked: 1, repaired: 1, operatorRequired: 0, errors: [] })
  const activated = (await findEnrollment(f.id))!
  assert.equal(activated.workspaceId, null)
  assert.equal(activated.trialEndsAt, "2030-01-15T12:00:00.000Z")
  assert.deepEqual((await getDatabase().query<{ purpose: string; state: string }>("SELECT purpose,state FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY purpose", [f.id])).rows, [{ purpose: "business_information_requested", state: "queued" }, { purpose: "getting_started", state: "queued" }])
  Object.assign(process.env, { MCA_ONBOARDING_EMAIL_ENABLED: "true", MCA_USESEND_API_KEY: "synthetic", MCA_USESEND_FROM: "Fundlane <service@example.test>", MCA_APP_ORIGIN: "https://app.example.test" })
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Synthetic rejection" }, { status: 401 }))
  const delivery = await runOnboardingEmails({ limit: 2, deadlineMs: clock + 100000 })
  assert.equal(delivery.attempted, 2); assert.equal(delivery.accepted, 0)
  assert.deepEqual((await getDatabase().query<{ state: string }>("SELECT state FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY purpose", [f.id])).rows.map(row => row.state), ["failed", "failed"])
  const identity = await liveIdentity(session.customer_details!.email!), claimed = await claimEnrollment({ enrollmentId: f.id, identity }, f.client)
  assert.equal(claimed.destination, "/dashboard")
  await assertCompanyOperational(claimed.workspaceId)
  const businessActor = await actor(claimed.workspaceId, identity.sessionId)
  assert.deepEqual(await getBusinessBasics(businessActor), { legalName: "Synthetic company", einPresent: false, revision: 0, registered: false })
  assert.equal((await getDatabase().queryOne<{ name: string }>("SELECT name FROM workspaces WHERE id=?", [claimed.workspaceId]))?.name, "Synthetic company")
  assert.equal((await getDatabase().queryOne<{ n: number }>("SELECT count(*)::int n FROM company_basic_profiles WHERE workspace_id=?", [claimed.workspaceId]))?.n, 0)
  assert.equal((await getDatabase().queryOne<{ n: number }>("SELECT count(*)::int n FROM mca_onboarding_service_emails WHERE enrollment_id=?", [f.id]))?.n, 2)
  assert.equal(f.state.createCalls.length, 1)
})

test("maintenance selects due unclaimed work before its limit and skips future work, active leases and operator holds", async () => {
  const f = stripeFixture(), rows = await Promise.all(Array.from({ length: 5 }, () => started(f)))
  const [oldest, second, future, leased, held] = rows
  await due(oldest.id, "2030-01-01T11:00:00.000Z"); await due(second.id, "2030-01-01T11:30:00.000Z"); await due(future.id, "2030-01-01T12:01:00.000Z"); await due(leased.id, "2030-01-01T10:00:00.000Z"); await due(held.id, "2030-01-01T09:00:00.000Z")
  await getDatabase().execute("UPDATE mca_enrollments SET claim_token=?,lease_until=?,revision=revision+1 WHERE id=?", [newId(), "2030-01-01T12:05:00.000Z", leased.id])
  await getDatabase().execute("UPDATE mca_enrollments SET recovery_state='operator_required',revision=revision+1 WHERE id=?", [held.id])
  const observed: string[] = [], retrieve = f.client.checkout.sessions.retrieve
  f.client.checkout.sessions.retrieve = (async (...args: Parameters<typeof retrieve>) => { observed.push(args[0]); return retrieve(...args) }) as typeof retrieve
  assert.equal((await runEnrollmentMaintenance({ limit: 1, client: f.client })).checked, 1)
  const sessionId = (id: string) => [...f.state.sessions.values()].find(session => session.metadata?.enrollment_id === id)!.id
  assert.deepEqual(observed, [sessionId(oldest.id)])
  await due(oldest.id, "2030-01-01T13:00:00.000Z")
  assert.equal((await runEnrollmentMaintenance({ limit: 1, client: f.client })).checked, 1)
  assert.equal(observed.at(-1), sessionId(second.id))
  await due(second.id, "2030-01-01T13:00:00.000Z")
  await getDatabase().execute("UPDATE mca_enrollments SET lease_until=?,revision=revision+1 WHERE id=?", ["2030-01-01T11:59:59.000Z", leased.id])
  assert.equal((await runEnrollmentMaintenance({ limit: 1, client: f.client })).checked, 1)
  assert.equal(observed.at(-1), sessionId(leased.id))
})

test("maintenance respects disabled runtime, zero limit and deadlines without provider work", async t => {
  const f = stripeFixture(), [one, two] = await Promise.all([started(f), started(f)])
  await due(one.id, "2030-01-01T11:00:00.000Z"); await due(two.id, "2030-01-01T11:01:00.000Z")
  let reads = 0; const retrieve = f.client.checkout.sessions.retrieve
  f.client.checkout.sessions.retrieve = (async (...args: Parameters<typeof retrieve>) => { reads++; t.mock.timers.setTime(clock + 1000); return retrieve(...args) }) as typeof retrieve
  const empty = { checked: 0, repaired: 0, operatorRequired: 0, errors: [] }
  process.env.MCA_ONBOARDING_RUNTIME_ENABLED = "false"
  assert.deepEqual(await runEnrollmentMaintenance({ client: f.client }), empty)
  process.env.MCA_ONBOARDING_RUNTIME_ENABLED = "true"
  assert.deepEqual(await runEnrollmentMaintenance({ limit: 0, client: f.client }), empty)
  assert.deepEqual(await runEnrollmentMaintenance({ deadlineMs: 0, client: f.client }), empty)
  assert.equal(reads, 0)
  assert.equal((await runEnrollmentMaintenance({ deadlineMs: 500, client: f.client })).checked, 1)
  assert.equal(reads, 1)
})

test("claimed enrollment follows exact trial expiry and cancellation during setup without erasing business data or original dates", async t => {
  const f = await started(), session = f.complete()
  await reconcileEnrollment(f.id, f.client)
  const identity = await liveIdentity(session.customer_details!.email!), claimed = await claimEnrollment({ enrollmentId: f.id, identity }, f.client)
  await saveBusinessBasics(await actor(claimed.workspaceId, identity.sessionId), { legalName: "Corrected company", ein: "123456789", expectedRevision: 0 })
  const original = (await findEnrollment(f.id))!, profile = await getDatabase().queryOne("SELECT profile_cipher,revision FROM company_basic_profiles WHERE workspace_id=?", [claimed.workspaceId])
  const local = (await getDatabase().queryOne<import("../src/lib/mca/company-access").CompanyAccessRow>("SELECT s.*, e.status, e.period_end, w.seat_limit FROM company_subscription_state s JOIN workspace_billing_entitlements e USING(workspace_id) JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?", [claimed.workspaceId]))!
  const end = Date.parse(original.trialEndsAt!)
  assert.equal(evaluateCompanyAccess(local, end - 1).allowed, true)
  assert.equal(evaluateCompanyAccess(local, end).allowed, false)
  t.mock.timers.setTime(end)
  assert.equal((await getCompanyAccess(claimed.workspaceId)).allowed, false)
  assert.equal((await claimEnrollment({ enrollmentId: f.id, identity }, f.client)).destination, "/settings/billing")
  await getDatabase().execute("UPDATE workspace_billing_entitlements SET status='canceled' WHERE workspace_id=?", [claimed.workspaceId])
  await assert.rejects(assertCompanyOperational(claimed.workspaceId), { code: "company_paused" })
  assert.deepEqual(await getDatabase().queryOne("SELECT profile_cipher,revision FROM company_basic_profiles WHERE workspace_id=?", [claimed.workspaceId]), profile)
  assert.equal((await findEnrollment(f.id))!.trialEndsAt, original.trialEndsAt)
  assert.equal((await findEnrollment(f.id))!.trialStartedAt, original.trialStartedAt)
  assert.equal(f.state.createCalls.length, 1)
})

test("new enrollment recovery leaves an existing registered tenant and platform owner authority unchanged", async () => {
  const identity = await liveIdentity("ben@sentineltechsolutions.io"), userId = await linkSupabaseUser(identity), workspaceId = newId(), membershipId = newId()
  const db = getDatabase(), stamp = nowIso()
  await db.execute("INSERT INTO workspaces(id,name,seat_limit,feature_flags,page_visibility,created_at,updated_at) VALUES (?,'Registered historical company',7,'{}','{}',?,?)", [workspaceId, stamp, stamp])
  await db.execute("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)", [membershipId, workspaceId, userId, stamp, stamp])
  await db.execute("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)", [workspaceId, membershipId, stamp])
  await db.execute("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,state_kind,selected_seats,trial_started_at,trial_ends_at,updated_at) VALUES (?,1,'legacy_exempt',7,'2024-01-01T00:00:00Z','2024-01-15T00:00:00Z',?)", [workspaceId, stamp])
  await db.execute("INSERT INTO sms_companies(workspace_id,owner_user_id,review_state,registration_state,profile_cipher,created_at,updated_at) VALUES (?,?,'approved','approved',?,?,?)", [workspaceId, userId, encryptSensitive(JSON.stringify({ legalName: "Registered legal name", ein: "987654321" }), workspaceId), stamp, stamp])
  await db.execute("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,'test','Retained owner')", [userId, stamp])
  const read = async () => Promise.all([db.queryOne("SELECT * FROM company_subscription_state WHERE workspace_id=?", [workspaceId]), db.queryOne("SELECT * FROM sms_companies WHERE workspace_id=?", [workspaceId]), db.queryOne("SELECT * FROM workspace_owners WHERE workspace_id=?", [workspaceId]), db.queryOne("SELECT * FROM memberships WHERE id=?", [membershipId]), db.queryOne("SELECT * FROM platform_admin_grants WHERE user_id=?", [userId])])
  const before = await read(), owner = await requireSuperAdmin()
  const f = await started(), session = f.complete()
  session.customer_details!.email = identity.email
  await reconcileEnrollment(f.id, f.client)
  provider.current = identity
  await assert.rejects(claimEnrollment({ enrollmentId: f.id, identity }, f.client), { code: "enrollment_existing_company" })
  assert.deepEqual(await read(), before)
  assert.deepEqual(await requireSuperAdmin(), owner)
  assert.equal((await getCompanyAccess(workspaceId)).allowed, true)
  assert.equal(f.state.cancelCalls, 1)
  assert.equal((await findEnrollment(f.id))?.workspaceId, null)
})
