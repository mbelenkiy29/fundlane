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
  withoutProviderUser,
  liveIdentity,
} from "./helpers/onboarding-auth"
import { getDatabase, nowIso } from "../src/lib/mca/db"
import { NextRequest } from "next/server"
import { randomUUID } from "node:crypto"
import {
  createOpaqueToken,
  encryptSensitive,
  hashOpaqueToken,
} from "../src/lib/mca/crypto"
import {
  enrollmentChallengeScope,
  enrollmentEmailHash,
  findEnrollment,
} from "../src/lib/mca/onboarding/store"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"

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

function issuedCallbackRequest(
  redirect: string,
  branch: "token" | "code",
  client: string
) {
  const query = new URLSearchParams({ redirect_to: redirect })
  if (branch === "token") {
    query.set("token_hash", "synthetic-token")
    query.set("type", "magiclink")
  } else query.set("code", "synthetic-code")
  return new Request(`http://localhost:3000/auth/callback?${query}`, {
    headers: { "x-forwarded-for": client },
  })
}

for (const branch of ["token", "code"] as const) {
  test(`issued ${branch} callbacks reserve five failed attempts before provider I/O`, async () => {
    const f = await activatedEnrollment(),
      auth = await import("../src/lib/mca/onboarding/auth")
    await auth.requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: f.identity.email,
    })
    const challengeId = browserCookies
      .get(auth.enrollmentAuthCookie)!
      .split(".")[0]
    const redirect = (
      provider.otpInputs[0] as { options: { emailRedirectTo: string } }
    ).options.emailRedirectTo
    const { GET } = await import("../src/app/auth/callback/route")
    provider.otpError = { status: 400, message: "Synthetic invalid proof" }
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await GET(issuedCallbackRequest(redirect, branch, f.id))
      assert.match(response.headers.get("location")!, /verification_failed/)
    }
    assert.equal(
      branch === "token"
        ? provider.verificationInputs.length
        : provider.exchangeInputs.length,
      5
    )
    assert.deepEqual(
      await getDatabase().queryOne(
        "SELECT attempts,state FROM mca_enrollment_challenges WHERE id=?",
        [challengeId]
      ),
      { attempts: 5, state: "pending" }
    )
  })
}

test("the fifth valid issued callback succeeds for both token and code exchange", async () => {
  const auth = await import("../src/lib/mca/onboarding/auth"),
    { GET } = await import("../src/app/auth/callback/route")
  for (const branch of ["token", "code"] as const) {
    const f = await activatedEnrollment()
    await auth.requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: f.identity.email,
      destination: "business",
      generation: 1,
    })
    const challengeId = browserCookies
      .get(auth.enrollmentAuthCookie)!
      .split(".")[0]
    const redirect = (
      provider.otpInputs.at(-1) as { options: { emailRedirectTo: string } }
    ).options.emailRedirectTo
    provider.otpError = { status: 400, message: "Synthetic invalid proof" }
    for (let attempt = 0; attempt < 4; attempt++)
      await GET(issuedCallbackRequest(redirect, branch, f.id))
    provider.otpError = null
    const result = await GET(issuedCallbackRequest(redirect, branch, f.id))
    assert.equal(
      result.headers.get("location"),
      `http://localhost:3000/enrollment?enrollment=${f.id}&destination=business&generation=1`
    )
    assert.deepEqual(
      await getDatabase().queryOne(
        "SELECT attempts,state FROM mca_enrollment_challenges WHERE id=?",
        [challengeId]
      ),
      { attempts: 5, state: "consumed" }
    )
    const calls =
      provider.verificationInputs.length + provider.exchangeInputs.length
    await GET(issuedCallbackRequest(redirect, branch, f.id))
    assert.equal(
      provider.verificationInputs.length + provider.exchangeInputs.length,
      calls
    )
  }
})

