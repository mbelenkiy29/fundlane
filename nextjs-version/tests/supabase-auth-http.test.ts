import assert from "node:assert/strict"
import { before, beforeEach, mock, test } from "node:test"
import { AuthApiError, AuthWeakPasswordError } from "@supabase/supabase-js"
import { requestJson, RequestError } from "../src/lib/mca/client"
import { authErrorMessage } from "../src/lib/mca/auth-navigation"

let providerError: AuthApiError | AuthWeakPasswordError | null = null
let hasIdentity = true
let migrationPending = true
let recoveryRedirect = ""
const calls: string[] = []
const invitationToken = "a".repeat(64)
mock.module(new URL("../src/lib/mca/supabase-team.ts", import.meta.url).href, { namedExports: {
  inspectSupabaseInvitation: async (token: string) => {
    assert.equal(token, invitationToken)
    calls.push("invitation")
    return { email: "synthetic@example.test", workspace_name: "Inviting company" }
  },
} })
const client = { auth: {
  signUp: async () => { calls.push("signup"); return { data: { session: null }, error: providerError } },
  updateUser: async () => { calls.push("password"); return { error: providerError } },
  resetPasswordForEmail: async (_email: string, options: { redirectTo: string }) => { recoveryRedirect = options.redirectTo; return { error: providerError } },
  signOut: async ({ scope }: { scope: string }) => { calls.push(`signout:${scope}`); return { error: null } },
  refreshSession: async () => { calls.push("refresh"); return { error: null } },
} }
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: {
  createSupabaseServerClient: async () => client,
  getSupabaseAdminClient: () => ({ auth: { admin: { updateUserById: async (id: string, input: unknown) => {
    assert.equal(id, "synthetic-user")
    assert.deepEqual(input, { app_metadata: { mca_migration_pending: false, mca_user_id: "local-user" } })
    calls.push("metadata"); return { error: null }
  } } } }),
} })
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: () => {}, clientRateKey: () => "test", consumeRequestRateLimit: async () => {},
} })
mock.module(new URL("../src/lib/mca/db.ts", import.meta.url).href, { namedExports: {
  getDatabase: () => { throw new Error("These tests must not access a database") },
  nowIso: () => "2026-09-16T00:00:00.000Z", newId: () => "synthetic-id",
} })
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, { namedExports: {
  WORKSPACE_COOKIE: "mca_workspace",
  supabaseIdentity: async (options: unknown) => {
    assert.deepEqual(options, { allowPasswordSetup: true })
    return hasIdentity ? { user: { id: "synthetic-user", app_metadata: { mca_migration_pending: migrationPending, mca_user_id: "local-user" } } } : null
  },
} })
let handleSupabaseAuth: typeof import("../src/lib/mca/supabase-auth-http").handleSupabaseAuth
before(async () => { ({ handleSupabaseAuth } = await import("../src/lib/mca/supabase-auth-http")) })
const input = { email: "synthetic@example.test", name: "Synthetic owner", companyName: "Synthetic company", password: "Synthetic password 123!" }
const pwnedMessage = "This password has appeared in a data breach. Choose a different, unique password."
type Action = Parameters<typeof handleSupabaseAuth>[1]
function request(action: Action, body: unknown = input) {
  return handleSupabaseAuth(new Request("http://localhost/api/auth/test", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }), action)
}
beforeEach(() => { delete process.env.MCA_SIGNUP_MODE; providerError = null; hasIdentity = true; migrationPending = true; calls.length = 0 })

test("company sign-up stays open by default and rejects invite-only before calling Supabase", async () => {
  assert.equal((await request("company-signup")).status, 200)
  assert.deepEqual(calls, ["signup"])
  calls.length = 0
  process.env.MCA_SIGNUP_MODE = "invite_only"
  const blocked = await request("company-signup")
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).error.code, "signup_invite_only")
  assert.deepEqual(calls, [])
  const mismatch = await request("company-signup", { ...input, email: "other@example.test", next: `/accept-invite?token=${invitationToken}` })
  assert.equal(mismatch.status, 403)
  assert.equal((await mismatch.json()).error.code, "invitation_account_mismatch")
  assert.deepEqual(calls, ["invitation"])
  calls.length = 0
  const invited = await request("company-signup", { ...input, next: `/accept-invite?token=${invitationToken}` })
  assert.equal(invited.status, 200)
  assert.deepEqual(calls, ["invitation", "signup"])
})

