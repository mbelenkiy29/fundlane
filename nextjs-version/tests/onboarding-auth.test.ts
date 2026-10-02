import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  authContinuation,
  callbackDestination,
  recoveryDestination,
} from "../src/lib/mca/auth-navigation"
import {
  authDatabase,
  activatedEnrollment,
  browserCookies,
  provider,
  resetAuthProvider,
} from "./helpers/onboarding-auth"
import { getDatabase, nowIso } from "../src/lib/mca/db"
import { NextRequest } from "next/server"

let close: () => Promise<void>
before(async () => {
  close = await authDatabase("enrollment_auth")
})
after(async () => {
  await close?.()
})
beforeEach(resetAuthProvider)

const locator = "10000000-0000-4000-8000-000000000001"
test("password, Google, OTP and recovery retain only a canonical enrollment and its positive mail generation", () => {
  const next = `/enrollment?enrollment=${locator}&destination=business&generation=2`
  assert.equal(
    authContinuation(
      `${next}&checkout=canceled&email=private%40example.test&session_id=cs_private`
    ),
    next
  )
  assert.equal(callbackDestination(next, false), next)
  assert.equal(
    new URL(recoveryDestination(next), "https://app.test").searchParams.get(
      "next"
    ),
    next
  )
  assert.equal(
    authContinuation(
      `/account-security?challenge=1&next=${encodeURIComponent(next)}`
    ),
    `/account-security?challenge=1&next=${encodeURIComponent(next)}`
  )
})