test("typed OTP and issued callbacks share one verification budget", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth"),
    { GET } = await import("../src/app/auth/callback/route")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const challengeId = browserCookies
    .get(auth.enrollmentAuthCookie)!
    .split(".")[0]
  const redirect = (
    provider.otpInputs[0] as { options: { emailRedirectTo: string } }
  ).options.emailRedirectTo
  provider.otpError = { status: 400, message: "Synthetic invalid proof" }
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      auth.verifyEnrollmentAuthentication({
        challengeId,
        email: f.identity.email,
        token: "111111",
      }),
      { code: "enrollment_challenge_invalid" }
    )
  for (let attempt = 0; attempt < 2; attempt++)
    await GET(issuedCallbackRequest(redirect, "token", f.id))
  provider.otpError = null
  assert.equal(
    (await GET(issuedCallbackRequest(redirect, "code", f.id))).headers.get(
      "location"
    ),
    `http://localhost:3000/enrollment?enrollment=${f.id}`
  )
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT attempts,state FROM mca_enrollment_challenges WHERE id=?",
      [challengeId]
    ),
    { attempts: 5, state: "consumed" }
  )
  await assert.rejects(
    auth.verifyEnrollmentAuthentication({
      challengeId,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  assert.equal(
    provider.verificationInputs.length + provider.exchangeInputs.length,
    5
  )
})

test("concurrent issued callbacks cannot reserve more than five attempts", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth"),
    { GET } = await import("../src/app/auth/callback/route")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const challengeId = browserCookies
    .get(auth.enrollmentAuthCookie)!
    .split(".")[0]
  const redirect = (
    provider.otpInputs[0] as { options: { emailRedirectTo: string } }
  ).options.emailRedirectTo
  provider.otpError = { status: 400, message: "Synthetic invalid proof" }
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      GET(issuedCallbackRequest(redirect, index % 2 ? "code" : "token", f.id))
    )
  )
  assert.equal(
    provider.verificationInputs.length + provider.exchangeInputs.length,
    5
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ attempts: number }>(
        "SELECT attempts FROM mca_enrollment_challenges WHERE id=?",
        [challengeId]
      )
    )?.attempts,
    5
  )
})

test("issued callbacks revalidate generations after provider verification", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth"),
    { GET } = await import("../src/app/auth/callback/route")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const challengeId = browserCookies
    .get(auth.enrollmentAuthCookie)!
    .split(".")[0]
  const redirect = (
    provider.otpInputs[0] as { options: { emailRedirectTo: string } }
  ).options.emailRedirectTo
  provider.onOtp = async () => {
    await getDatabase().execute(
      "UPDATE mca_enrollments SET email_generation=email_generation+1,revision=revision+1,updated_at=? WHERE id=?",
      [nowIso(), f.id]
    )
  }
  assert.match(
    (await GET(issuedCallbackRequest(redirect, "code", f.id))).headers.get(
      "location"
    )!,
    /verification_failed/
  )
  assert.deepEqual(
    await getDatabase().queryOne(
      "SELECT attempts,state FROM mca_enrollment_challenges WHERE id=?",
      [challengeId]
    ),
    { attempts: 1, state: "pending" }
  )
})

test("issued callbacks apply a durable client rate guard across challenges without requiring GET Origin", async () => {
  const auth = await import("../src/lib/mca/onboarding/auth"),
    { GET } = await import("../src/app/auth/callback/route")
  const client = "synthetic-rate-client"
  let last: Response | undefined
  for (let group = 0; group < 4; group++) {
    const f = await activatedEnrollment()
    provider.otpError = null
    await auth.requestEnrollmentAuthentication({
      enrollmentId: f.id,
      email: f.identity.email,
    })
    const redirect = (
      provider.otpInputs.at(-1) as { options: { emailRedirectTo: string } }
    ).options.emailRedirectTo
    provider.otpError = { status: 400, message: "Synthetic invalid proof" }
    for (let attempt = 0; attempt < 4; attempt++)
      last = await GET(issuedCallbackRequest(redirect, "token", client))
  }
  assert.equal(last?.status, 429)
  assert.equal(provider.verificationInputs.length, 15)
})

