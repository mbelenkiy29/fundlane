import test, { before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"

const require = createRequire(import.meta.url)
// Use the real client React runtime for imported client components under the server test condition.
const react = require(join(dirname(require.resolve("react/package.json")), "index.js"))
mock.module("react", { namedExports: react, defaultExport: react })
mock.module("react/jsx-runtime", { namedExports: require(join(dirname(require.resolve("react/package.json")), "jsx-runtime.js")) })

mock.module("react-dom", { namedExports: require(join(dirname(require.resolve("react-dom/package.json")), "index.js")) })

const providerId = randomUUID(), userId = randomUUID(), firstSession = randomUUID()
let sessionId = firstSession, email = "mike@sentineltechsolutions.io", confirmed = true, signedIn = true
const aal = "aal1"
mock.module("next/headers", { namedExports: { cookies: async () => ({ get: () => undefined, set: () => {} }) } })
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: {
  getSupabaseAdminClient: () => ({}),
  createSupabaseServerClient: async () => ({ auth: {
    getUser: async () => ({ data: { user: signedIn ? { id: providerId, email, email_confirmed_at: confirmed ? nowIso() : null, app_metadata: {}, user_metadata: {} } : null }, error: null }),
    mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) },
    getClaims: async () => ({ data: { claims: { sub: providerId, session_id: sessionId, aal } }, error: null }),
  } }),
} })
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let page: typeof import("../src/app/(auth)/onboarding/page")
let security: typeof import("../src/app/(auth)/account-security/page")
let platformPage: typeof import("../src/lib/mca/platform-page-access")
let auth: typeof import("../src/lib/mca/platform-auth")
mock.module("next/navigation", { namedExports: { redirect: (path: string) => { throw new Error(`redirect:${path}`) }, useSearchParams: () => new URLSearchParams() } })
const oldEnv = { ...process.env }
before(async () => {
  fixture = await createPostgresTestDatabase("owner_continuation")
  process.env.DATABASE_URL = fixture.databaseUrl
  process.env.MCA_SUPER_ADMIN_EMAILS = "mike@sentineltechsolutions.io,ben@sentineltechsolutions.io"
  const db = getDatabase()
  await db.prepare("CREATE TABLE mca_private.auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)").run()
  await db.prepare("INSERT INTO mca_private.auth_sessions VALUES (?,?,now()+interval '1 hour')").run(sessionId, providerId)
  await db.prepare("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(userId, email, "Synthetic owner", `MCA-${userId}`, providerId, nowIso(), nowIso())
  await db.prepare("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,?,?)").run(userId, nowIso(), "test", "Synthetic grant")
  page = await import("../src/app/(auth)/onboarding/page")
  auth = await import("../src/lib/mca/platform-auth")
  platformPage = await import("../src/lib/mca/platform-page-access")
  security = await import("../src/app/(auth)/account-security/page")
})
after(async () => {
  await closeDatabaseForTests(); await fixture?.close()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})
const visit = (params: Record<string, string> = {}) => page.default({ searchParams: Promise.resolve(params) })
const continues = () => assert.rejects(visit(), { message: "redirect:/platform" })

test("owner without a company continues to platform while incomplete MFA still denies access", async () => {
  await continues()
  await assert.rejects(auth.requireSuperAdmin(), { code: "mfa_required" })
  await assert.rejects(platformPage.requirePlatformPage(), { message: "redirect:/account-security?returnTo=%2Fplatform" })

})

test("completed MFA and repeated or interrupted onboarding retain owner continuation", async () => {
  await getDatabase().prepare("INSERT INTO auth_session_totp(session_id,user_id,method,verified_at,created_at) VALUES (?,?,'totp',?,?)").run(sessionId, userId, nowIso(), nowIso())
  assert.equal((await auth.requireSuperAdmin()).userId, userId)
  assert.equal((await platformPage.requirePlatformPage()).userId, userId)
  for (let i = 0; i < 3; i++) await continues()
  const workspaceId = randomUUID(), stamp = nowIso()
  await getDatabase().prepare("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(workspaceId, "Synthetic company", "UTC", 1, "{}", "{}", "{}", stamp, stamp)
  await getDatabase().prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)").run(randomUUID(), workspaceId, userId, stamp, stamp)
  await continues()
  await assert.doesNotReject(visit({ switch: "1" }))
  await assert.doesNotReject(visit({ setup: "1" }))
})

test("fresh session needs its own MFA and expired session loses continuation", async () => {
  sessionId = randomUUID()
  await getDatabase().prepare("INSERT INTO mca_private.auth_sessions VALUES (?,?,now()+interval '1 hour')").run(sessionId, providerId)
  await continues()
  await assert.rejects(auth.requireSuperAdmin(), { code: "mfa_required" })
  await assert.rejects(platformPage.requirePlatformPage(), { message: "redirect:/account-security?returnTo=%2Fplatform" })
  await getDatabase().prepare("UPDATE mca_private.auth_sessions SET not_after=now()-interval '1 minute' WHERE id=?").run(sessionId)
  await assert.doesNotReject(visit())
  await assert.rejects(auth.requireSuperAdmin(), { code: "authentication_required" })
  sessionId = firstSession
})

function mfaProps(element: unknown): Record<string, unknown> | undefined {
  if (!element || typeof element !== "object") return undefined
  const node = element as { type?: { name?: string }; props?: { children?: unknown } }
  if (node.type?.name === "MfaForm") return node.props as Record<string, unknown>
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = mfaProps(child)
    if (result) return result
  }
}

