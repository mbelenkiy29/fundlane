import test, { before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { randomUUID, randomBytes } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, nowIso, closeDatabaseForTests } from "../src/lib/mca/db"

const owners = ["mike", "ben"].map(name => ({ userId: randomUUID(), providerId: randomUUID(), sessionId: randomUUID(), email: `${name}@sentineltechsolutions.io` }))
let owner = owners[0], confirmed = true, signedIn = true, aal = "aal2", wrongSession = false
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, { namedExports: {
  supabaseIdentity: async () => signedIn && confirmed ? { user: { id: owner.providerId, email: owner.email, email_confirmed_at: nowIso() }, email: owner.email, sessionId: owner.sessionId } : null,
} })
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: {
  createSupabaseServerClient: async () => ({ auth: {
    getClaims: async () => ({ data: { claims: { sub: owner.providerId, session_id: wrongSession ? randomUUID() : owner.sessionId, aal } }, error: null }),
    getUser: async () => ({ data: { user: signedIn ? { id: owner.providerId, email: owner.email, email_confirmed_at: confirmed ? nowIso() : null } : null }, error: null }),
  } }),
} })
// Client components are not executed by these server entry-point tests.
mock.module(new URL("../src/components/mca/operations/status-dashboard.tsx", import.meta.url).href, { namedExports: { StatusDashboard: () => null } })
mock.module(new URL("../src/components/mca/platform/sms-review.tsx", import.meta.url).href, { defaultExport: () => null })
mock.module("next/link", { defaultExport: () => null })
mock.module("next/navigation", { namedExports: {
  redirect: (path: string) => { throw new Error(`redirect:${path}`) },
  notFound: () => { throw new Error("not-found") },
} })
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let auth: typeof import("../src/lib/mca/platform-auth")
let sms: typeof import("../src/lib/mca/sms/onboarding")
let handlers: Array<(request: Request) => Promise<Response>>
const workspaceId = randomUUID(), oldEnv = { ...process.env }
const request = (apiKey = false) => new Request("https://app.test/api/admin/status", { headers: apiKey ? { authorization: "Bearer mca_test" } : {} })
before(async () => {
  fixture = await createPostgresTestDatabase("owner_parity")
  process.env.DATABASE_URL = fixture.databaseUrl
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_PLATFORM_OWNER_USER_ID = owners[0].providerId
  delete process.env.MCA_SUPER_ADMIN_EMAILS
  delete process.env.MCA_SUPER_ADMIN_SMS_APPROVER_EMAILS
  delete process.env.MCA_PLATFORM_OPERATOR_USER_IDS
  auth = await import("../src/lib/mca/platform-auth")
  sms = await import("../src/lib/mca/sms/onboarding")
  handlers = [
    (await import("../src/app/api/admin/status/route")).GET,
    (await import("../src/app/api/admin/status/errors/route")).GET,
    (await import("../src/app/api/mca/sms/operator/route")).GET,
    (await import("../src/app/api/platform/companies/route")).GET,
  ]
  const stamp = nowIso()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(workspaceId, "Synthetic owner parity", "America/New_York", 2, "{}", "{}", "{}", stamp, stamp)
  for (const user of owners) {
    await getDatabase().prepare("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(user.userId, user.email, "Synthetic owner", `MCA-${user.userId}`, user.providerId, stamp, stamp)
    await getDatabase().prepare("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,?,?)").run(user.userId, stamp, "trusted-operator", "Synthetic test")
    await getDatabase().prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), workspaceId, user.userId, "admin", "active", stamp, stamp)
  }
  await getDatabase().prepare("INSERT INTO sms_companies(workspace_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?)").run(workspaceId, owners[0].userId, stamp, stamp)
})
after(async () => {
  await closeDatabaseForTests(); await fixture?.close()
  for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
  Object.assign(process.env, oldEnv)
})

