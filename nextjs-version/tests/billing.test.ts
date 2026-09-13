import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, closeDatabaseForTests, withImmediateTransaction, nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin, updateWorkspaceSettings } from "../src/lib/mca/workspaces"
import { resolveCreditAllowance } from "../src/lib/mca/assistant/credits"
import { subscriptionEntitlement, syncWorkspaceBilling, assertBillingCapacity, getWorkspaceBilling, getStripeClient, processStripeBillingEvent, verifyStripeBillingEvent, createBillingCheckout, createBillingPortal, type BillingSubscription, type StripeBillingClient } from "../src/lib/mca/billing"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const envKeys = ["MCA_STRIPE_BILLING_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_STARTER_PRICE_ID", "STRIPE_TEAM_PRICE_ID", "STRIPE_BILLING_WEBHOOK_SECRET", "MCA_APP_ORIGIN"]
const initialEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
before(async () => {
  database = await createPostgresTestDatabase("billing")
  process.env.DATABASE_URL = database.databaseUrl
  process.env.MCA_STRIPE_BILLING_ENABLED = "true"
  process.env.STRIPE_SECRET_KEY = "rk_test_fixture"
  process.env.STRIPE_STARTER_PRICE_ID = "price_starter"
  process.env.STRIPE_TEAM_PRICE_ID = "price_team"
  process.env.STRIPE_BILLING_WEBHOOK_SECRET = "whsec_fixture"
  process.env.MCA_APP_ORIGIN = "http://localhost:3000"
})
after(async () => {
  for (const key of envKeys) { if (initialEnv[key] === undefined) delete process.env[key]; else process.env[key] = initialEnv[key] }
  await closeDatabaseForTests(); await database?.close()
})
function subscription(customer = "cus_fixture", price = "price_starter", status = "active", id = `sub_${randomUUID()}`): BillingSubscription {
  return { id, customer, status, livemode: false, items: { data: [{ quantity: 1, price: { id: price }, current_period_start: 1700000000, current_period_end: 2000000000 }] } }
}
async function fixture(mapped = true) {
  const suffix = randomUUID()
  const local = await createWorkspaceWithAdmin({ workspaceName: "Billing test", adminName: "Owner", adminEmail: `${suffix}@example.test`, password: "Unused fixture password 99!", role: "admin" })
  const customerId = `cus_${suffix}`
  if (mapped) await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id, stripe_customer_id, created_at) VALUES (?, ?, ?)").run(local.workspaceId, customerId, nowIso())
  const state = { subscriptions: mapped ? [subscription(customerId)] : [] as BillingSubscription[], fail: false, createdCustomers: 0, checkouts: 0, portals: 0, priceLivemode: false, priceAmount: 4900, checkoutStatus: "open", customerWorkspace: local.workspaceId, checkoutParams: {} as Record<string, unknown> }
  const client = {
    customers: { create: async () => { state.createdCustomers++; return { id: customerId, livemode: false } }, retrieve: async () => ({ id: customerId, livemode: false, metadata: { workspace_id: state.customerWorkspace } }) },
    subscriptions: { list: async () => { if (state.fail) throw new Error("provider outage"); return { data: state.subscriptions, has_more: false } }, retrieve: async (id: string) => state.subscriptions.find(s => s.id === id) },
    prices: { retrieve: async (id: string) => ({ id, active: true, livemode: state.priceLivemode, currency: "usd", unit_amount: state.priceAmount, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } }) },
    checkout: { sessions: {
      create: async (params: Record<string, unknown>) => { state.checkouts++; state.checkoutParams = params; return { id: `cs_test_${suffix}`, livemode: false, url: "https://checkout.stripe.com/test" } },
      retrieve: async () => ({ id: `cs_test_${suffix}`, status: state.checkoutStatus, url: "https://checkout.stripe.com/test" }),
      expire: async () => ({})
    } },
    billingPortal: { sessions: { create: async () => { state.portals++; return { url: "https://billing.stripe.com/test" } } } },
  } as unknown as StripeBillingClient
  return { ...local, customerId, state, client }
}

