import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, createHmac } from "node:crypto"
import { rmSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createClerkHttpFixture } from "./helpers/clerk-http.mjs"
const port = 4300 + (process.pid % 500),
  base = `http://localhost:${port}`,
  dist = ".next-test-foundation"
let db,
  fixture,
  server,
  output = "",
  owner
const signingKey = randomBytes(32)
before(async () => {
  db = await createPostgresTestDatabase("foundation_http")
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

test("Clerk session contract, unauthenticated JSON, and legacy cutover", async () => {
  const current = await request("/api/auth/session")
  assert.equal(current.response.status, 200, JSON.stringify(current.payload))
  assert.equal(current.payload.membership.id, owner.payload.membership.id)
  const anonymous = await request("/api/auth/session", { cookie: null })
  assert.equal(anonymous.response.status, 401)
  const old = await request("/api/auth/session", {
    cookie: null,
    headers: { cookie: owner.cookie },
  })
  assert.equal(old.response.status, 401)
  for (const path of [
    "auth/sign-in",
    "auth/company-signup",
    "auth/recovery/request",
    "auth/recovery/reset",
    "invitations/accept",
  ]) {
    const result = await request(`/api/${path}`, {
      method: "POST",
      body: { email: "owner@example.test", password: "ignored" },
    })
    assert.equal(result.response.status, 410)
    assert.equal(result.response.headers.get("set-cookie"), null)
  }
})
test("unverified or passwordless identities and revoked or expired sessions cannot enter MCA", async () => {
  for (const [key, value] of [
    ["passwordEnabled", false],
    ["verified", false],
    ["banned", true],
    ["sessionStatus", "revoked"],
    ["sessionStatus", "expired"],
  ]) {
    const original = fixture.identityState[key]
    try {
      fixture.identityState[key] = value
      const denied = await request("/api/auth/session")
      assert.equal(denied.response.status, 401, `${key}: ${value}`)
    } finally {
      fixture.identityState[key] = original
    }
  }
  assert.equal((await request("/api/auth/session")).response.status, 200)
})
test("Clerk invitation reserves a seat, resends once, and activates only the invited member", async () => {
  const invited = await request("/api/invitations", {
    method: "POST",
    body: { email: "rep@example.test", name: "Rep", role: "rep" },
  })
  assert.equal(invited.response.status, 201, JSON.stringify(invited.payload))
  assert.equal(invited.payload.delivery, "sent")
  const resend = await request(
    `/api/invitations/${invited.payload.id}/resend`,
    { method: "POST", body: {} }
  )
  assert.equal(resend.response.status, 201, JSON.stringify(resend.payload))
  assert.equal(resend.payload.membershipId, invited.payload.membershipId)
  assert.equal(resend.payload.id, invited.payload.id)
  assert.equal(
    fixture.invitations.filter((i) => i.status === "pending").length,
    1
  )
  fixture.invitations.find((i) => i.status === "pending").status = "accepted"
  const acceptedResend = await request(
    `/api/invitations/${invited.payload.id}/resend`,
    { method: "POST", body: {} }
  )
  assert.equal(acceptedResend.response.status, 201)
  assert.equal(acceptedResend.payload.id, invited.payload.id)
  assert.equal(
    fixture.invitations.filter((i) => i.status === "pending").length,
    0
  )
  // Mint a provider-authenticated session for the invited identity, while local membership remains pending.
  const row = (
    await db.query("SELECT user_id FROM memberships WHERE id=$1", [
      invited.payload.membershipId,
    ])
  ).rows[0]
  const { createSession } = await import("../src/lib/mca/sessions.ts")
  const sess = await createSession(row.user_id, invited.payload.membershipId)
  const repCookie = `mca_session=${sess.token}`
  const joined = await request("/api/auth/session", { cookie: repCookie })
  assert.equal(joined.response.status, 200, JSON.stringify(joined.payload))
  assert.equal(joined.payload.membership.role, "rep")
  assert.equal(
    (
      await request("/api/invitations", {
        cookie: repCookie,
        method: "POST",
        body: { email: "denied@example.test", name: "Denied", role: "admin" },
      })
    ).response.status,
    403
  )
  await db.query("UPDATE memberships SET status='deactivated' WHERE id=$1", [
    invited.payload.membershipId,
  ])
  assert.equal(
    (await request("/api/auth/session", { cookie: repCookie })).response.status,
    401
  )
})
test("seat races and direct cross-origin requests remain protected", async () => {
  await db.query("UPDATE workspaces SET seat_limit=2 WHERE id=$1", [
    owner.payload.membership.workspaceId,
  ])
  const results = await Promise.all(
    [1, 2].map((n) =>
      request("/api/invitations", {
        method: "POST",
        body: {
          email: `seat${n}@example.test`,
          name: `Seat ${n}`,
          role: "rep",
        },
      })
    )
  )
  assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409])
  assert.equal(
    (
      await request("/api/invitations", {
        method: "POST",
        body: { email: "cross@example.test", name: "Cross", role: "rep" },
        headers: { origin: "https://attacker.test" },
      })
    ).response.status,
    403
  )
})
test("a Neon failure after provider delivery preserves the reserved seat and can be resent", async () => {
  await db.query("UPDATE workspaces SET seat_limit=3 WHERE id=$1", [owner.payload.membership.workspaceId])
  await db.query("CREATE FUNCTION fail_clerk_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic mapping failure'; END $$")
  await db.query("CREATE TRIGGER fail_clerk_mapping BEFORE UPDATE OF clerk_invitation_id ON invitations FOR EACH ROW EXECUTE FUNCTION fail_clerk_mapping()")
  try {
    const failed = await request("/api/invitations", { method: "POST", body: { email: "retry@example.test", name: "Retry", role: "rep" } })
    assert.equal(failed.response.status, 500)
  } finally {
    await db.query("DROP TRIGGER fail_clerk_mapping ON invitations")
    await db.query("DROP FUNCTION fail_clerk_mapping()")
  }
  const rows = (await db.query("SELECT i.id, i.membership_id FROM invitations i JOIN memberships m ON m.id=i.membership_id WHERE i.email='retry@example.test' AND m.status='pending'")).rows
  assert.equal(rows.length, 1)
  assert.equal(fixture.invitations.filter((i) => i.email_address === "retry@example.test").length, 1)
  const retried = await request(`/api/invitations/${rows[0].id}/resend`, { method: "POST", body: {} })
  assert.equal(retried.response.status, 201, JSON.stringify(retried.payload))
  assert.equal(retried.payload.membershipId, rows[0].membership_id)
  assert.equal(retried.payload.id, rows[0].id)
  assert.equal(fixture.invitations.filter((i) => i.email_address === "retry@example.test" && i.status === "pending").length, 1)
})
test("signed webhook replay is harmless and invalid signatures are rejected", async () => {
  const event = {
    type: "user.updated",
    object: "event",
    data: { id: `user_${owner.payload.user.id}` },
  }
  const unsigned = await request("/api/webhooks/clerk", {
    method: "POST",
    body: event,
    cookie: null,
  })
  assert.equal(unsigned.response.status, 400)
  const id = "evt_fixture",
    time = String(Math.floor(Date.now() / 1000))
  const signature = createHmac("sha256", signingKey)
    .update(`${id}.${time}.${JSON.stringify(event)}`)
    .digest("base64")
  for (let i = 0; i < 2; i++) {
    const result = await request("/api/webhooks/clerk", {
      method: "POST",
      body: event,
      cookie: null,
      headers: {
        "svix-id": id,
        "svix-timestamp": time,
        "svix-signature": `v1,${signature}`,
      },
    })
    assert.equal(result.response.status, 200, JSON.stringify(result.payload))
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int count FROM clerk_webhook_events WHERE id=$1",
        [id]
      )
    ).rows[0].count,
    1
  )
})