test("security gives the owner one platform continuation and a challenge after interruption", async () => {
  const props = mfaProps(await security.default({ searchParams: Promise.resolve({}) }))
  assert.equal(props?.continueTo, "/platform")
  assert.equal(props?.mode, "challenge")
})

test("explicit enrollment intent survives owner MFA without changing platform authority", async () => {
  const next = "/enrollment?enrollment=10000000-0000-4000-8000-000000000001&destination=business&generation=2"
  const props = mfaProps(await security.default({ searchParams: Promise.resolve({ next, challenge: "1" }) }))
  assert.equal(props?.continueTo, next)
  assert.equal(props?.mode, "challenge")
  assert.equal(mfaProps(await security.default({ searchParams: Promise.resolve({ next: "https://evil.test", challenge: "1" }) }))?.continueTo, "/platform")
})

test("revocation, unconfirmed identity and email ceiling cannot authorize owner continuation", async () => {
  await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(), userId)
  await assert.doesNotReject(visit({ returnTo: "/platform", owner: "1" }))
  await assert.rejects(auth.requireSuperAdmin(), { code: "platform_admin_required" })
  assert.equal(mfaProps(await security.default({ searchParams: Promise.resolve({}) }))?.continueTo, "/onboarding")
  await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?").run(userId)
  email = "outside@example.test"
  await assert.doesNotReject(visit())
  const props = mfaProps(await security.default({ searchParams: Promise.resolve({}) }))
  assert.equal(props?.continueTo, "/onboarding")
  email = "mike@sentineltechsolutions.io"; confirmed = false
  await assert.doesNotReject(visit())
  confirmed = true; signedIn = false
  await assert.doesNotReject(visit())
  signedIn = true
})


test("untrusted continuation parameters never become navigation destinations", async () => {
  for (const returnTo of ["https://evil.test", "//evil.test", "/\\evil.test", "/%2f%2fevil.test", "/platform"]) {
    await assert.rejects(visit({ returnTo }), { message: "redirect:/platform" })
    const searchParams = Promise.resolve({ returnTo, required: "1" })
    assert.equal(mfaProps(await security.default({ searchParams }))?.continueTo, "/platform")
  }
})


test("Google tenant exemption does not report the owner session as MFA verified", async () => {
  const { GET } = await import("../src/app/api/auth/mfa/route")
  await getDatabase().prepare("UPDATE auth_session_totp SET method='google' WHERE session_id=?").run(sessionId)
  const google = await (await GET()).json()
  assert.equal(google.sessionVerified, true)
  assert.equal(google.platformVerified, false)
  await assert.rejects(auth.requireSuperAdmin(), { code: "mfa_required" })
  await getDatabase().prepare("UPDATE auth_session_totp SET method='totp' WHERE session_id=?").run(sessionId)
  assert.equal((await (await GET()).json()).platformVerified, true)
})