test("only an accepted enrollment issues new-user email sign-in; response remains account-neutral", async () => {
  const f = await activatedEnrollment()
  const { requestEnrollmentAuthentication, enrollmentAuthCookie } =
    await import("../src/lib/mca/onboarding/auth")
  await requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  assert.equal(provider.otpInputs.length, 1)
  const sent = provider.otpInputs[0] as {
    email: string
    options: { shouldCreateUser: boolean; emailRedirectTo: string }
  }
  assert.equal(sent.email, f.identity.email)
  assert.equal(sent.options.shouldCreateUser, true)
  assert.equal(new URL(sent.options.emailRedirectTo).pathname, "/auth/callback")
  assert.equal(
    new URL(sent.options.emailRedirectTo).searchParams.get("next"),
    `/enrollment?enrollment=${f.id}`
  )
  assert.ok(browserCookies.has(enrollmentAuthCookie))
  assert.equal(
    await requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: "other@example.test",
    }),
    undefined
  )
  assert.equal(
    await requestEnrollmentAuthentication({
      enrollmentId: locator,
      email: f.identity.email,
    }),
    undefined
  )
  assert.equal(provider.otpInputs.length, 1)
  provider.otpError = { message: "private provider detail" }
  assert.equal(
    await requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: f.identity.email,
    }),
    undefined
  )
})
test("OTP uses email sign-in semantics and consumes only the exact browser-bound current challenge", async () => {
  const f = await activatedEnrollment()
  const {
    requestEnrollmentAuthentication,
    verifyEnrollmentAuthentication,
    enrollmentAuthCookie,
  } = await import("../src/lib/mca/onboarding/auth")
  await requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const cookie = browserCookies.get(enrollmentAuthCookie)!,
    challengeId = cookie.split(".")[0]
  browserCookies.clear()
  await assert.rejects(
    verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  browserCookies.set(enrollmentAuthCookie, cookie)
  assert.equal(
    (
      await verifyEnrollmentAuthentication({
        challengeId,
        email: f.identity.email,
        token: "123456",
      })
    ).destination,
    `/enrollment?enrollment=${f.id}`
  )
  assert.deepEqual(provider.verificationInputs, [
    { email: f.identity.email, token: "123456", type: "email" },
  ])
  await assert.rejects(
    verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ state: string }>(
        "SELECT state FROM mca_enrollment_challenges WHERE id=?",
        [challengeId]
      )
    )?.state,
    "consumed"
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM workspaces"
      )
    )?.count,
    0
  )
})
test("expired challenges, changed mail generation and five bad attempts cannot create grants", async () => {
  const f = await activatedEnrollment()
  const auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
    generation: 1,
  })
  let challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET expires_at=?,created_at=? WHERE id=?",
    [
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() - 60000).toISOString(),
      challengeId,
    ]
  )
  await assert.rejects(
    auth.verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
    generation: 1,
  })
  challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await getDatabase().execute(
    "UPDATE mca_enrollments SET email_generation=2,revision=revision+1,updated_at=? WHERE id=?",
    [nowIso(), f.id]
  )
  await assert.rejects(
    auth.verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
    generation: 2,
  })
  challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  provider.otpError = { message: "invalid OTP" }
  for (let n = 0; n < 6; n++)
    await assert.rejects(
      auth.verifyEnrollmentAuthentication({
        challengeId,
        email: f.identity.email,
        token: "111111",
      }),
      { code: "enrollment_challenge_invalid" }
    )
  assert.equal(provider.verificationInputs.length, 5)
})
test("GET status never claims, public locators disclose no contact and superseded links are rejected", async () => {
  const f = await activatedEnrollment()
  const { readEnrollmentStatus } =
    await import("../src/lib/mca/onboarding/claim")
  assert.deepEqual(
    await readEnrollmentStatus({ enrollmentId: f.id }, f.client),
    { state: "unavailable", nextAction: "authenticate" }
  )
  assert.deepEqual(
    await readEnrollmentStatus({ enrollmentId: f.id, generation: 2 }, f.client),
    { state: "unavailable", nextAction: "authenticate" }
  )
  const result = await readEnrollmentStatus(
    { enrollmentId: f.id, resumeSecret: f.secret },
    f.client
  )
  assert.deepEqual(Object.keys(result).sort(), [
    "nextAction",
    "state",
    "trialEndsAt",
  ])
  assert.equal(result.nextAction, "authenticate")
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM workspaces"
      )
    )?.count,
    0
  )
  await assert.rejects(
    readEnrollmentStatus(
      { enrollmentId: f.id, identity: f.identity, generation: 2 },
      f.client
    ),
    { code: "enrollment_link_superseded" }
  )
})
test("an issued enrollment magic-link callback works with legacy magic links disabled; a flow flag has no authority", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
    destination: "business",
    generation: 1,
  })
  const sent = provider.otpInputs[0] as {
      options: { emailRedirectTo: string }
    },
    redirect = sent.options.emailRedirectTo
  const { GET } = await import("../src/app/auth/callback/route")
  delete process.env.MCA_MAGIC_LINK_ENABLED
  const invalid = await GET(
    new Request(
      `http://localhost:3000/auth/callback?token_hash=private&flow=enrollment-email&type=magiclink&next=${encodeURIComponent(`/enrollment?enrollment=${f.id}`)}`
    )
  )
  assert.match(invalid.headers.get("location")!, /verification_failed/)
  const result = await GET(
    new Request(
      `http://localhost:3000/auth/callback?token_hash=private&type=magiclink&redirect_to=${encodeURIComponent(redirect)}`
    )
  )
  assert.equal(
    result.headers.get("location"),
    `http://localhost:3000/enrollment?enrollment=${f.id}&destination=business&generation=1`
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM workspaces"
      )
    )?.count,
    0
  )
  assert.match(
    (
      await GET(
        new Request(
          `http://localhost:3000/auth/callback?token_hash=private&type=magiclink&redirect_to=${encodeURIComponent(redirect)}`
        )
      )
    ).headers.get("location")!,
    /verification_failed/
  )
})
test("the fifth valid OTP attempt may succeed but concurrent generation changes cannot consume stale proof", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  let challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET attempts=4 WHERE id=?",
    [challengeId]
  )
  assert.equal(
    (
      await auth.verifyEnrollmentAuthentication({
        challengeId,
        email: f.identity.email,
        token: "123456",
      })
    ).destination,
    `/enrollment?enrollment=${f.id}`
  )
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  provider.onOtp = async () => {
    await getDatabase().execute(
      "UPDATE mca_enrollments SET email_generation=email_generation+1,revision=revision+1,updated_at=? WHERE id=?",
      [nowIso(), f.id]
    )
  }
  await assert.rejects(
    auth.verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
})
test("enrollment HTTP mutations require exact trusted origin, strict JSON and bounded shared limits", async () => {
  const { handleEnrollmentHttp } =
    await import("../src/lib/mca/onboarding/http")
  const request = (
    body: unknown,
    origin: string | null = "http://localhost:3000"
  ) =>
    new Request("http://localhost:3000/api/enrollment/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    })
  assert.equal(
    (await handleEnrollmentHttp(request({}, null), "session")).status,
    403
  )
  assert.equal(
    (await handleEnrollmentHttp(request({}, "https://foreign.test"), "session"))
      .status,
    403
  )
  assert.equal(
    (
      await handleEnrollmentHttp(
        request({ stripeCustomerId: "cus_private" }),
        "session"
      )
    ).status,
    400
  )
  const valid = await handleEnrollmentHttp(request({}), "session")
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), { success: true })
  assert.equal(valid.headers.get("cache-control"), "private, no-store")
  let limited = false
  for (let n = 0; n < 15; n++)
    if ((await handleEnrollmentHttp(request({}), "session")).status === 429)
      limited = true
  assert.equal(limited, true)
})
test("login aliases preserve only sanitized enrollment context", async () => {
  const { default: proxy } = await import("../src/proxy")
  const next = `/enrollment?enrollment=${locator}&destination=billing&generation=2`
  const response = await proxy(
    new NextRequest(
      `http://localhost:3000/login?next=${encodeURIComponent(`${next}&checkout=canceled&email=secret%40example.test`)}`
    )
  )
  const location = new URL(response.headers.get("location")!)
  assert.equal(location.pathname, "/sign-in")
  assert.equal(location.searchParams.get("next"), next)
  const foreign = await proxy(
    new NextRequest("http://localhost:3000/login?next=https%3A%2F%2Fevil.test")
  )
  assert.equal(
    new URL(foreign.headers.get("location")!).searchParams.get("next"),
    "/onboarding"
  )
})
test("status with a deactivated membership offers recovery instead of an operational tenant destination", async () => {
  const f = await activatedEnrollment(),
    { claimEnrollment, readEnrollmentStatus } =
      await import("../src/lib/mca/onboarding/claim")
  const claimed = await claimEnrollment(
    { enrollmentId: f.id, identity: f.identity },
    f.client
  )
  await getDatabase().execute(
    "UPDATE memberships SET status='deactivated' WHERE workspace_id=?",
    [claimed.workspaceId]
  )
  const result = await readEnrollmentStatus(
    { enrollmentId: f.id, identity: f.identity },
    f.client
  )
  assert.equal(result.nextAction, "recover")
  assert.equal(result.destination, undefined)
})
test("ambiguous enrollment and recursive MFA continuations fail closed", () => {
  for (const value of [
    `/enrollment?enrollment=${locator}&enrollment=${locator}`,
    `/enrollment?enrollment=cs_private`,
    `/enrollment?enrollment=${locator}&generation=0`,
    `/enrollment?enrollment=${locator}&generation=1.2`,
    `/enrollment?enrollment=${locator}&generation=9007199254740992`,
    `/enrollment?enrollment=${locator}&destination=//evil.test`,
    `/enrollment?enrollment=${locator}&destination=crm&destination=billing`,
    `/account-security?next=${encodeURIComponent("/account-security?next=/onboarding")}`,
    `/%65nrollment?enrollment=${locator}`,
  ])
    assert.equal(authContinuation(value), "/onboarding", value)
})
