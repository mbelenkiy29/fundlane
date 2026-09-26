import test, { before, mock } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { authContinuation, callbackDestination, recoveryDestination } from "../src/lib/mca/auth-navigation"
import { AppError } from "../src/lib/mca/errors"

let identity: object | null = { user: { id: "verified" }, sessionId: "live" }
let exchangeError: object | null = null
let identityError: Error | null = null
let identityOptions: unknown
const callbackCalls: string[] = []
let verifyError: object | null = null
let verifiedCalls = 0
let oauthOptions: { provider: string; options: { redirectTo: string; skipBrowserRedirect: boolean } } | undefined
const factorId = "10000000-0000-4000-8000-000000000001"
mock.module(new URL("../src/lib/mca/supabase-auth.ts", import.meta.url).href, { namedExports: { supabaseIdentity: async (options: unknown) => { identityOptions = options; if (identityError) throw identityError; return identity } } })
mock.module(new URL("../src/lib/mca/supabase-auth-http.ts", import.meta.url).href, { namedExports: { authOrigin: () => "https://app.example.test" } })
mock.module(new URL("../src/lib/mca/auth.ts", import.meta.url).href, { namedExports: {
  assertTrustedMutation: (request: Request) => { if (request.headers.get("origin") !== "https://app.example.test") throw new Error("Untrusted origin") },
  clientRateKey: () => "test", consumeRequestRateLimit: async () => {},
} })
const totpSessionCalls: string[] = []
mock.module(new URL("../src/lib/mca/totp-service.ts", import.meta.url).href, { namedExports: {
  isGoogleOauthCallback: (input: { hasCode: boolean; hasTokenHash: boolean; type: string | null; provider?: string | null; next?: string | null }) => {
    if (!input.hasCode || input.hasTokenHash || input.provider !== "google") return false
    if (input.type === "email" || input.type === "signup" || input.type === "recovery") return false
    return !input.next?.startsWith("/reset-password")
  },
  markGoogleTotpSession: async () => { totpSessionCalls.push("google") },
  startPasswordTotpChallenge: async () => { totpSessionCalls.push("password"); return { mfaRequired: false } },
  beginTotpEnrollment: async () => ({ secret: "secret", qrCode: "data:image/png;base64,AA==", otpauthUrl: "otpauth://totp/Fundlane" }),
  challengeTotp: async () => ({ method: "totp" }),
  confirmTotpEnrollment: async () => ({ recoveryCodes: [] }),
  disableTotp: async () => {},
  getTotpAccessState: async () => ({ available: true, enrolled: false, pending: false, recoveryRemaining: 0, enrollmentRequired: false, challengeRequired: false, sessionVerified: false }),
  regenerateRecoveryCodes: async () => ({ recoveryCodes: [] }),
  resolveAppUserId: async () => "user",
} })
mock.module(new URL("../src/lib/supabase/server.ts", import.meta.url).href, { namedExports: { createSupabaseServerClient: async () => ({ auth: {
  signInWithOAuth: async (options: NonNullable<typeof oauthOptions>) => { oauthOptions = options; return { data: { url: "https://provider.example.test/authorize" }, error: null } },
  exchangeCodeForSession: async () => { callbackCalls.push("exchange"); return { error: exchangeError } },
  verifyOtp: async (input: { token_hash: string; type: string }) => { callbackCalls.push(`otp:${input.type}:${input.token_hash}`); return { error: exchangeError } },
  mfa: {
    listFactors: async () => ({ data: { all: [{ id: factorId, factor_type: "totp", status: "unverified" }], totp: [] }, error: null }),
    challengeAndVerify: async () => { verifiedCalls++; return { error: verifyError } },
  },
} }) } })
let callback: typeof import("../src/app/auth/callback/route").GET
let mfa: typeof import("../src/app/api/auth/mfa/route").POST
let google: typeof import("../src/app/api/auth/google/route").POST
before(async () => {
  ;({ GET: callback } = await import("../src/app/auth/callback/route"))
  ;({ POST: mfa } = await import("../src/app/api/auth/mfa/route"))
  ;({ POST: google } = await import("../src/app/api/auth/google/route"))
})