test("malformed nested MFA URLs and login aliases fall back safely", async () => {
  const { default: proxy } = await import("../src/proxy")
  for (const malformed of ["http://[", "http://%"])
    for (const alias of ["login", "register"]) {
      const next = `/account-security?next=${encodeURIComponent(malformed)}`
      assert.equal(authContinuation(next), "/onboarding")
      const response = await proxy(
        new NextRequest(
          `http://localhost:3000/${alias}?next=${encodeURIComponent(next)}`
        )
      )
      assert.equal(
        new URL(response.headers.get("location")!).searchParams.get("next"),
        "/onboarding"
      )
    }
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

/** Mirrors the email worker's freeze-time mint (payload contract incl. invite:true). */
async function mintInvite(f: Awaited<ReturnType<typeof activatedEnrollment>>) {
  const id = randomUUID(),
    token = createOpaqueToken(),
    now = nowIso(),
    row = (await findEnrollment(f.id))!
  await getDatabase().execute(
    "INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,resume_generation,expires_at,created_at,updated_at) VALUES (?,?,'authentication',?,?,?,?,?,?,?)",
    [
      id,
      f.id,
      hashOpaqueToken(token),
      encryptSensitive(
        JSON.stringify({
          version: 1,
          email: f.identity.email,
          emailGeneration: row.emailGeneration,
          destination: "crm",
          generation: row.emailGeneration,
          issuedAt: now,
          sessionId: null,
          invite: true,
        }),
        enrollmentChallengeScope(id)
      ),
      enrollmentEmailHash(f.identity.email),
      row.resumeGeneration,
      new Date(Date.parse(now) + 86_400_000).toISOString(),
      now,
      now,
    ]
  )
  return { id, token }
}
async function newOwnerInvite() {
  const f = await activatedEnrollment()
  withoutProviderUser(f.identity)
  return { f, invite: await mintInvite(f) }
}
async function openInvite(id: string, token: string, extra = "") {
  const { handleEnrollmentHttp } =
    await import("../src/lib/mca/onboarding/http")
  return handleEnrollmentHttp(
    new Request(
      `http://localhost:3000/api/enrollment/invite?challenge=${id}&token=${token}${extra}`,
      { headers: { "x-forwarded-for": randomUUID() } }
    ),
    "invite-open"
  )
}
async function postInvite(
  body: unknown,
  origin: string | null = "http://localhost:3000"
) {
  const { handleEnrollmentHttp } =
    await import("../src/lib/mca/onboarding/http")
  return handleEnrollmentHttp(
    new Request("http://localhost:3000/api/enrollment/invite", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": randomUUID(),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
    "password"
  )
}
async function challengeRow(id: string) {
  return getDatabase().queryOne<{ state: string; attempts: number }>(
    "SELECT state,attempts FROM mca_enrollment_challenges WHERE id=?",
    [id]
  )
}
async function count(table: string) {
  return (await getDatabase().queryOne<{ count: number }>(
    `SELECT count(*)::int count FROM ${table}`
  ))!.count
}
const password = "Synthetic-Passw0rd-Long"

test("opening an invite only sets the browser cookie and 303s to the tokenless enrollment page", async () => {
  const { f, invite } = await newOwnerInvite()
  const { enrollmentAuthCookie } =
    await import("../src/lib/mca/onboarding/auth")
  const opened = await openInvite(invite.id, invite.token)
  assert.equal(opened.status, 303)
  assert.equal(
    opened.headers.get("location"),
    `http://localhost:3000/enrollment?enrollment=${f.id}&destination=crm&generation=1`
  )
  assert.equal(opened.headers.get("referrer-policy"), "no-referrer")
  assert.equal(
    browserCookies.get(enrollmentAuthCookie),
    `${invite.id}.${invite.token}`
  )
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 0,
  })
  browserCookies.clear()
  assert.equal(
    (await openInvite(invite.id, createOpaqueToken())).headers.get("location"),
    "http://localhost:3000/enrollment"
  )
  assert.equal(
    (
      await openInvite(invite.id, invite.token, `&token=${invite.token}`)
    ).headers.get("location"),
    "http://localhost:3000/enrollment"
  )
  assert.equal(
    (await openInvite("not-a-uuid", invite.token)).headers.get("location"),
    "http://localhost:3000/enrollment"
  )
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 0,
  })
})

test("an invite sets a confirmed password once and creates no company before claim", async () => {
  const { f, invite } = await newOwnerInvite()
  const companies = await count("workspaces"),
    members = await count("memberships")
  await openInvite(invite.id, invite.token)
  const response = await postInvite({
    challengeId: invite.id,
    email: f.identity.email,
    password,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    success: true,
    destination: `/enrollment?enrollment=${f.id}&destination=crm&generation=1`,
  })
  assert.deepEqual(provider.createUserInputs, [
    { email: f.identity.email, password, email_confirm: true },
  ])
  assert.equal(provider.current?.email, f.identity.email)
  assert.equal((await challengeRow(invite.id))?.state, "consumed")
  assert.equal(await count("workspaces"), companies)
  assert.equal(await count("memberships"), members)
  const reused = await postInvite({
    challengeId: invite.id,
    email: f.identity.email,
    password,
  })
  assert.equal(reused.status, 400)
  assert.equal((await reused.json()).error.code, "enrollment_challenge_invalid")
  assert.equal(provider.createUserInputs.length, 1)
})

