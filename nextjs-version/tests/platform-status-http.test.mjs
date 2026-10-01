import test, { mock, before, after } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
const ownerIdentity = { user: { id: "10000000-0000-0000-0000-000000000001", email_confirmed_at: "2026-01-01T00:00:00Z" }, email: "mike@sentineltechsolutions.io", sessionId: "owner-session" }
let identity = null,
  unavailable = false
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, {
  namedExports: {
    supabaseIdentity: async () => {
      if (unavailable) throw new Error("secret provider error")
      return identity
    },
  },
})
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, {
  namedExports: { createSupabaseServerClient: async () => ({ auth: {
    getClaims: async () => ({ data: { claims: { sub: identity?.user.id, session_id: identity?.sessionId, aal: "aal2" } }, error: null }),
    getUser: async () => ({ data: { user: identity?.user ?? null }, error: null }),
  } }) },
})
const { GET: status } = await import("../src/app/api/admin/status/route.ts")
const { GET: errors } =
  await import("../src/app/api/admin/status/errors/route.ts")
const { closeDatabaseForTests } = await import("../src/lib/mca/db.ts")
let db
before(async () => {
  db = await createPostgresTestDatabase("ops_http")
  process.env.DATABASE_URL = db.databaseUrl
  await db.query("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES ('owner-local','mike@sentineltechsolutions.io','Synthetic owner','MCA-owner','10000000-0000-0000-0000-000000000001',now(),now())")
  await db.query("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES ('owner-local',now(),'test','Synthetic grant')")
})
after(async () => {
  await closeDatabaseForTests()
  await db?.close()
})
test("direct endpoints reject unauthenticated, company admins, revoked sessions and unavailable identity", async () => {
  for (const handler of [status, errors]) {
    identity = null
    assert.equal(
      (await handler(new Request("https://fundlane.io/api/admin/status")))
        .status,
      401
    )
    for (const role of ["admin", "super_admin"]) {
      identity = { user: { id: "10000000-0000-0000-0000-000000000002", role } }
      assert.equal(
        (await handler(new Request("https://fundlane.io/api/admin/status")))
          .status,
        403
      )
    }
    identity = ownerIdentity
    const success = await handler(
      new Request("https://fundlane.io/api/admin/status")
    )
    assert.equal(success.status, 200)
    assert.match(success.headers.get("cache-control"), /no-store/)
    identity = null
    assert.equal(
      (await handler(new Request("https://fundlane.io/api/admin/status")))
        .status,
      401
    )
    unavailable = true
    const failed = await handler(
      new Request("https://fundlane.io/api/admin/status")
    )
    assert.equal(failed.status, 500)
    assert.equal((await failed.text()).includes("secret"), false)
    unavailable = false
  }
})
test("owner endpoint validates filters and caps error pagination", async () => {
  identity = ownerIdentity
  assert.equal(
    (
      await status(
        new Request("https://fundlane.io/api/admin/status?window=all")
      )
    ).status,
    400
  )
  assert.equal(
    (
      await errors(
        new Request("https://fundlane.io/api/admin/status/errors?before=bad")
      )
    ).status,
    400
  )
  assert.equal(
    (
      await errors(
        new Request(
          "https://fundlane.io/api/admin/status/errors?component=password"
        )
      )
    ).status,
    400
  )
  await db.query(
    "INSERT INTO mca_private.ops_errors(id,component,code) SELECT gen_random_uuid(),'api','internal_error' FROM generate_series(1,51)"
  )
  const first = await (
    await errors(new Request("https://fundlane.io/api/admin/status/errors"))
  ).json()
  assert.equal(first.errors.length, 50)
  assert.ok(first.next)
  const second = await (
    await errors(
      new Request(
        `https://fundlane.io/api/admin/status/errors?before=${first.next}`
      )
    )
  ).json()
  assert.equal(second.errors.length, 1)
  assert.equal(second.next, null)
  assert.ok(!first.errors.some((a) => a.id === second.errors[0].id))
})