test("both granted owners can read platform and legacy monitoring/SMS routes", async () => {
  for (owner of owners) for (const handler of handlers) assert.equal((await handler(request())).status, 200, `${owner.email} ${handler}`)
})

test("new and legacy routes enforce grants, identity, session MFA, and reject API keys", async () => {
  owner = owners[0]
  const denied = async (status: number, code: string, apiKey = false) => {
    for (const handler of handlers) {
      const response = await handler(request(apiKey))
      assert.equal(response.status, status)
      assert.equal((await response.json()).error.code, code)
    }
  }
  try {
    await denied(403, "super_admin_required", true)
    signedIn = false; await denied(401, "authentication_required"); signedIn = true
    confirmed = false; await denied(403, "super_admin_required"); confirmed = true
    aal = "aal1"; await denied(403, "mfa_required"); aal = "aal2"
    wrongSession = true; await denied(403, "mfa_required"); wrongSession = false
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(), owner.userId)
    for (const role of ["admin", "super_admin"]) {
      await getDatabase().prepare("UPDATE memberships SET role=? WHERE user_id=?").run(role, owner.userId)
      await denied(403, "platform_admin_required")
    }
  } finally {
    signedIn = confirmed = true; aal = "aal2"; wrongSession = false
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?").run(owner.userId)
  }
})

test("both owners need a fresh session-bound step-up for SMS approval and rejection", async () => {
  const input = { workspaceId, decision: "rejected" as const, note: "Synthetic review evidence", numberLimit: 1, monthlyLimitCents: 100, registrationLimitCents: 100 }
  for (owner of owners) {
    const actor = await auth.requireSuperAdmin()
    auth.requireSmsApprover(actor)
    for (const decision of ["approved", "rejected"] as const) {
      await assert.rejects(sms.reviewCompany(null, { ...input, decision }), { code: "step_up_required" })
    }
    await getDatabase().prepare("INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)").run(owner.sessionId, owner.userId, "2000-01-01T00:00:00.000Z")
    await assert.rejects(sms.reviewCompany(null, input), { code: "step_up_required" })
    await getDatabase().prepare("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?").run(nowIso(), owner.sessionId)
    assert.deepEqual(await sms.reviewCompany(null, input), { updated: true })
    const { encryptSensitive } = await import("../src/lib/mca/crypto")
    const profile = sms.profileSchema.parse({
      businessType: "Limited Liability Corporation", contactPosition: "CEO", contactTitle: "Chief executive",
      legalName: "Synthetic Business", ein: "12-3456789", street: "100 Test Road", city: "New York", region: "NY", postalCode: "10001",
      website: "https://example.test", contactFirstName: "Test", contactLastName: "Owner", contactEmail: "owner@example.test", contactPhone: "+12125551234",
      purpose: "Requested application status updates only, never unsolicited loan offers.",
      samples: ["Your requested application is ready for review.", "Please provide documents for your requested application."],
      consentEvidence: "Customers explicitly request application text updates on our first-party form.",
      privacyUrl: "https://example.test/privacy", termsUrl: "https://example.test/terms", applicationUpdatesOnly: true,
    })
    await getDatabase().prepare("UPDATE sms_companies SET email_verified_at=?,profile_cipher=? WHERE workspace_id=?").run(nowIso(), encryptSensitive(JSON.stringify(profile), workspaceId), workspaceId)
    assert.deepEqual(await sms.reviewCompany(null, { ...input, decision: "approved" }), { updated: true })
    assert.equal((await getDatabase().prepare<{ review_state: string; reviewed_by: string }>("SELECT review_state,reviewed_by FROM sms_companies WHERE workspace_id=?").get(workspaceId))?.reviewed_by, owner.userId)
    assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM platform_admin_audit WHERE actor_user_id=? AND action='sms.rejected'").get(owner.userId))?.n, 1)
  }
})

