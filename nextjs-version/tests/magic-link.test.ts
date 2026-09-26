import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { before, beforeEach, mock, test } from "node:test"

let providerError: object | null = null
let providerThrows = false
let sent: { email: string; options: { shouldCreateUser: boolean; emailRedirectTo: string } } | null = null
const rateCalls: Array<{ key: string; limit: number }> = []
let blocked: string | null = null
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: {
  createSupabaseServerClient: async () => ({ auth: { signInWithOtp: async (input: NonNullable<typeof sent>) => { sent = input; if (providerThrows) throw new Error("Provider unavailable"); return { error: providerError } } } }),
} })
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: (request: Request) => { if (request.headers.get("origin") !== "https://app.example.test") throw new Error("Untrusted origin") },
  clientRateKey: () => "auth:magic-link:ip:test-ip",
  consumeRequestRateLimit: async (key: string, limit: number) => { rateCalls.push({ key, limit }); if (blocked && key.startsWith(blocked)) throw new (await import("../src/lib/mca/errors")).AppError(429, "rate_limit_exceeded", "Too many attempts.") },
} })
mock.module(new URL("../src/lib/mca/supabase-auth-http.ts", import.meta.url).href, { namedExports: { authOrigin: () => "https://app.example.test" } })
let post: typeof import("../src/app/api/auth/magic-link/route").POST
before(async () => { ({ POST: post } = await import("../src/app/api/auth/magic-link/route")) })
beforeEach(() => { delete process.env.MCA_MAGIC_LINK_ENABLED; sent = null; providerError = null; providerThrows = false; blocked = null; rateCalls.length = 0 })
const request = (email = " Person@Example.test ", next = "https://evil.test") => new Request("https://app.example.test/api/auth/magic-link", {
  method: "POST", headers: { origin: "https://app.example.test", "content-type": "application/json" }, body: JSON.stringify({ email, next }),
})

test("flag defaults off and the endpoint is unavailable", async () => {
  assert.equal((await post(request())).status, 404)
  assert.equal(sent, null)
  assert.deepEqual(rateCalls, [])
})

test("sign-in form renders the link option only when enabled", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { SignInForm } = require('./src/app/(auth)/sign-in/sign-in-form.tsx');
    console.log(JSON.stringify([false, true].map(magicLinkEnabled => renderToStaticMarkup(React.createElement(SignInForm, { magicLinkEnabled })))));
  `], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const [off, on] = JSON.parse(result.stdout) as string[]
  assert.doesNotMatch(off, /Email me a sign-in link/)
  assert.match(on, /Email me a sign-in link/)
})

test("enabled link cannot create an account and uses a sanitized same-origin callback", async () => {
  process.env.MCA_MAGIC_LINK_ENABLED = "true"
  const result = await post(request("person@example.test", "//evil.test"))
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { message: "If an account exists, we've sent a link." })
  assert.equal(sent?.email, "person@example.test")
  assert.equal(sent?.options.shouldCreateUser, false)
  const callback = new URL(sent!.options.emailRedirectTo)
  assert.equal(callback.origin, "https://app.example.test")
  assert.equal(callback.pathname, "/auth/callback")
  assert.equal(callback.searchParams.get("next"), "/onboarding")
  assert.equal(callback.searchParams.get("flow"), "magic-link")
  assert.equal(rateCalls.length, 2)
  assert.deepEqual(rateCalls.map(call => call.limit), [10, 3])
  assert.match(rateCalls[1].key, /^auth:magic-link:email:[a-f0-9]{64}$/)
  assert.ok(!rateCalls[1].key.includes("person@example.test"))
})

test("unknown account and provider errors have the identical public response", async () => {
  process.env.MCA_MAGIC_LINK_ENABLED = "true"
  const known = await post(request("person@example.test"))
  providerError = { status: 400, code: "user_not_found", message: "User not found" }
  const unknown = await post(request("person@example.test"))
  assert.equal(known.status, unknown.status)
  assert.deepEqual(await known.json(), await unknown.json())
  providerThrows = true
  const failed = await post(request("person@example.test"))
  assert.equal(failed.status, known.status)
  assert.deepEqual(await failed.json(), { message: "If an account exists, we've sent a link." })
})

test("IP and email limits block delivery", async () => {
  process.env.MCA_MAGIC_LINK_ENABLED = "true"
  for (const prefix of ["auth:magic-link:ip", "auth:magic-link:email"]) {
    blocked = prefix
    sent = null
    assert.equal((await post(request("person@example.test"))).status, 429)
    assert.equal(sent, null)
  }
})
