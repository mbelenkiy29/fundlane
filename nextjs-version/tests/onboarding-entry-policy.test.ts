import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, beforeEach, mock, test } from "node:test"
import { authDatabase, liveIdentity, provider, resetAuthProvider } from "./helpers/onboarding-auth"
import { getDatabase } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"

const billingMock = { cache: false, exports: {
  billingEnabled: () => false, billingTrialDays: () => 14, createOnboardingCheckoutUrl: async () => undefined,
  isStripeCheckoutTrialConfigured: () => false, stripeTrialLifecycleEnabled: () => false,
} }
mock.module(new URL("../src/lib/mca/billing.ts", import.meta.url).href, billingMock)
let dispose: () => Promise<void>
let auth: typeof import("../src/lib/mca/supabase-auth")
let route: typeof import("../src/app/api/onboarding/route")
before(async () => { dispose = await authDatabase("entry_policy"); auth = await import("../src/lib/mca/supabase-auth"); route = await import("../src/app/api/onboarding/route") })
after(async () => { await dispose?.() })
beforeEach(() => { resetAuthProvider(); process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "true"; process.env.MCA_STRIPE_BILLING_ENABLED = "false"; process.env.MCA_SIGNUP_MODE = "open" })
function post(body: unknown) { return route.POST(new Request("https://fundlane.test/api/onboarding", { method: "POST", headers: { origin: "https://fundlane.test", "content-type": "application/json" }, body: JSON.stringify(body) })) }
async function count(table: "workspaces" | "users") { return Number((await getDatabase().queryOne<{ count: string }>(`SELECT count(*) count FROM ${table}`))?.count) }

test("dedicated rollout denies verified Google identity-only legacy creation even when provider config is off", async () => {
  const identity = await liveIdentity(`${randomUUID()}@example.test`)
  identity.user.app_metadata.provider = "google"
  identity.user.user_metadata = { name: "Google user", companyName: "Forged legacy company" }
  const workspaces = await count("workspaces"), users = await count("users")
  await assert.rejects(auth.completeCompanyOnboarding("Forged legacy company"), { code: "signup_enrollment_required" })
  assert.equal(await count("workspaces"), workspaces)
  assert.equal(await count("users"), users)
})

test("direct onboarding HTTP cannot use next switch setup or company metadata to create a legacy trial", async () => {
  await liveIdentity(`${randomUUID()}@example.test`)
  const before = await count("workspaces")
  const result = await post({ name: "Synthetic bypass", next: "/onboarding", switch: "1", setup: "1" })
  assert.equal(result.status, 403)
  assert.equal((await result.json()).error.code, "signup_enrollment_required")
  assert.equal(await count("workspaces"), before)
  const read = await route.GET()
  assert.equal((await read.json()).stripeFirstRequired, true)
})

test("owned durable legacy company reuse and workspace selection survive creation-off rollout", async () => {
  const identity = await liveIdentity(`${randomUUID()}@example.test`)
  const owner = await createWorkspaceWithAdmin({ workspaceName: "Durable legacy", adminName: "Owner", adminEmail: identity.email, password: "Synthetic unused 123!", role: "admin" })
  await getDatabase().execute("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,now())", [owner.workspaceId, owner.membershipId])
  identity.user.app_metadata.mca_user_id = owner.userId
  // Only a server-controlled migration mapping can connect this durable owner.
  await auth.linkSupabaseUser(identity)
  const before = await count("workspaces")
  const reused = await auth.completeCompanyOnboarding("durable LEGACY")
  assert.equal(reused.workspaceId, owner.workspaceId)
  assert.equal(await count("workspaces"), before)
  const selected = await post({ workspaceId: owner.workspaceId })
  assert.equal(selected.status, 200)
  assert.equal((await selected.json()).workspaceId, owner.workspaceId)
  await assert.rejects(auth.completeCompanyOnboarding("Another company"), { code: "signup_enrollment_required" })
  await assert.rejects(auth.setActiveWorkspace(identity, randomUUID()), { code: "membership_inactive" })
  await getDatabase().execute("UPDATE memberships SET status='deactivated' WHERE id=?", [owner.membershipId])
  await assert.rejects(auth.completeCompanyOnboarding("Durable legacy"), { code: "signup_enrollment_required" })
})

test("ordinary legacy company provisioning remains available when dedicated rollout is off", async () => {
  process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "false"
  await liveIdentity(`${randomUUID()}@example.test`)
  const result = await auth.completeCompanyOnboarding("Legacy rollout off")
  assert.ok(result.workspaceId)
  assert.equal(result.role, "admin")
  assert.ok(provider.current)
})