test("recovery request encodes a safe invitation destination through password setup", async () => {
  const invitation = `/accept-invite?token=${"c".repeat(64)}`
  assert.equal((await request("recovery-request", { email: input.email, next: invitation })).status, 200)
  const callback = new URL(recoveryRedirect)
  assert.equal(callback.pathname, "/auth/callback")
  assert.equal(callback.searchParams.getAll("next").length, 1)
  const reset = new URL(callback.searchParams.get("next")!, callback.origin)
  assert.equal(reset.pathname, "/reset-password")
  assert.equal(reset.searchParams.get("next"), invitation)
  for (const next of ["https://evil.test", "//evil.test", "/\\evil.test", "/reset-password?next=//evil.test"]) {
    assert.equal((await request("recovery-request", { email: input.email, next })).status, 200)
    const redirect = new URL(recoveryRedirect)
    assert.equal(new URL(redirect.searchParams.get("next")!, redirect.origin).searchParams.get("next"), "/onboarding")
  }
})

for (const action of ["company-signup", "recovery-reset"] as const) {
  for (const reasons of [["pwned"], ["length", "pwned"], ["length"], ["characters"], []] as Array<Array<"pwned" | "length" | "characters">>) {
    test(`${action}: weak password ${reasons.join(",") || "without reasons"} is actionable and has no success side effects`, async () => {
      providerError = new AuthWeakPasswordError("Provider text should not leak through", 422, reasons)
      const response = await request(action)
      assert.equal(response.status, 400)
      const { error } = await response.json()
      assert.equal(error.code, "weak_password")
      assert.equal(error.message, reasons.includes("pwned") ? pwnedMessage : reasons.includes("length")
        ? "Choose a longer password with at least 12 characters." : reasons.includes("characters")
          ? "Choose a password with uppercase and lowercase letters, numbers, and symbols."
          : "This password does not meet the security requirements. Choose a stronger, unique password with at least 12 characters.")
      assert.deepEqual(error.fieldErrors, { password: [error.message] })
      assert.deepEqual(calls, [action === "company-signup" ? "signup" : "password"])
    })
  }
  test(`${action}: unknown reasons and code-only errors use safe guidance`, async () => {
    for (const error of [new AuthApiError("Raw provider text", 422, "weak_password"), Object.assign(new AuthApiError("Raw provider text", 422, "weak_password"), { reasons: ["future_rule"] })]) {
      providerError = error
      const response = await request(action)
      assert.equal(response.status, 400)
      assert.match((await response.json()).error.message, /stronger, unique password/)
    }
  })
  test(`${action}: failed password can be retried successfully`, async () => {
    providerError = new AuthWeakPasswordError("Compromised", 422, ["pwned"])
    assert.equal((await request(action)).status, 400)
    providerError = null; calls.length = 0
    const response = await request(action, { ...input, password: "A different synthetic password 456!" })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), action === "company-signup" ? { success: true, verificationRequired: true } : { success: true })
    assert.deepEqual(calls, action === "company-signup" ? ["signup"] : ["password", "metadata", "signout:others", "refresh"])
  })
  test(`${action}: length limits return guidance before provider calls`, async () => {
    for (const [password, message] of [["short", "Use a password with at least 12 characters."], ["x".repeat(257), "Use a password with no more than 256 characters."]]) {
      const response = await request(action, { ...input, password })
      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), { error: { code: "validation_failed", message, fieldErrors: { password: [message] } } })
    }
    assert.deepEqual(calls, [])
    for (const password of ["x".repeat(12), "x".repeat(256)]) assert.equal((await request(action, { ...input, password })).status, 200)
  })
  test(`${action}: unrelated and rate-limit errors retain existing behavior`, async () => {
    for (const [status, code, message] of [[400, "same_password", "Choose a different password."], [429, "over_request_rate_limit", "Please try again later."]] as const) {
      providerError = new AuthApiError(message, status, code)
      const response = await request(action)
      assert.equal(response.status, status)
      assert.deepEqual(await response.json(), { error: { code: "authentication_failed", message } })
    }
  })
}
test("reset without a recovery identity cannot update password or run side effects", async () => {
  hasIdentity = false
  const response = await request("recovery-reset")
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, "recovery_required")
  assert.deepEqual(calls, [])
})
test("ordinary reset skips migration metadata but revokes other sessions and refreshes", async () => {
  migrationPending = false
  assert.equal((await request("recovery-reset")).status, 200)
  assert.deepEqual(calls, ["password", "signout:others", "refresh"])
})
test("recovery requests remain account neutral while outages and rate limits remain visible", async () => {
  for (const error of [null, new AuthApiError("Unknown account", 400, "user_not_found")]) {
    providerError = error
    const response = await request("recovery-request", { email: input.email })
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true })
  }
  for (const status of [429, 503]) {
    providerError = new AuthApiError("Try again later.", status, "unexpected_failure")
    assert.equal((await request("recovery-request")).status, status === 429 ? 429 : 400)
  }
})
test("requestJson and form error formatter preserve the actionable weak-password message", async t => {
  providerError = new AuthWeakPasswordError("Compromised", 422, ["pwned"])
  t.mock.method(globalThis, "fetch", async () => request("company-signup"))
  await assert.rejects(requestJson("/api/auth/company-signup"), error => {
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, "weak_password")
    assert.equal(authErrorMessage(error), pwnedMessage)
    return true
  })
})
