import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, createHmac } from "node:crypto"
import { rmSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createClerkHttpFixture } from "./helpers/clerk-http.mjs"
const port = 4300 + (process.pid % 500),
  base = `http://localhost:${port}`,
  dist = ".next-test-billing"
let db,
  fixture,
  server,
  output = "",
  owner
const signingKey = randomBytes(32)
before(async () => {
  db = await createPostgresTestDatabase("billing_http")
  fixture = await createClerkHttpFixture(db)
  owner = await fixture.login(
    "owner@example.test",
    "Fixture unused password 99!"
  )
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "localhost",
      "--port",
      String(port),
    ],
    {
      env: db.env({
        ...fixture.env,
        MCA_CLERK_BILLING_ENABLED: "true",
        NEXT_DIST_DIR: dist,
        MCA_APP_ORIGIN: base,
        CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${signingKey.toString("base64")}`,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  server.stdout.on("data", (c) => (output += c))
  server.stderr.on("data", (c) => (output += c))
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/auth/session`, {
        signal: AbortSignal.timeout(5000),
      })
      return
    } catch {
      if (server.exitCode !== null) throw new Error(output)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error("Foundation test server did not start.")
})
after(async () => {
  if (server?.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise((r) => server.once("exit", r))
  }
  if (fixture) await fixture.close()
  if (db) await db.close()
  rmSync(dist, { recursive: true, force: true })
})
async function request(
  path,
  { cookie = owner.cookie, method = "GET", body, headers = {} } = {}
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(await fixture.headers(cookie)),
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`Non-JSON ${response.status}: ${output.slice(-3000)}`)
  }
  return { response, payload }
}


function plan(slug = "free_org", status = "active") {
  const now = Date.now()
  return { object: "commerce_subscription", id: "sub_fixture", instance_id: "ins_fixture", status, payer_id: "payer_fixture", created_at: now, updated_at: now, active_at: now, past_due_at: status === "past_due" ? now : null,
    subscription_items: [{ object: "commerce_subscription_item", id: "item_fixture", instance_id: "ins_fixture", status, plan_period: "month", period_start: now - 1000, period_end: now + 86400000, created_at: now, updated_at: now, ended_at: null, canceled_at: null, past_due_at: null, is_free_trial: false,
      plan_id: `plan_${slug}`, plan: { object: "commerce_plan", id: `plan_${slug}`, slug, name: slug, is_default: slug === "free_org", is_recurring: true, has_base_fee: true, publicly_visible: true, fee: null, annual_fee: null, annual_monthly_fee: null, for_payer_type: "org", features: [], free_trial_days: null, free_trial_enabled: false, avatar_url: null } }]
  }
}
const invite = email => request("/api/invitations", { method: "POST", body: { email, name: "Synthetic employee", role: "rep" } })
test("billing APIs enforce local roles, and checkout sync precedes webhook delivery", async () => {
  const workspaceId = owner.payload.membership.workspaceId
  const org = `org_${workspaceId}`
  fixture.billingSubscriptions.set(org, plan())
  assert.equal((await request("/api/billing", { cookie: null })).response.status, 401)
  let result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.response.status, 200, JSON.stringify(result.payload))
  assert.equal(result.payload.billing.seatLimit, 1)
  assert.equal((await invite("free@example.test")).response.status, 409)
  fixture.billingSubscriptions.set(org, plan("mca_starter_test"))
  result = await request("/api/billing/sync", { method: "POST" })
  assert.equal(result.payload.billing.seatLimit, 5)
  const invitations = await Promise.all(Array.from({ length: 6 }, (_, i) => invite(`seat${i}@example.test`)))
  assert.equal(invitations.filter(r => r.response.status === 201).length, 4, JSON.stringify(invitations.map(r => [r.response.status, r.payload])))
  assert.equal(invitations.filter(r => r.response.status === 409).length, 2)
  const accepted = invitations.find(r => r.response.status === 201).payload
  const resent = await request(`/api/invitations/${accepted.id}/resend`, { method: "POST" })
  assert.equal(resent.response.status, 201, JSON.stringify(resent.payload))
  assert.equal((await request("/api/billing")).payload.occupiedSeats, 5)
  await db.query("UPDATE memberships SET status='active' WHERE id=$1", [accepted.membershipId])
  const employeeRow = await db.query("SELECT u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.id=$1", [accepted.membershipId])
  const employee = await fixture.login(employeeRow.rows[0].email, "unused")
  for (const method of ["GET", "POST"]) {
    const denied = await request(method === "GET" ? "/api/billing" : "/api/billing/sync", { method, cookie: employee.cookie })
    assert.equal(denied.response.status, 403)
  }
  fixture.billingSubscriptions.set(org, plan("mca_starter_test", "past_due"))
  assert.equal((await request(`/api/invitations/${accepted.id}/resend`, { method: "POST" })).response.status, 409)
  fixture.billingSubscriptions.set(org, plan())
  await request("/api/billing/sync", { method: "POST" })
  assert.equal((await request("/api/billing")).payload.occupiedSeats, 5)
  assert.equal((await invite("over@example.test")).response.status, 409)
  fixture.billingSubscriptions.delete(org)
  assert.equal((await request("/api/billing/sync", { method: "POST" })).response.status, 503)
  assert.equal((await invite("outage@example.test")).response.status, 503)
  assert.equal((await request("/api/auth/session")).response.status, 200)
})