test("Google initiation uses the canonical PKCE callback and sanitizes redirect input", async () => {
  const response = await google(new Request("https://forged.test/api/auth/google", { method: "POST", headers: { origin: "https://app.example.test", "content-type": "application/json" }, body: JSON.stringify({ next: "https://evil.test" }) }))
  assert.equal(response.status, 200)
  assert.equal(oauthOptions?.provider, "google")
  assert.equal(oauthOptions?.options.skipBrowserRedirect, true)
  assert.equal(oauthOptions?.options.redirectTo, "https://app.example.test/auth/callback?next=%2Fonboarding")
  assert.equal(response.headers.get("cache-control"), "no-store")
})

test("auth continuations reject external and ambiguous redirects while retaining invitation tokens", () => {
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/%2f%2fevil.test", "/accept-invite?token=bad", "/onboarding/../evil"]) assert.equal(authContinuation(value), "/onboarding")
  assert.equal(authContinuation(`/accept-invite?token=${"a".repeat(32)}&redirect=https://evil.test`), `/accept-invite?token=${"a".repeat(32)}`)
})
test("callback requires successful exchange and live verified identity, retaining safe context on retry", async () => {
  const next = `/accept-invite?token=${"a".repeat(32)}`
  const request = () => new Request(`https://untrusted-host.test/auth/callback?code=pkce&next=${encodeURIComponent(next)}`)
  let response = await callback(request())
  assert.equal(response.headers.get("location"), `https://app.example.test${next}`)
  identity = null
  response = await callback(request())
  assert.match(response.headers.get("location")!, /sign-in\?error=verification_failed/)
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("next"), next)
  identity = { user: { id: "verified" }, sessionId: "live" }
  exchangeError = { message: "expired or replayed" }
  assert.match((await callback(request())).headers.get("location")!, /verification_failed/)
  exchangeError = null
  assert.match((await callback(new Request("https://app.example.test/auth/callback?error=access_denied&code=ignored"))).headers.get("location")!, /verification_failed/)
})
test("MFA rejects anonymous, foreign-factor, malformed and invalid challenges", async () => {
  const request = (input: unknown) => new Request("https://app.example.test/api/auth/mfa", { method: "POST", headers: { origin: "https://app.example.test", "content-type": "application/json" }, body: JSON.stringify(input) })
  identity = null
  assert.equal((await mfa(request({ action: "verify", factorId, code: "123456" }))).status, 401)
  identity = { user: { id: "verified" }, sessionId: "live" }
  assert.equal((await mfa(request({ action: "verify", factorId: "10000000-0000-4000-8000-000000000002", code: "123456" }))).status, 403)
  assert.equal(verifiedCalls, 0)
  assert.equal((await mfa(request({ action: "verify", factorId, code: "bad" }))).status, 400)
  verifyError = { message: "expired" }
  assert.equal((await mfa(request({ action: "verify", factorId, code: "123456" }))).status, 400)
  verifyError = null
  assert.equal((await mfa(request({ action: "verify", factorId, code: "654321" }))).status, 200)
})

const invitation = `/accept-invite?token=${"b".repeat(64)}`
test("PKCE recovery preserves the invitation through reset and retry", async () => {
  const next = recoveryDestination(invitation)
  const response = await callback(new Request(`https://app.example.test/auth/callback?code=recovery-code&next=${encodeURIComponent(next)}`))
  assert.equal(response.headers.get("location"), `https://app.example.test${next}`)
  assert.equal(authContinuation(new URL(response.headers.get("location")!).searchParams.get("next")), invitation)
  assert.deepEqual(identityOptions, { allowPasswordSetup: true })
  exchangeError = { message: "expired" }
  const failed = await callback(new Request(`https://app.example.test/auth/callback?code=expired&next=${encodeURIComponent(next)}`))
  const retry = new URL(failed.headers.get("location")!)
  assert.equal(retry.pathname, "/forgot-password")
  assert.equal(retry.searchParams.get("next"), invitation)
  exchangeError = null
})

test("email and recovery callbacks do not mark a Google TOTP skip", async () => {
  totpSessionCalls.length = 0
  identity = { user: { id: "verified", app_metadata: { provider: "google" } }, sessionId: "live" }
  const email = await callback(new Request("https://app.example.test/auth/callback?token_hash=hash&type=email&next=%2Fonboarding"))
  assert.equal(new URL(email.headers.get("location")!).pathname, "/onboarding")
  assert.deepEqual(totpSessionCalls, ["password"])
  totpSessionCalls.length = 0
  const recovery = await callback(new Request(`https://app.example.test/auth/callback?token_hash=hash&type=recovery&next=${encodeURIComponent("/reset-password?next=%2Fonboarding")}`))
  assert.equal(new URL(recovery.headers.get("location")!).pathname, "/reset-password")
  assert.deepEqual(totpSessionCalls, ["password"])
  totpSessionCalls.length = 0
  const google = await callback(new Request("https://app.example.test/auth/callback?code=pkce&next=%2Fonboarding"))
  assert.equal(new URL(google.headers.get("location")!).pathname, "/onboarding")
  assert.deepEqual(totpSessionCalls, ["google"])
  identity = { user: { id: "verified" }, sessionId: "live" }
})

