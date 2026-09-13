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
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
    env: db.env({ ...fixture.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${resolve("tests/helpers/stripe-test-fetch.mjs")}`, MCA_STRIPE_TEST_API_ORIGIN: stripe.origin, MCA_STRIPE_BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "rk_test_fixture", STRIPE_STARTER_PRICE_ID: "price_starter", STRIPE_TEAM_PRICE_ID: "price_team", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_fixture", NEXT_DIST_DIR: dist, MCA_APP_ORIGIN: base }),
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
function subscription(customer, price = "price_starter", status = "active", id = "sub_fixture") {
  return { id, object: "subscription", customer, status, livemode: false, items: { data: [{ quantity: 1, price: { id: price }, current_period_start: 1700000000, current_period_end: 2000000000 }] } }
}
test("Supabase session and local roles govern billing and real Stripe Checkout never grants seats on redirect", async () => {
  assert.equal((await request("/api/billing", { cookie: null })).response.status, 401)
  let result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.response.status, 200)
  assert.equal(result.payload.billing.seatLimit, 1)
  result = await request("/api/billing/checkout", { method: "POST", body: { planSlug: "mca_starter_test" } })
  assert.equal(result.response.status, 200, JSON.stringify(result.payload))
  assert.match(result.payload.url, /^https:\/\/checkout.stripe.com\//)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 1)
  const mapping = (await db.query("SELECT * FROM workspace_stripe_customers WHERE workspace_id=$1", [owner.workspaceId])).rows[0]
  assert.ok(mapping)
  const checkoutCall = stripe.calls.find(c => c.path === "/v1/checkout/sessions" && c.method === "POST")
  assert.equal(checkoutCall.body.get("subscription_data[metadata][workspace_id]"), owner.workspaceId)
  assert.equal(checkoutCall.body.get("line_items[0][price]"), "price_starter")
  stripe.subscriptions.set(mapping.stripe_customer_id, [subscription(mapping.stripe_customer_id)])
  result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.payload.billing.seatLimit, 5)
  assert.equal((await request("/api/billing/checkout", { method: "POST", body: { planSlug: "mca_team_test" } })).response.status, 409)
  assert.equal((await request("/api/billing/portal", { method: "POST", body: {} })).response.status, 200)
  const employee = await login("employee@example.test")
  await db.query("UPDATE memberships SET role='rep' WHERE id=$1", [employee.membershipId])
  for (const [path, method, body] of [["/api/billing", "GET"], ["/api/billing/sync", "POST"], ["/api/billing/checkout", "POST", { planSlug: "mca_starter_test" }], ["/api/billing/portal", "POST", {}]])
    assert.equal((await request(path, { method, body, cookie: employee.cookie })).response.status, 403)
})
test("webhook tampering is rejected and duplicate or outdated events read live Stripe state", async () => {
  const mapping = (await db.query("SELECT * FROM workspace_stripe_customers WHERE workspace_id=$1", [owner.workspaceId])).rows[0]
  stripe.subscriptions.set(mapping.stripe_customer_id, [subscription(mapping.stripe_customer_id, "price_team")])
  const body = JSON.stringify({ id: "evt_billing_http", type: "customer.subscription.updated", livemode: false, data: { object: { customer: mapping.stripe_customer_id, status: "canceled" } } })
  const signature = signatureClient.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_fixture" })
  assert.equal((await request("/api/webhooks/stripe", { cookie: null, method: "POST", rawBody: body + " ", headers: { "stripe-signature": signature } })).response.status, 400)
  for (let i = 0; i < 2; i++) assert.equal((await request("/api/webhooks/stripe", { cookie: null, method: "POST", rawBody: body, headers: { "stripe-signature": signature } })).response.status, 200)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  assert.equal((await db.query("SELECT count(*)::int n FROM stripe_billing_events WHERE event_id='evt_billing_http'")).rows[0].n, 1)
})
test("origin validation and API-key restrictions cover every payment mutation", async () => {
  const denied = await request("/api/billing/checkout", { method: "POST", body: { planSlug: "mca_starter_test" }, headers: { origin: "https://attacker.example" } })
  assert.equal(denied.response.status, 403)
  const { createApiKey } = await import("../src/lib/mca/api-keys.ts")
  const key = await createApiKey({ authType: "session", userId: owner.userId, membershipId: owner.membershipId, workspaceId: owner.workspaceId, role: "super_admin", scopes: [], sessionId: randomUUID() }, { name: "Billing denied", scopes: ["deals:read"], rateLimitPerMinute: 100 })
  for (const [path, method, body] of [["/api/billing", "GET"], ["/api/billing/sync", "POST"], ["/api/billing/checkout", "POST", { planSlug: "mca_starter_test" }], ["/api/billing/portal", "POST", {}]])
    assert.equal((await request(path, { cookie: null, method, body, headers: { authorization: `Bearer ${key.secret}` } })).response.status, 403)
})
test("billing remains workspace isolated and deactivated users lose access", async () => {
  const other = await login("other-owner@example.test")
  assert.equal((await request("/api/billing/sync", { cookie: other.cookie, method: "POST" })).payload.billing.seatLimit, 1)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  await db.query("UPDATE memberships SET status='deactivated' WHERE id=$1", [other.membershipId])
  assert.equal((await request("/api/billing", { cookie: other.cookie })).response.status, 401)
})