test("expired, exhausted and OTP-issued challenges cannot set a password", async () => {
  const { f, invite } = await newOwnerInvite()
  await openInvite(invite.id, invite.token)
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET expires_at=?,created_at=? WHERE id=?",
    [
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() - 60000).toISOString(),
      invite.id,
    ]
  )
  const body = { challengeId: invite.id, email: f.identity.email, password }
  assert.equal((await postInvite(body)).status, 400)
  const fresh = await mintInvite(f)
  await openInvite(fresh.id, fresh.token)
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET attempts=5 WHERE id=?",
    [fresh.id]
  )
  assert.equal(
    (await postInvite({ ...body, challengeId: fresh.id })).status,
    400
  )
  // A requester-browser OTP challenge is not mailbox proof and never sets a password.
  const auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const otp = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  const forged = await postInvite({ ...body, challengeId: otp })
  assert.equal(forged.status, 400)
  assert.equal((await forged.json()).error.code, "enrollment_challenge_invalid")
  assert.equal(provider.createUserInputs.length, 0)
})

test("short passwords fail before an attempt; existing accounts, bad origins and disabled runtime are refused", async () => {
  const { f, invite } = await newOwnerInvite()
  await openInvite(invite.id, invite.token)
  const body = { challengeId: invite.id, email: f.identity.email, password }
  assert.equal(
    (await postInvite({ ...body, password: "short" })).status,
    400
  )
  assert.equal((await challengeRow(invite.id))?.attempts, 0)
  assert.equal((await postInvite(body, null)).status, 403)
  assert.equal((await postInvite(body, "https://foreign.test")).status, 403)
  const saved = process.env.MCA_ONBOARDING_RUNTIME_ENABLED
  delete process.env.MCA_ONBOARDING_RUNTIME_ENABLED
  try {
    assert.equal((await postInvite(body)).status, 503)
    assert.equal((await openInvite(invite.id, invite.token)).status, 503)
  } finally {
    process.env.MCA_ONBOARDING_RUNTIME_ENABLED = saved
  }
  assert.equal(provider.createUserInputs.length, 0)
  // The Checkout email already has a provider account: Login instead.
  const g = await activatedEnrollment(),
    existing = await mintInvite(g)
  await openInvite(existing.id, existing.token)
  const conflict = await postInvite({
    challengeId: existing.id,
    email: g.identity.email,
    password,
  })
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, "enrollment_account_exists")
})

test("an edited email consumes the invite, moves the enrollment and queues a fresh invite generation", async () => {
  const { f, invite } = await newOwnerInvite()
  const before = (await findEnrollment(f.id))!
  // Activation already queued generation 1's two intents; they are unsent.
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=? AND generation=1 AND state='queued'",
        [f.id]
      )
    )?.count,
    2
  )
  await openInvite(invite.id, invite.token)
  const email = `typo-fixed-${randomUUID()}@example.test`
  assert.equal(
    (
      await postInvite({ challengeId: invite.id, email, password })
    ).status,
    400
  )
  const changed = await postInvite({ challengeId: invite.id, email })
  assert.equal(changed.status, 200)
  assert.deepEqual(await changed.json(), { success: true, emailChanged: true })
  const after = (await findEnrollment(f.id))!
  assert.equal(after.emailHash, enrollmentEmailHash(email))
  assert.equal(after.activationEmailHash, before.activationEmailHash)
  assert.equal(after.emailGeneration, before.emailGeneration + 1)
  assert.equal((await challengeRow(invite.id))?.state, "consumed")
  const mail = (
    await getDatabase().query<{ generation: number; state: string }>(
      "SELECT generation,state FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY generation,purpose",
      [f.id]
    )
  ).rows
  assert.ok(
    mail.filter((row) => row.generation === 1).every((row) => row.state === "suppressed")
  )
  assert.equal(
    mail.filter((row) => row.generation === 2 && row.state === "queued").length,
    2
  )
  assert.equal(provider.createUserInputs.length, 0)
  // A target address that already has an account is refused without changes.
  const { f: g, invite: second } = await newOwnerInvite()
  const taken = await liveIdentity(`taken-${randomUUID()}@example.test`)
  await linkSupabaseUser(taken)
  await openInvite(second.id, second.token)
  const collision = await postInvite({
    challengeId: second.id,
    email: taken.email,
  })
  assert.equal(collision.status, 409)
  assert.equal(
    (await findEnrollment(g.id))!.emailHash,
    enrollmentEmailHash(g.identity.email)
  )
  assert.equal((await challengeRow(second.id))?.state, "pending")
})

test("requesting an email code at the purchase page revokes a pending invite", async () => {
  const { f, invite } = await newOwnerInvite()
  const auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  assert.equal((await challengeRow(invite.id))?.state, "revoked")
})
