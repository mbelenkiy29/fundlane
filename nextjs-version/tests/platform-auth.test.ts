import test, { before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"

const providerId = randomUUID(), userId = randomUUID(), sessionId = randomUUID()
let signedIn = true
let aal = "aal1"
let claimSession = sessionId
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, { namedExports: {
  supabaseIdentity: async () => signedIn ? { user: { id: providerId }, sessionId } : null,
} })
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: {
  createSupabaseServerClient: async () => ({ auth: { getClaims: async () => ({ data: { claims: { sub: providerId, session_id: claimSession, aal } }, error: null }) } }),
} })
let requirePlatformAdmin: typeof import("../src/lib/mca/platform-auth").requirePlatformAdmin
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  ;({ requirePlatformAdmin } = await import("../src/lib/mca/platform-auth"))
  database = await createPostgresTestDatabase("platform_auth")
  process.env.DATABASE_URL = database.databaseUrl
  await getDatabase().prepare("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(userId, `${userId}@example.test`, "Platform test", `MCA-${userId}`, providerId, nowIso(), nowIso())
})
after(async () => { await closeDatabaseForTests(); await database?.close() })

test("platform access requires a live identity, explicit grant, and MFA for the same session", async () => {
  signedIn = false
  await assert.rejects(requirePlatformAdmin(), { code: "authentication_required" })
  signedIn = true
  aal = "aal2"
  await assert.rejects(requirePlatformAdmin(), { code: "platform_admin_required" })
  await getDatabase().prepare("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,?,?)").run(userId, nowIso(), "test-operator", "Test grant")
  aal = "aal1"
  await assert.rejects(requirePlatformAdmin(), { code: "mfa_required" })
  aal = "aal2"
  claimSession = randomUUID()
  await assert.rejects(requirePlatformAdmin(), { code: "mfa_required" })
  claimSession = sessionId
  assert.equal((await requirePlatformAdmin()).userId, userId)
  await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(), userId)
  await assert.rejects(requirePlatformAdmin(), { code: "platform_admin_required" })
})