test("test catalog is strict and canceled, pending, paused, and delinquent states are safe", () => {
  assert.equal(subscriptionEntitlement(subscription()).seatLimit, 5)
  assert.equal(subscriptionEntitlement(subscription("cus_fixture", "price_team")).seatLimit, 20)
  assert.equal(subscriptionEntitlement({ ...subscription(), cancel_at_period_end: true }).seatLimit, 5)
  assert.equal(subscriptionEntitlement(subscription("cus_fixture", "price_team", "canceled")).seatLimit, 1)
  assert.equal(subscriptionEntitlement(subscription("cus_fixture", "price_team", "incomplete")).seatLimit, 1)
  for (const status of ["past_due", "unpaid", "paused"]) assert.equal(subscriptionEntitlement(subscription("cus_fixture", "price_team", status)).paymentPastDue, true)
  assert.equal(subscriptionEntitlement({ ...subscription(), pause_collection: { behavior: "void" } }).paymentPastDue, true)
  assert.throws(() => subscriptionEntitlement(subscription("cus_fixture", "price_unknown")), /administrator configuration/)
  assert.throws(() => subscriptionEntitlement({ ...subscription(), livemode: true }), /test subscriptions/)
  assert.throws(() => subscriptionEntitlement({ ...subscription(), items: { data: [{ quantity: 2, price: { id: "price_team" } }] } }), /administrator configuration/)
})
test("live and absent keys cannot initialize billing", () => {
  for (const key of ["sk_live_fixture", "rk_live_fixture", ""]) { process.env.STRIPE_SECRET_KEY = key; assert.throws(() => getStripeClient(), /test key/) }
  process.env.STRIPE_SECRET_KEY = "rk_test_fixture"
  assert.ok(getStripeClient())
})
test("new and migrated companies start Free without copying Clerk subscriptions or identities", async () => {
  const f = await fixture(false)
  await getDatabase().prepare("INSERT INTO workspace_billing (workspace_id, clerk_subscription_id, clerk_plan_id, plan_slug, plan_name, status, period_start, seat_limit, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(f.workspaceId, `csub_${f.workspaceId}`, "old_plan", "mca_team_test", "Historical Team", "active", nowIso(), 20, nowIso())
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 1)
  assert.equal((await getDatabase().prepare("SELECT plan_name FROM workspace_billing WHERE workspace_id = ?").get(f.workspaceId))?.plan_name, "Historical Team")
  assert.equal(f.state.createdCustomers, 0)
})
test("sync retains local identities and downgrade never deletes over-cap historical memberships", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.subscriptions[0].status = "canceled"
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 1)
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /seats/)
  assert.equal((await getDatabase().prepare("SELECT status FROM memberships WHERE id = ?").get(f.membershipId))?.status, "active")
})
test("past due and provider outages block new invitations while preserving business access and cached plan", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  f.state.fail = true
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /temporarily unavailable/)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.fail = false; f.state.subscriptions[0].status = "past_due"
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /payment method/)
})
test("unknown or mismatched customer subscriptions fail closed", async () => {
  const f = await fixture()
  f.state.subscriptions[0].customer = "cus_another_company"
  await assert.rejects(syncWorkspaceBilling(f.workspaceId, f.client), /identity/)
  f.state.subscriptions = [subscription(f.customerId), subscription(f.customerId)]
  await assert.rejects(syncWorkspaceBilling(f.workspaceId, f.client), /Multiple company subscriptions/)
})
test("AI monthly allowances require verified paid state and payment problems preserve only the free allowance", async () => {
  const f = await fixture()
  assert.equal(await resolveCreditAllowance(f.workspaceId, f.client), 100)
  f.state.subscriptions[0].status = "past_due"
  assert.equal(await resolveCreditAllowance(f.workspaceId, f.client), 10)
  f.state.fail = true
  await assert.rejects(resolveCreditAllowance(f.workspaceId, f.client), /temporarily unavailable/)
})
test("signed events reject tampering and stale or duplicate events cannot replay entitlements", async () => {
  const f = await fixture()
  const event = { id: `evt_${f.workspaceId}`, type: "customer.subscription.updated", livemode: false, data: { object: { customer: f.customerId, status: "canceled" } } } as unknown as Stripe.Event
  const body = JSON.stringify(event)
  const real = getStripeClient()
  const header = real.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_fixture" })
  assert.equal(verifyStripeBillingEvent(body, header, real).id, event.id)
  assert.throws(() => verifyStripeBillingEvent(body + " ", header, real), /signature/)
  assert.throws(() => verifyStripeBillingEvent(body, null, real), /signature/)
  assert.deepEqual(await processStripeBillingEvent(event, f.client), { reconciled: true })
  assert.deepEqual(await processStripeBillingEvent(event, f.client), { duplicate: true })
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  f.state.subscriptions = [subscription(f.customerId, "price_team")]
  await processStripeBillingEvent({ ...event, id: `${event.id}_next`, type: "invoice.payment_failed" } as unknown as Stripe.Event, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 20)
  await assert.rejects(processStripeBillingEvent({ ...event, livemode: true }, f.client), /Live billing/)
})
test("failed webhook reconciliation rolls receipt back for Stripe retry", async () => {
  const f = await fixture()
  const event = { id: `evt_failure_${f.workspaceId}`, type: "invoice.paid", livemode: false, data: { object: { customer: f.customerId } } } as unknown as Stripe.Event
  f.state.fail = true
  await assert.rejects(processStripeBillingEvent(event, f.client), /temporarily unavailable/)
  assert.equal(await getDatabase().prepare("SELECT event_id FROM stripe_billing_events WHERE event_id = ?").get(event.id), undefined)
  f.state.fail = false
  assert.deepEqual(await processStripeBillingEvent(event, f.client), { reconciled: true })
})
test("a transaction failure rolls back billing and workspace seat changes together", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  f.state.subscriptions = [subscription(f.customerId, "price_team")]
  await assert.rejects(withImmediateTransaction(async () => { await syncWorkspaceBilling(f.workspaceId, f.client); throw new Error("synthetic commit failure") }))
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 5)
  await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 20)
})
test("parallel reservations count both active and pending seats under the workspace lock", async () => {
  const f = await fixture()
  const reserve = () => withImmediateTransaction(async db => {
    await assertBillingCapacity(f.workspaceId, 1, f.client)
    const id = randomUUID(), now = nowIso()
    await db.prepare("INSERT INTO users (id, email, name, password_hash, application_identifier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, `${id}@example.test`, "Pending", "unused", id, now, now)
    await db.prepare("INSERT INTO memberships (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), f.workspaceId, id, "rep", "pending", now, now)
  })
  const results = await Promise.allSettled(Array.from({ length: 8 }, reserve))
  assert.equal(results.filter(result => result.status === "fulfilled").length, 4)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).occupiedSeats, 5)
})
test("manual settings cannot bypass plan seats", async () => {
  const f = await fixture()
  await syncWorkspaceBilling(f.workspaceId, f.client)
  await assert.rejects(updateWorkspaceSettings({ authType: "session", userId: f.userId, membershipId: f.membershipId, workspaceId: f.workspaceId, role: "super_admin", scopes: [], sessionId: "test" }, { seatLimit: 99 }), /Plans & Billing/)
})
test("Checkout is workspace bound, catalog validated, and retries reuse the pending session", async () => {
  const f = await fixture(false)
  assert.deepEqual(await createBillingCheckout(f.workspaceId, "mca_starter_test", false, f.client), { url: "https://checkout.stripe.com/test" })
  await createBillingCheckout(f.workspaceId, "mca_starter_test", false, f.client)
  assert.equal(f.state.createdCustomers, 1)
  assert.equal(f.state.checkouts, 1)
  assert.deepEqual(f.state.checkoutParams.subscription_data, { metadata: { workspace_id: f.workspaceId } })
  assert.equal(f.state.checkoutParams.customer, f.customerId)
  assert.equal(f.state.checkoutParams.success_url, "http://localhost:3000/settings/billing")
  assert.equal(f.state.checkoutParams.payment_method_types, undefined)
  assert.equal((await getWorkspaceBilling(f.workspaceId)).billing?.seatLimit, 1)
  f.state.priceLivemode = true
  await assert.rejects(createBillingCheckout(f.workspaceId, "mca_starter_test", false, f.client), /catalog/)
  f.state.priceLivemode = false; f.state.priceAmount = 1
  await assert.rejects(createBillingCheckout(f.workspaceId, "mca_starter_test", false, f.client), /catalog/)
})
test("a paid company cannot create a duplicate subscription and Portal rejects cross-company identities", async () => {
  const f = await fixture()
  await assert.rejects(createBillingCheckout(f.workspaceId, "mca_starter_test", false, f.client), /existing subscription/)
  await createBillingPortal(f.workspaceId, false, f.client)
  assert.equal(f.state.portals, 1)
  f.state.customerWorkspace = "another_workspace"
  await assert.rejects(createBillingPortal(f.workspaceId, false, f.client), /identity/)
})
test("Sync Engine reads match live provider state; lagging sync cannot grant or hide seats", async () => {
  const f = await fixture()
  await database.query("CREATE SCHEMA stripe; CREATE TABLE stripe.subscriptions (id text PRIMARY KEY, customer text, status text, livemode boolean); CREATE TABLE stripe.subscription_items (id text PRIMARY KEY, subscription text, price text, quantity integer, deleted boolean, current_period_start integer, current_period_end integer)")
  const live = f.state.subscriptions[0]
  await database.query("INSERT INTO stripe.subscriptions VALUES ($1, $2, 'active', false)", [live.id, f.customerId])
  await database.query("INSERT INTO stripe.subscription_items VALUES ($1, $2, 'price_starter', 1, false, 1700000000, 2000000000)", [`si_${live.id}`, live.id])
  assert.equal((await syncWorkspaceBilling(f.workspaceId, f.client)).source, "sync_engine")
  f.state.subscriptions[0].items.data[0].price.id = "price_team"
  const upgraded = await syncWorkspaceBilling(f.workspaceId, f.client)
  assert.equal(upgraded.source, "stripe_api"); assert.equal(upgraded.seatLimit, 20)
  f.state.subscriptions[0].status = "past_due"
  await assert.rejects(assertBillingCapacity(f.workspaceId, 1, f.client), /payment method/)
})
