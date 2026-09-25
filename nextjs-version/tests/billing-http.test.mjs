import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createSupabaseHttpFixture } from "./helpers/supabase-http.mjs"
import { createStripeHttpFixture } from "./helpers/stripe-http.mjs"
const port = 4300 + (process.pid % 500), base = `http://localhost:${port}`, dist = ".next-test-billing"
let db, fixture, stripe, server, output = "", owner
const signatureClient = new Stripe("sk_test_fixture")
before(async () => {
  db = await createPostgresTestDatabase("billing_http")
  fixture = await createSupabaseHttpFixture(db)
  stripe = await createStripeHttpFixture()
  owner = await login("owner@example.test")
  const now = new Date().toISOString(), trialEnd = new Date(Date.now() + 14 * 86400000).toISOString()
  await db.query("INSERT INTO company_subscription_state(workspace_id,trial_started_at,trial_ends_at,selected_seats,updated_at) VALUES($1,$2,$3,5,$2)",[owner.workspaceId,now,trialEnd])
  await db.query("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES($1,$2,$3)",[owner.workspaceId,owner.membershipId,now])
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
    env: db.env({ ...fixture.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolve("tests/helpers/stripe-test-fetch.mjs")}`, MCA_STRIPE_TEST_API_ORIGIN: stripe.origin, MCA_STRIPE_BILLING_ENABLED: "true", MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "rk_test_fixture", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats", STRIPE_BILLING_PORTAL_CONFIGURATION: "bpc_fixture", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_fixture", NEXT_DIST_DIR: dist, MCA_APP_ORIGIN: base }),
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout.on("data", c => output += c); server.stderr.on("data", c => output += c)
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try { await fetch(`${base}/api/auth/session`, { signal: AbortSignal.timeout(5000) }); return }
    catch { if (server.exitCode !== null) throw new Error(output); await new Promise(r => setTimeout(r, 200)) }
  }
  throw new Error("Billing HTTP server did not start.")
})
after(async () => {
  if (server?.exitCode === null) { server.kill("SIGTERM"); await new Promise(r => server.once("exit", r)) }
  if (stripe) await stripe.close()
  if (fixture) await fixture.close()
  if (db) await db.close()
  rmSync(dist, { recursive: true, force: true })
})
async function login(email) {
  const result = await fixture.login(email, "Fixture unused password 99!")
  const member = (await db.query("SELECT m.id membership_id,m.workspace_id,m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1",[email])).rows[0]
  return { ...result, workspaceId:member.workspace_id, userId:member.user_id, membershipId:member.membership_id }
}
async function request(path, { cookie = owner.cookie, method = "GET", body, headers = {}, rawBody } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(await fixture.headers(cookie)), origin: base, ...(body || rawBody ? { "content-type": "application/json" } : {}), ...headers }, ...(body || rawBody ? { body: rawBody ?? JSON.stringify(body) } : {}) })
  const text = await response.text()
  let payload; try { payload = JSON.parse(text) } catch { throw new Error(`Non-JSON ${response.status}: ${output.slice(-3000)}`) }
  return { response, payload }
}
function subscription(customer, seats = 5, status = "active", id = "sub_fixture") {
  return { id, object: "subscription", customer, status, livemode: false, items: { data: [{ id: "si_base", quantity: 1, price: { id: "price_base" }, current_period_start: 1700000000, current_period_end: 2000000000 }, ...(seats > 1 ? [{ id: "si_seats", quantity: seats - 1, price: { id: "price_seats" }, current_period_start: 1700000000, current_period_end: 2000000000 }] : [])] } }
}
const customer = () => [...stripe.customers.values()].find(value => value.metadata.workspace_id === owner.workspaceId)
test("Supabase session and local roles govern billing and real Stripe Checkout never grants seats on redirect", async () => {
  assert.equal((await request("/api/billing", { cookie: null })).response.status, 401)
  let result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.response.status, 200)
  assert.equal(result.payload.access.status, "trial")
  assert.equal(result.payload.access.seatLimit, 5)
  result = await request("/api/billing/checkout", { method: "POST", body: { selectedSeats: 5 } })
  assert.equal(result.response.status, 200, JSON.stringify(result.payload))
  assert.match(result.payload.url, /^https:\/\/checkout.stripe.com\//)
  assert.equal((await request("/api/billing")).payload.access.status, "trial")
  assert.ok(customer())
  const checkoutCall = stripe.calls.find(c => c.path === "/v1/checkout/sessions" && c.method === "POST")
  assert.equal(checkoutCall.body.get("subscription_data[metadata][workspace_id]"), owner.workspaceId)
  assert.equal(checkoutCall.body.get("line_items[0][price]"), "price_base")
  assert.equal(checkoutCall.body.get("line_items[1][price]"), "price_seats")
  assert.equal(checkoutCall.body.get("line_items[1][quantity]"), "4")
  stripe.subscriptions.set(customer().id, [subscription(customer().id)])
  result = await request("/api/billing/sync", { method: "POST" })
  assert.notEqual(result.payload.billing.status, "active", "provider active status alone is not proof of payment")
  stripe.invoices.set(customer().id, [{ id: "in_fixture_paid", object: "invoice", customer: customer().id, livemode: false, parent: { subscription_details: { subscription: "sub_fixture" } }, status: "paid", billing_reason: "subscription_create", currency: "usd", amount_due: 71500, amount_paid: 71500, amount_remaining: 0, hosted_invoice_url: null, period_start: 1700000000, period_end: 2000000000, created: 1700000000, attempt_count: 1, status_transitions: { finalized_at: 1700000000 } }])
  result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.payload.billing.seatLimit, 5)
  assert.equal((await request("/api/billing/checkout", { method: "POST", body: { selectedSeats: 20 } })).response.status, 409)
  assert.equal((await request("/api/billing/portal", { method: "POST", body: {} })).response.status, 200)
  const employee = await login("employee@example.test")
  await db.query("UPDATE memberships SET role='rep' WHERE id=$1", [employee.membershipId])
  for (const [path, method, body] of [["/api/billing", "GET"], ["/api/billing/sync", "POST"], ["/api/billing/checkout", "POST", { selectedSeats: 5 }], ["/api/billing/portal", "POST", {}], ["/api/billing/cancel", "POST", {}]])
    assert.equal((await request(path, { method, body, cookie: employee.cookie })).response.status, 403)
})
test("webhook tampering is rejected and duplicate or outdated events queue for live Stripe reconciliation", async () => {
  stripe.subscriptions.set(customer().id, [subscription(customer().id, 20)])
  const body = JSON.stringify({ id: "evt_billing_http", type: "customer.subscription.updated", livemode: false, data: { object: { customer: customer().id, status: "canceled" } } })
  const signature = signatureClient.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_fixture" })
  assert.equal((await request("/api/webhooks/stripe", { cookie: null, method: "POST", rawBody: body + " ", headers: { "stripe-signature": signature } })).response.status, 400)
  for (let i = 0; i < 2; i++) assert.equal((await request("/api/webhooks/stripe", { cookie: null, method: "POST", rawBody: body, headers: { "stripe-signature": signature } })).response.status, 200)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 5)
  assert.equal((await request("/api/billing/sync", { method: "POST" })).response.status, 200)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  assert.equal((await db.query("SELECT count(*)::int n FROM stripe_billing_events WHERE event_id='evt_billing_http'")).rows[0].n, 1)
})
test("origin validation and API-key restrictions cover every payment mutation", async () => {
  assert.equal((await request("/api/billing/cancel", { cookie:null,method:"POST",body:{} })).response.status,401)
  for(const headers of [{origin:"https://attacker.example"},{"sec-fetch-site":"cross-site"}]) assert.equal((await request("/api/billing/cancel", {method:"POST",body:{},headers})).response.status,403)
  const denied = await request("/api/billing/checkout", { method: "POST", body: { selectedSeats: 5 }, headers: { origin: "https://attacker.example" } })
  assert.equal(denied.response.status, 403)
  const { createApiKey } = await import("../src/lib/mca/api-keys.ts")
  const key = await createApiKey({ authType: "session", userId: owner.userId, membershipId: owner.membershipId, workspaceId: owner.workspaceId, role: "super_admin", scopes: [], sessionId: randomUUID() }, { name: "Billing denied", scopes: ["deals:read"], rateLimitPerMinute: 100 })
  for (const [path, method, body] of [["/api/billing", "GET"], ["/api/billing/sync", "POST"], ["/api/billing/checkout", "POST", { selectedSeats: 5 }], ["/api/billing/portal", "POST", {}], ["/api/billing/cancel", "POST", {}]])
    assert.equal((await request(path, { cookie: null, method, body, headers: { authorization: `Bearer ${key.secret}` } })).response.status, 403)
})
test("billing remains workspace isolated and deactivated users lose access", async () => {
  const other = await login("other-owner@example.test")
  const otherBilling = await request("/api/billing/sync", { cookie: other.cookie, method: "POST" })
  assert.equal(otherBilling.payload.access.status, "legacy_exempt")
  assert.equal(otherBilling.payload.billing, null)
  assert.deepEqual(otherBilling.payload.recovery, { overdueAmount: 0, paymentRequired: false, verificationPending: false, invoices: [] })
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  await db.query("UPDATE memberships SET status='deactivated' WHERE id=$1", [other.membershipId])
  assert.equal((await request("/api/billing", { cookie: other.cookie })).response.status, 401)
})

test("recovery projects only verified company debt and paid redirects cannot grant access", async () => {
  const customerId = customer().id
  const now = Math.floor(Date.now() / 1000), start = now - 10 * 86400
  const invoice = (id, amount, sub = "sub_fixture") => ({ id, object: "invoice", customer: customerId, livemode: false, parent: { subscription_details: { subscription: sub } }, status: "open", billing_reason: "subscription_cycle", currency: "usd", amount_due: amount, amount_paid: 0, amount_remaining: amount, hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, period_start: start, period_end: now, created: start, attempt_count: 1, auto_advance: false, status_transitions: { finalized_at: start } })
  stripe.subscriptions.set(customerId, [subscription(customerId), subscription(customerId, 5, "canceled", "sub_historical"), { ...subscription(customerId, 5, "active", "sub_unrelated"), items: { data: [{ price: { id: "price_other" }, quantity: 1 }] } }])
  stripe.invoices.set(customerId, [invoice("in_recovery_one", 39900), invoice("in_recovery_two", 12345, "sub_historical"), invoice("in_unrelated", 99999, "sub_unrelated"), invoice("in_standalone", 88888, null)])
  let result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.response.status, 200, JSON.stringify(result.payload))
  const calls = stripe.calls.length
  result = await request("/api/billing?paid=true&workspaceId=another-company")
  assert.equal(stripe.calls.length, calls, "local display must not call Stripe")
  assert.equal(result.payload.access.allowed, false)
  assert.equal(result.payload.recovery.overdueAmount, 52245)
  assert.equal(result.payload.canManagePayment, true)
  const portal = await request("/api/billing/portal", { method: "POST", body: {} })
  assert.equal(portal.response.status, 200, "paused administrators retain payment and cancellation access")
  assert.match(portal.payload.url, /^https:\/\/billing.stripe.com\//)
  assert.equal((await request("/api/billing?paid=true")).payload.access.allowed, false, "opening payment settings cannot restore access")
  const billingPage = await fetch(`${base}/settings/billing?paid=true`, { headers: await fixture.headers(owner.cookie), redirect: "manual" })
  assert.equal(billingPage.status, 200, "paused administrators can reach the billing page")
  assert.equal(result.payload.recovery.paymentRequired, true)
  assert.equal(result.payload.recovery.verificationPending, false)
  assert.deepEqual(result.payload.recovery.invoices.map(i => i.id), ["in_recovery_one", "in_recovery_two"])
  assert.deepEqual(result.payload.recovery.invoices[0], { id: "in_recovery_one", status: "open", amountRemaining: 39900, periodStart: new Date(start * 1000).toISOString(), periodEnd: new Date(now * 1000).toISOString(), hostedInvoiceUrl: "https://invoice.stripe.com/i/in_recovery_one" })
  const other = await login("recovery-other@example.test")
  assert.deepEqual((await request("/api/billing", { cookie: other.cookie })).payload.recovery.invoices, [])
  // A new customer mapping has no verified scope, even if accounting rows exist.
  await db.query("INSERT INTO workspace_stripe_customers(workspace_id,stripe_customer_id,livemode,created_at) VALUES($1,$2,0,$3)", [other.workspaceId, "cus_unverified", new Date().toISOString()])
  assert.equal((await request("/api/billing", { cookie: other.cookie })).payload.recovery.verificationPending, true)
  stripe.invoices.set(customerId, stripe.invoices.get(customerId).map(i => ({ ...i, customer: "cus_wrong" })))
  assert.equal((await request("/api/billing/sync", { method: "POST" })).response.status, 503)
  result = await request("/api/billing?paid=true")
  assert.equal(result.payload.recovery.verificationPending, true)
  assert.equal(result.payload.recovery.overdueAmount, 52245, "retain last verified debt on failed verification")
  assert.equal(result.payload.access.allowed, false)
  stripe.invoices.set(customerId, stripe.invoices.get(customerId).map(i => ({ ...i, customer: customerId, ...(i.id === "in_recovery_two" ? { currency: "eur" } : {}) })))
  result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.response.status, 200)
  assert.equal(result.payload.recovery.overdueAmount, 39900, "never sum non-USD debt into the USD recovery balance")
  assert.equal(result.payload.recovery.verificationPending, true)
  stripe.invoices.set(customerId, stripe.invoices.get(customerId).map(i => ({ ...i, currency: "usd", hosted_invoice_url: null })))
  result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.payload.recovery.verificationPending, true, "unavailable payment links need verification")
  stripe.invoices.set(customerId, stripe.invoices.get(customerId).map(i => ({ ...i, status: "paid", amount_remaining: 0, amount_paid: i.amount_due, status_transitions: { ...i.status_transitions, paid_at: now } })))
  assert.equal((await request("/api/billing?paid=true")).payload.access.allowed, false, "a redirect cannot substitute for verified reconciliation")
  result = await request("/api/billing/sync", { method: "POST" })
  assert.deepEqual(result.payload.recovery, { overdueAmount: 0, paymentRequired: false, verificationPending: false, invoices: [] })
  assert.equal(result.payload.access.allowed, true)
})

test("paused owner and admin can cancel only their mapped subscription without changing suspension or debt",async()=>{
  await db.query("UPDATE company_subscription_state SET manual_paused=1 WHERE workspace_id=$1",[owner.workspaceId])
  const customerId=customer().id,sub=subscription(customerId)
  stripe.subscriptions.set(customerId,[sub])
  for(const role of ["super_admin","admin"]){
    await db.query("UPDATE memberships SET role=$1 WHERE id=$2",[role,owner.membershipId])
    const result=await request("/api/billing/cancel",{method:"POST",body:{}})
    assert.equal(result.response.status,200,JSON.stringify(result.payload))
    assert.equal(result.payload.cancelAt,new Date(2000000000*1000).toISOString())
  }
  assert.equal(sub.cancel_at_period_end,true)
  assert.equal((await request("/api/billing")).payload.access.manualPaused,true)
  assert.equal((await request("/api/billing/cancel",{method:"POST",body:{subscriptionId:"sub_other"}})).response.status,400)
  const other=await login("cancel-other@example.test")
  assert.equal((await request("/api/billing/cancel",{cookie:other.cookie,method:"POST",body:{}})).response.status,409)
  await db.query("UPDATE memberships SET status='deactivated' WHERE id=$1",[other.membershipId])
  assert.equal((await request("/api/billing/cancel",{cookie:other.cookie,method:"POST",body:{}})).response.status,401)
})