test("explicit SMS and operator ceilings can still narrow but never create authority", async () => {
  owner = owners[1]
  process.env.MCA_SUPER_ADMIN_SMS_APPROVER_EMAILS = owners[0].email
  assert.throws(() => auth.requireSmsApprover({ ...owner, supabaseUserId: owner.providerId }), { code: "sms_approver_required" })
  delete process.env.MCA_SUPER_ADMIN_SMS_APPROVER_EMAILS
  process.env.MCA_PLATFORM_OPERATOR_USER_IDS = owners[0].userId
  await assert.rejects(sms.operator(), { code: "platform_operator_required" })
  delete process.env.MCA_PLATFORM_OPERATOR_USER_IDS
})

// Removing the page guard would expose a render/redirect to any synthetic identity.
test("portal and legacy pages gate direct URLs and redirect authorized owners into one shell", async () => {
  // Load through runtime paths so the red run reports the missing entry point as an assertion.
  const loadPage = async (path: string) => {
    const mod = await import(path).catch(() => null)
    assert.ok(mod, `Missing portal page: ${path}`)
    return mod.default as () => Promise<unknown>
  }
  const monitoring = await loadPage("../src/app/platform/monitoring/page.tsx")
  const smsPage = await loadPage("../src/app/platform/sms/page.tsx")
  const legacyStatus = await loadPage("../src/app/admin/status/page.tsx")
  const legacySms = await loadPage("../src/app/(dashboard)/settings/sms-review/page.tsx")
  const { default: layout } = await import("../src/app/platform/layout")
  const pages = [monitoring, smsPage, legacyStatus, legacySms, () => layout({ children: null })]
  for (owner of owners) {
    assert.ok(await monitoring()); assert.ok(await smsPage())
    await assert.rejects(legacyStatus(), /redirect:\/platform\/monitoring/)
    await assert.rejects(legacySms(), /redirect:\/platform\/sms/)
    const links: string[] = []
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== "object" || !("props" in node)) return
      const props = (node as { props: { href?: string; children?: unknown } }).props
      if (props.href) links.push(props.href)
      visit(props.children)
    }
    visit(await layout({ children: null }))
    assert.ok(links.includes("/platform/monitoring")); assert.ok(links.includes("/platform/sms"))
    assert.equal((await getDatabase().prepare<{ n: number }>("SELECT count(*)::int n FROM platform_admin_audit WHERE actor_user_id=? AND action='super_admin.first_access'").get(owner.userId))?.n, 1)
  }
  try {
    signedIn = false
    for (const page of pages) await assert.rejects(page(), /redirect:\/sign-in/)
    signedIn = true; aal = "aal1"
    for (const page of pages) await assert.rejects(page(), /redirect:\/account-security/)
    aal = "aal2"; confirmed = false
    for (const page of pages) await assert.rejects(page(), /redirect:\/errors\/forbidden/)
    confirmed = true; wrongSession = true
    for (const page of pages) await assert.rejects(page(), /redirect:\/account-security/)
    wrongSession = false
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(), owner.userId)
    for (const page of pages) await assert.rejects(page(), /redirect:\/errors\/forbidden/)
  } finally {
    signedIn = confirmed = true; aal = "aal2"; wrongSession = false
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?").run(owner.userId)
  }
})

test("ordinary app navigation offers the same portal entry only to authorized owners", async () => {
  const { getSessionResponse } = await import("../src/lib/mca/sessions")
  for (owner of owners) {
    const membership = await getDatabase().prepare<{ id: string }>("SELECT id FROM memberships WHERE user_id=? AND workspace_id=?").get(owner.userId, workspaceId)
    const context = { membershipId: membership!.id, workspaceId } as Parameters<typeof getSessionResponse>[0]
    assert.equal((await getSessionResponse(context)).platformOwner, true)
    aal = "aal1"
    try { assert.equal((await getSessionResponse(context)).platformOwner, false) }
    finally { aal = "aal2" }
  }
})