test("billing webhook signatures reject tampering and duplicate events reconcile once", async () => {
  const org = `org_${owner.payload.membership.workspaceId}`
  fixture.billingSubscriptions.set(org, plan("mca_team_test"))
  const body = { object: "event", type: "subscription.updated", data: { id: "sub_fixture", payer: { organization_id: org } } }
  const timestamp = String(Math.floor(Date.now() / 1000)), id = "evt_billing_http"
  const signature = createHmac("sha256", signingKey).update(`${id}.${timestamp}.${JSON.stringify(body)}`).digest("base64")
  const headers = { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}` }
  const route = "/api/webhooks/clerk"
  assert.equal((await request(route, { method: "POST", body, headers: { ...headers, "svix-signature": "v1,invalid" }, cookie: null })).response.status, 400)
  for (let i = 0; i < 2; i++) assert.equal((await request(route, { method: "POST", body, headers, cookie: null })).response.status, 200)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  const events = await db.query("SELECT count(*)::int count FROM clerk_webhook_events WHERE id=$1", [id])
  assert.equal(events.rows[0].count, 1)
})

test("one identity switches companies without sharing billing or local financial roles", async () => {
  const second = await fixture.login("second-owner@example.test", "Fixture unused password 99!")
  const workspaceId = second.payload.membership.workspaceId
  const originalId = owner.payload.membership.workspaceId
  const userRow = await db.query("SELECT user_id FROM memberships WHERE id=$1", [owner.payload.membership.id])
  const memberId = "billing-cross-company-member", userId = userRow.rows[0].user_id, now = new Date().toISOString()
  await db.query("INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ($1,$2,$3,'admin','active',$4,$4)", [memberId, workspaceId, userId, now])
  const { createSession } = await import("../src/lib/mca/sessions.ts")
  const session = await createSession(userId, memberId), cookie = `mca_session=${session.token}`
  const subscription = plan(); subscription.id = "sub_second_company"
  fixture.billingSubscriptions.set(`org_${workspaceId}`, subscription)
  const switched = await request("/api/billing/sync", { method: "POST", cookie })
  assert.equal(switched.response.status, 200, JSON.stringify(switched.payload))
  assert.equal(switched.payload.billing.seatLimit, 1)
  assert.equal((await request("/api/auth/session", { cookie })).payload.membership.workspaceId, workspaceId)
  assert.equal((await request("/api/billing")).payload.billing.seatLimit, 20)
  assert.notEqual(workspaceId, originalId)
  for (const role of ["manager", "rep"]) {
    await db.query("UPDATE memberships SET role=$1 WHERE id=$2", [role, memberId])
    assert.equal((await request("/api/billing", { cookie })).response.status, 403)
    assert.equal(fixture.remoteRoles.get(`${workspaceId}:${userId}`), "org:mca_employee")
  }
  await db.query("UPDATE memberships SET role='super_admin' WHERE id=$1", [memberId])
  assert.equal((await request("/api/billing", { cookie })).response.status, 200)
  assert.equal(fixture.remoteRoles.get(`${workspaceId}:${userId}`), "org:mca_billing_admin")
  await db.query("UPDATE memberships SET status='deactivated' WHERE id=$1", [memberId])
  assert.equal((await request("/api/billing", { cookie })).response.status, 401)
})

test("pending admin invitations cannot gain provider billing permissions; API keys cannot manage billing", async () => {
  const pending = (await db.query("SELECT id,user_id FROM memberships WHERE workspace_id=$1 AND status='pending' LIMIT 1", [owner.payload.membership.workspaceId])).rows[0]
  await db.query("UPDATE users SET clerk_user_id=$1 WHERE id=$2", [`user_${pending.user_id}`, pending.user_id])
  const changed = await request(`/api/memberships/${pending.id}`, { method: "PATCH", body: { role: "admin" } })
  assert.equal(changed.response.status, 200, JSON.stringify(changed.payload))
  assert.equal(fixture.remoteRoles.get(`${owner.payload.membership.workspaceId}:${pending.user_id}`), "org:mca_employee")
  const key = await request("/api/api-keys", { method: "POST", body: { name: "Billing boundary fixture", scopes: ["deals:read", "workspace:read"] } })
  assert.equal(key.response.status, 201, JSON.stringify(key.payload))
  const headers = { authorization: `Bearer ${key.payload.secret}` }
  assert.equal((await request("/api/billing", { cookie: null, headers })).response.status, 403)
  assert.equal((await request("/api/billing/sync", { method: "POST", cookie: null, headers })).response.status, 403)
  assert.equal((await request("/api/mca/deals", { cookie: null, headers })).response.status, 200)
})