test("documented token-hash email templates preserve signup and recovery query context without PKCE", async () => {
  const doc = readFileSync(new URL("../docs/supabase-auth.md", import.meta.url), "utf8")
  const templates = [...doc.matchAll(/```html\n([^]*?)\n```/g)].map(match => match[1])
  assert.equal(templates.length, 2)
  for (const [index, template] of templates.entries()) {
    const type = index === 0 ? "signup" : "recovery"
    const next = type === "recovery" ? recoveryDestination(invitation) : invitation
    const redirectTo = `https://app.example.test/auth/callback?next=${encodeURIComponent(next)}`
    // Substitute the documented Go urlquery output and decode HTML attribute separators as a browser does.
    const html = template.replace("{{ .SiteURL }}", "https://app.example.test").replace("{{ .TokenHash }}", "actual-token-hash")
      .replace("{{ .RedirectTo | urlquery }}", encodeURIComponent(redirectTo)).replaceAll("&amp;", "&")
    assert.ok(!html.includes("{{"), "all template variables must be accounted for")
    const url = new URL(html.match(/href="([^"]+)"/)![1])
    assert.equal(url.searchParams.get("redirect_to"), redirectTo)
    assert.equal(url.searchParams.getAll("token_hash").length, 1)
    assert.equal(url.searchParams.get("type"), type)
    assert.equal(url.searchParams.has("code"), false)
    callbackCalls.length = 0
    const response = await callback(new Request(url))
    assert.equal(response.headers.get("location"), `https://app.example.test${next}`)
    assert.deepEqual(callbackCalls, [`otp:${type}:actual-token-hash`])
    assert.deepEqual(identityOptions, { allowPasswordSetup: true })
  }
})

test("recovery and email callbacks reject untrusted nested destinations", async () => {
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/reset-password?next=https%3A%2F%2Fevil.test", "/reset-password?next=%2F%2Fevil.test"]) {
    const safe = callbackDestination(value, true)
    assert.equal(new URL(safe, "https://app.example.test").searchParams.get("next"), "/onboarding")
  }
  for (const redirect of ["https://evil.test/auth/callback?next=" + encodeURIComponent(invitation), "https://app.example.test/other?next=" + encodeURIComponent(invitation), "//app.example.test/auth/callback", "not a URL", "https://app.example.test/auth/callback?next=https%3A%2F%2Fevil.test"]) {
    const response = await callback(new Request(`https://app.example.test/auth/callback?token_hash=hash&type=recovery&redirect_to=${encodeURIComponent(redirect)}`))
    const reset = new URL(response.headers.get("location")!)
    assert.equal(reset.origin, "https://app.example.test")
    assert.equal(reset.pathname, "/reset-password")
    assert.equal(reset.searchParams.get("next"), "/onboarding")
  }
})

test("token-hash recovery rejects non-live identities, failed verification, and provider outages", async () => {
  const request = () => new Request(`https://app.example.test/auth/callback?token_hash=hash&type=recovery&next=${encodeURIComponent(recoveryDestination(invitation))}`)
  identity = null
  let response = await callback(request())
  assert.equal(new URL(response.headers.get("location")!).pathname, "/forgot-password")
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("next"), invitation)
  identity = { user: { id: "verified" }, sessionId: "live" }
  exchangeError = { message: "invalid token" }
  response = await callback(request())
  assert.equal(new URL(response.headers.get("location")!).pathname, "/forgot-password")
  exchangeError = null
  identityError = new AppError(503, "identity_unavailable", "Account verification unavailable")
  for (const auth of ["token_hash=hash&type=recovery", "code=pkce"]) {
    response = await callback(new Request(`https://app.example.test/auth/callback?${auth}&next=${encodeURIComponent(recoveryDestination(invitation))}`))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("location"), null)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal((await response.json()).error.code, "identity_unavailable")
  }
  identityError = null
})
