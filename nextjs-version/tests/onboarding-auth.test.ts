import test, { before, after, beforeEach, mock } from "node:test"
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
import { getDatabase, nowIso, withTransaction } from "../src/lib/mca/db"
import { NextRequest } from "next/server"
import { randomUUID } from "node:crypto"
import pg from "pg"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  createOpaqueToken,
  encryptSensitive,
  hashOpaqueToken,
} from "../src/lib/mca/crypto"
import {
  enrollmentChallengeScope,
  enrollmentEmailHash,
  findEnrollment,
  readEnrollmentContact,
} from "../src/lib/mca/onboarding/store"
import { enqueueParkedInvite } from "../src/lib/mca/onboarding/email-intents"
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

/** Mirrors the email worker's freeze-time mint (payload contract incl. invite:true and an optional pending address). */
async function mintInvite(
  f: Awaited<ReturnType<typeof activatedEnrollment>>,
  options: { email?: string; generation?: number; emailChange?: boolean } = {}
) {
  const id = randomUUID(),
    token = createOpaqueToken(),
    now = nowIso(),
    row = (await findEnrollment(f.id))!,
    email = options.email ?? f.identity.email
  await getDatabase().execute(
    "INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,resume_generation,expires_at,created_at,updated_at) VALUES (?,?,'authentication',?,?,?,?,?,?,?)",
    [
      id,
      f.id,
      hashOpaqueToken(token),
      encryptSensitive(
        JSON.stringify({
          version: 1,
          email,
          emailGeneration: row.emailGeneration,
          destination: "crm",
          generation: options.generation ?? row.emailGeneration,
          issuedAt: now,
          sessionId: null,
          invite: true,
          ...(options.emailChange ? { emailChange: true } : {}),
        }),
        enrollmentChallengeScope(id)
      ),
      enrollmentEmailHash(email),
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
async function postTo(
  path: string,
  action: "password" | "resend",
  body: unknown,
  origin: string | null = "http://localhost:3000"
) {
  const { handleEnrollmentHttp } =
    await import("../src/lib/mca/onboarding/http")
  return handleEnrollmentHttp(
    new Request(`http://localhost:3000${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": randomUUID(),
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    }),
    action
  )
}
const postInvite = (body: unknown, origin?: string | null) =>
  postTo("/api/enrollment/invite", "password", body, origin)
const postResend = (body: unknown, origin?: string | null) =>
  postTo("/api/enrollment/resend", "resend", body, origin)
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
async function mails(id: string) {
  return (
    await getDatabase().query<{
      generation: number
      purpose: string
      state: string
      recipient_hash: string
      template_version: number
    }>(
      "SELECT generation,purpose,state,recipient_hash,template_version FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY generation,purpose",
      [id]
    )
  ).rows
}
async function parkRows(id: string, generations: number[]) {
  await withTransaction(async (db) => {
    for (const generation of generations)
      await enqueueParkedInvite(id, generation, `parked-${randomUUID()}@example.test`, db)
  })
}
const password = "Synthetic-Passw0rd-Long"

test("GET has no side effects: no GET route, and the page reads no invite state and sets no cookie", async () => {
  const { invite } = await newOwnerInvite()
  const route = await import("../src/app/api/enrollment/invite/route")
  assert.equal("GET" in route, false)
  // The page module needs client React (next/link), so its GET purity is asserted from source:
  // it may only pass the uuid-checked id through, with no auth, DB or cookie access.
  const page = readFileSync(resolve("src/app/(auth)/enrollment/page.tsx"), "utf8")
  assert.doesNotMatch(page, /onboarding\/auth|next\/headers|getDatabase|cookies\(|requireIssued|findEnrollment/)
  assert.match(page, /z\.uuid\(\)\.safeParse\(params\.invite\)/)
  assert.match(page, /referrer: "no-referrer"/)
  assert.equal(browserCookies.size, 0)
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 0,
  })
})

test("an invite sets a confirmed password from the POSTed token once and creates no company before claim", async () => {
  const { f, invite } = await newOwnerInvite()
  const { enrollmentAuthCookie } =
    await import("../src/lib/mca/onboarding/auth")
  const companies = await count("workspaces"),
    members = await count("memberships")
  const body = {
    challengeId: invite.id,
    token: invite.token,
    email: f.identity.email,
    password,
  }
  const wrong = await postInvite({ ...body, token: createOpaqueToken() })
  assert.equal(wrong.status, 400)
  assert.equal((await wrong.json()).error.code, "enrollment_challenge_invalid")
  assert.equal(
    (await postInvite({ ...body, token: undefined })).status,
    400
  )
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 0,
  })
  browserCookies.set(enrollmentAuthCookie, `${randomUUID()}.${createOpaqueToken()}`)
  const response = await postInvite(body)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("referrer-policy"), "no-referrer")
  assert.deepEqual(await response.json(), {
    success: true,
    destination: `/enrollment?enrollment=${f.id}&destination=crm&generation=1`,
  })
  assert.equal(browserCookies.has(enrollmentAuthCookie), false)
  assert.deepEqual(provider.createUserInputs, [
    { email: f.identity.email, password, email_confirm: true },
  ])
  assert.equal(provider.current?.email, f.identity.email)
  assert.equal((await challengeRow(invite.id))?.state, "consumed")
  assert.equal(await count("workspaces"), companies)
  assert.equal(await count("memberships"), members)
  const reused = await postInvite(body)
  assert.equal(reused.status, 400)
  assert.equal((await reused.json()).error.code, "enrollment_challenge_invalid")
  assert.equal(provider.createUserInputs.length, 1)
  assert.deepEqual(provider.deletedUserIds, [])
})

test("invite tokens never work through the cookie path", async () => {
  const { f, invite } = await newOwnerInvite()
  const auth = await import("../src/lib/mca/onboarding/auth")
  browserCookies.set(auth.enrollmentAuthCookie, `${invite.id}.${invite.token}`)
  await assert.rejects(
    auth.verifyEnrollmentAuthentication({
      challengeId: invite.id,
      email: f.identity.email,
      token: "123456",
    }),
    { code: "enrollment_challenge_invalid" }
  )
  assert.equal(provider.verificationInputs.length, 0)
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 0,
  })
})

test("expired, exhausted and OTP-issued challenges cannot set a password", async () => {
  const { f, invite } = await newOwnerInvite()
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET expires_at=?,created_at=? WHERE id=?",
    [
      new Date(Date.now() - 1000).toISOString(),
      new Date(Date.now() - 60000).toISOString(),
      invite.id,
    ]
  )
  const body = { email: f.identity.email, password }
  assert.equal(
    (await postInvite({ ...body, challengeId: invite.id, token: invite.token }))
      .status,
    400
  )
  const fresh = await mintInvite(f)
  await getDatabase().execute(
    "UPDATE mca_enrollment_challenges SET attempts=5 WHERE id=?",
    [fresh.id]
  )
  assert.equal(
    (await postInvite({ ...body, challengeId: fresh.id, token: fresh.token }))
      .status,
    400
  )
  // A requester-browser OTP challenge is not mailbox proof, even with its own secret in the body.
  const auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const [otp, secret] = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")
  const forged = await postInvite({ ...body, challengeId: otp, token: secret })
  assert.equal(forged.status, 400)
  assert.equal((await forged.json()).error.code, "enrollment_challenge_invalid")
  assert.equal(provider.createUserInputs.length, 0)
})

test("short passwords fail before an attempt; existing accounts, bad origins and disabled runtime are refused", async () => {
  const { f, invite } = await newOwnerInvite()
  const body = {
    challengeId: invite.id,
    token: invite.token,
    email: f.identity.email,
    password,
  }
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
  } finally {
    process.env.MCA_ONBOARDING_RUNTIME_ENABLED = saved
  }
  assert.equal(provider.createUserInputs.length, 0)
  // The Checkout email already has a provider account (e.g. a retry after a failure): Login or Forgot password.
  const g = await activatedEnrollment(),
    existing = await mintInvite(g)
  const conflict = await postInvite({
    challengeId: existing.id,
    token: existing.token,
    email: g.identity.email,
    password,
  })
  assert.equal(conflict.status, 409)
  const error = (await conflict.json()).error
  assert.equal(error.code, "enrollment_email_unavailable")
  assert.match(error.message, /Login/)
  assert.match(error.message, /Forgot password/)
  assert.deepEqual(provider.deletedUserIds, [])
})

test("requesting an email code leaves a pending invite pending and usable", async () => {
  const { f, invite } = await newOwnerInvite()
  const auth = await import("../src/lib/mca/onboarding/auth")
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  const firstOtp = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await auth.requestEnrollmentAuthentication({
    enrollmentId: f.id,
    email: f.identity.email,
  })
  assert.equal((await challengeRow(firstOtp))?.state, "revoked")
  assert.equal((await challengeRow(invite.id))?.state, "pending")
  const response = await postInvite({
    challengeId: invite.id,
    token: invite.token,
    email: f.identity.email,
    password,
  })
  assert.equal(response.status, 200)
})

test("an email edit kills the old invite now; the enrollment moves only when the new-address invite sets the password", async () => {
  const { f, invite } = await newOwnerInvite()
  const before = (await findEnrollment(f.id))!
  const email = `typo-fixed-${randomUUID()}@example.test`
  const changed = await postInvite({
    challengeId: invite.id,
    token: invite.token,
    newEmail: email,
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(await changed.json(), {
    success: true,
    emailChangeRequested: true,
  })
  // (a) The old invite stops working immediately.
  assert.equal((await challengeRow(invite.id))?.state, "revoked")
  const stale = await postInvite({
    challengeId: invite.id,
    token: invite.token,
    email: f.identity.email,
    password,
  })
  assert.equal(stale.status, 400)
  // (b) Nothing about the enrollment moved; only a parked invite to the new address exists.
  const pending = (await findEnrollment(f.id))!
  assert.equal(pending.emailHash, before.emailHash)
  assert.equal(readEnrollmentContact(pending).email, f.identity.email)
  assert.equal(pending.emailGeneration, 1)
  assert.equal(pending.revision, before.revision)
  let mail = await mails(f.id)
  assert.ok(
    mail.filter((row) => row.generation === 1).every((row) => row.state === "queued")
  )
  assert.deepEqual(
    mail.filter((row) => row.generation === 2),
    [
      {
        generation: 2,
        purpose: "getting_started",
        state: "queued",
        recipient_hash: enrollmentEmailHash(email),
        template_version: 2,
      },
    ]
  )
  assert.equal(provider.createUserInputs.length, 0)
  // The pending change still works when it is not cancelled.
  const change = await mintInvite(f, { email, generation: 2, emailChange: true })
  const done = await postInvite({
    challengeId: change.id,
    token: change.token,
    email,
    password,
  })
  assert.equal(done.status, 200)
  assert.equal(
    (await done.json()).destination,
    `/enrollment?enrollment=${f.id}&destination=crm&generation=2`
  )
  const after = (await findEnrollment(f.id))!
  assert.equal(after.emailHash, enrollmentEmailHash(email))
  assert.equal(readEnrollmentContact(after).email, email)
  assert.equal(after.emailGeneration, 2)
  assert.equal(after.activationEmailHash, before.activationEmailHash)
  assert.equal((provider.createUserInputs[0] as { email: string }).email, email)
  assert.equal((await challengeRow(change.id))?.state, "consumed")
  mail = await mails(f.id)
  assert.ok(
    mail
      .filter((row) => row.generation === 1)
      .every((row) => row.state === "suppressed")
  )
  assert.equal(
    mail.find(
      (row) => row.generation === 2 && row.purpose === "business_information_requested"
    )?.state,
    "queued"
  )
})

test("every address collision gets the same generic 409 at edit time", async () => {
  const bodies: unknown[] = []
  async function refused(target: string) {
    const { f, invite } = await newOwnerInvite()
    const response = await postInvite({
      challengeId: invite.id,
      token: invite.token,
      newEmail: target,
    })
    assert.equal(response.status, 409)
    bodies.push(await response.json())
    assert.equal(
      (await findEnrollment(f.id))!.emailHash,
      enrollmentEmailHash(f.identity.email)
    )
    assert.equal((await challengeRow(invite.id))?.state, "pending")
  }
  // An existing app user.
  const taken = await liveIdentity(`taken-${randomUUID()}@example.test`)
  await linkSupabaseUser(taken)
  await refused(taken.email)
  // Another open enrollment's current email.
  const open = await activatedEnrollment()
  await refused(open.identity.email)
  // Another enrollment's live invite to a pending address.
  const reserved = await activatedEnrollment(),
    reservedEmail = `reserved-${randomUUID()}@example.test`
  await mintInvite(reserved, {
    email: reservedEmail,
    generation: 2,
    emailChange: true,
  })
  await refused(reservedEmail)
  // Another enrollment's parked, not-yet-minted change row.
  const parked = await activatedEnrollment(),
    parkedEmail = `parked-${randomUUID()}@example.test`
  await withTransaction((db) =>
    enqueueParkedInvite(parked.id, 2, parkedEmail, db)
  )
  await refused(parkedEmail)
  for (const body of bodies) assert.deepEqual(body, bodies[0])
  assert.equal(
    (bodies[0] as { error: { code: string } }).error.code,
    "enrollment_email_unavailable"
  )
  // A blocked enrollment's address is not reserved.
  const blocked = await activatedEnrollment()
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_state='blocked',revision=revision+1 WHERE id=?",
    [blocked.id]
  )
  const { invite } = await newOwnerInvite()
  assert.equal(
    (
      await postInvite({
        challengeId: invite.id,
        token: invite.token,
        newEmail: blocked.identity.email,
      })
    ).status,
    200
  )
})

test("two enrollments racing to one address: the second edit is refused, and only one consume can win", async () => {
  const a = await newOwnerInvite(),
    b = await newOwnerInvite(),
    target = `shared-${randomUUID()}@example.test`
  const edit = (who: typeof a) =>
    postInvite({
      challengeId: who.invite.id,
      token: who.invite.token,
      newEmail: target,
    })
  assert.equal((await edit(a)).status, 200)
  assert.equal((await edit(b)).status, 409)
  // Once A's row is frozen, its minted challenge is the reservation.
  await getDatabase().execute(
    "UPDATE mca_onboarding_service_emails SET frozen_at=? WHERE enrollment_id=? AND generation=2",
    [nowIso(), a.f.id]
  )
  await mintInvite(a.f, { email: target, generation: 2, emailChange: true })
  assert.equal((await edit(b)).status, 409)
  assert.equal((await challengeRow(b.invite.id))?.state, "pending")
  // Forced double reservation: both reach consume; the first wins, the second gets the generic 409.
  const c = await newOwnerInvite(),
    d = await newOwnerInvite(),
    shared = `double-${randomUUID()}@example.test`
  const cInvite = await mintInvite(c.f, {
    email: shared,
    generation: 2,
    emailChange: true,
  })
  const dInvite = await mintInvite(d.f, {
    email: shared,
    generation: 2,
    emailChange: true,
  })
  const consume = (invite: { id: string; token: string }) =>
    postInvite({
      challengeId: invite.id,
      token: invite.token,
      email: shared,
      password,
    })
  assert.equal((await consume(cInvite)).status, 200)
  const lost = await consume(dInvite)
  assert.equal(lost.status, 409)
  assert.equal((await lost.json()).error.code, "enrollment_email_unavailable")
  assert.equal(
    (await findEnrollment(d.f.id))!.emailHash,
    enrollmentEmailHash(d.f.identity.email)
  )
  assert.equal((await challengeRow(dInvite.id))?.state, "pending")
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM mca_enrollments WHERE email_hash=?",
        [enrollmentEmailHash(shared)]
      )
    )?.count,
    1
  )
})

test("a signup landing between edit and consume is refused in the consume transaction and the new account is removed", async () => {
  const { f, invite } = await newOwnerInvite()
  const target = `late-${randomUUID()}@example.test`
  assert.equal(
    (
      await postInvite({
        challengeId: invite.id,
        token: invite.token,
        newEmail: target,
      })
    ).status,
    200
  )
  const change = await mintInvite(f, {
    email: target,
    generation: 2,
    emailChange: true,
  })
  let created = ""
  provider.afterCreateUser = async () => {
    provider.afterCreateUser = undefined
    created = [...provider.users.values()].find((user) => user.email === target)!.id
    await linkSupabaseUser(await liveIdentity(target))
  }
  const before = (await findEnrollment(f.id))!
  const response = await postInvite({
    challengeId: change.id,
    token: change.token,
    email: target,
    password,
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "enrollment_email_unavailable")
  assert.deepEqual(await findEnrollment(f.id), before)
  assert.equal((await challengeRow(change.id))?.state, "pending")
  assert.deepEqual(provider.deletedUserIds, [created])
  assert.equal(provider.users.has(created), false)
})

test("a failure after createUser removes the account this request created, so a retry succeeds", async () => {
  const { f, invite } = await newOwnerInvite()
  provider.afterCreateUser = async () => {
    provider.afterCreateUser = undefined
    provider.passwords.set(f.identity.email, "another-password-entirely")
  }
  const body = {
    challengeId: invite.id,
    token: invite.token,
    email: f.identity.email,
    password,
  }
  const failed = await postInvite(body)
  assert.equal(failed.status, 400)
  assert.equal(provider.deletedUserIds.length, 1)
  assert.deepEqual(await challengeRow(invite.id), {
    state: "pending",
    attempts: 1,
  })
  assert.equal((await postInvite(body)).status, 200)
  assert.equal((await challengeRow(invite.id))?.state, "consumed")
})

// Fails the first COMMIT that would consume the invite: `landed` sends it and then throws (connection lost before
// the acknowledgement), otherwise the transaction is rolled back before the throw. Returns the restore function.
function failInviteCommit(challengeId: string, landed: boolean) {
  const original = pg.Client.prototype.query
  let fired = false
  pg.Client.prototype.query = async function (this: pg.Client, ...args: unknown[]) {
    const run = (...a: unknown[]) => Reflect.apply(original, this, a) as Promise<pg.QueryResult>
    if (fired || (args[0] as { text?: string })?.text !== "COMMIT") return run(...args)
    const state = (
      await run({ text: "SELECT state FROM mca_enrollment_challenges WHERE id=$1", values: [challengeId] })
    ).rows[0]?.state
    if (state !== "consumed") return run(...args)
    fired = true
    await run({ text: landed ? "COMMIT" : "ROLLBACK" })
    throw new Error("Connection terminated unexpectedly")
  } as typeof original
  return () => {
    pg.Client.prototype.query = original
  }
}

test("an error after the consume committed keeps the new account and points the owner to Login", async () => {
  const { f, invite } = await newOwnerInvite()
  const restore = failInviteCommit(invite.id, true)
  let response: Response
  try {
    response = await postInvite({ challengeId: invite.id, token: invite.token, email: f.identity.email, password })
  } finally {
    restore()
  }
  assert.equal(response.status, 409)
  const error = (await response.json()).error
  assert.equal(error.code, "enrollment_email_unavailable")
  assert.match(error.message, /Login/)
  assert.match(error.message, /Forgot password/)
  const created = [...provider.users.values()].find((user) => user.email === f.identity.email)
  assert.ok(created)
  assert.deepEqual(provider.deletedUserIds, [])
  const row = await getDatabase().queryOne<{ state: string; provider_user_id: string }>(
    "SELECT state,provider_user_id FROM mca_enrollment_challenges WHERE id=?",
    [invite.id]
  )
  assert.deepEqual(row, { state: "consumed", provider_user_id: created.id })
})

test("an error while the invite is still pending deletes the new account, so a retry succeeds", async () => {
  const { f, invite } = await newOwnerInvite()
  const body = { challengeId: invite.id, token: invite.token, email: f.identity.email, password }
  const restore = failInviteCommit(invite.id, false)
  let response: Response
  try {
    response = await postInvite(body)
  } finally {
    restore()
  }
  assert.equal(response.status, 500)
  assert.equal(provider.deletedUserIds.length, 1)
  assert.equal(provider.users.has(provider.deletedUserIds[0]!), false)
  assert.deepEqual(await challengeRow(invite.id), { state: "pending", attempts: 1 })
  assert.equal((await postInvite(body)).status, 200)
  assert.equal((await challengeRow(invite.id))?.state, "consumed")
})

test("a provider-only account at a change invite's address is refused at consume with the generic 409 and no changes", async () => {
  const { f, invite } = await newOwnerInvite()
  const target = `provider-only-${randomUUID()}@example.test`
  assert.equal((await postInvite({ challengeId: invite.id, token: invite.token, newEmail: target })).status, 200)
  const change = await mintInvite(f, { email: target, generation: 2, emailChange: true })
  const existing = { id: randomUUID(), email: target, app_metadata: {}, user_metadata: {}, aud: "authenticated", created_at: nowIso() }
  provider.users.set(existing.id, existing as never)
  const before = (await findEnrollment(f.id))!
  const response = await postInvite({ challengeId: change.id, token: change.token, email: target, password })
  assert.equal(response.status, 409)
  const error = (await response.json()).error
  assert.equal(error.code, "enrollment_email_unavailable")
  assert.match(error.message, /Forgot password/)
  assert.equal(provider.createUserInputs.length, 1)
  assert.deepEqual(provider.deletedUserIds, [])
  assert.ok(provider.users.has(existing.id))
  assert.deepEqual(await findEnrollment(f.id), before)
  assert.deepEqual(await challengeRow(change.id), { state: "pending", attempts: 1 })
})

test("after a typo edit, the purchase address can request a fresh link that cancels the pending change", async () => {
  const { f, invite } = await newOwnerInvite()
  const typo = `typo-${randomUUID()}@example.test`
  assert.equal(
    (
      await postInvite({
        challengeId: invite.id,
        token: invite.token,
        newEmail: typo,
      })
    ).status,
    200
  )
  const change = await mintInvite(f, {
    email: typo,
    generation: 2,
    emailChange: true,
  })
  const resent = await postResend({
    enrollmentId: f.id,
    destination: "crm",
    email: f.identity.email,
  })
  assert.equal(resent.status, 200)
  assert.deepEqual(await resent.json(), { success: true })
  assert.equal((await challengeRow(change.id))?.state, "revoked")
  const mail = await mails(f.id)
  assert.equal(mail.find((row) => row.generation === 2)?.state, "suppressed")
  assert.equal(
    mail.find((row) => row.generation === 3)?.recipient_hash,
    enrollmentEmailHash(f.identity.email)
  )
  assert.equal(
    (
      await postInvite({
        challengeId: change.id,
        token: change.token,
        email: typo,
        password,
      })
    ).status,
    400
  )
  // The fresh link (minted from the generation-3 row) sets the password at the unchanged address.
  const fresh = await mintInvite(f)
  const done = await postInvite({
    challengeId: fresh.id,
    token: fresh.token,
    email: f.identity.email,
    password,
  })
  assert.equal(done.status, 200)
  assert.equal(
    (await findEnrollment(f.id))!.emailHash,
    enrollmentEmailHash(f.identity.email)
  )
})

test("fresh-link requests are account-neutral, Origin-checked and rate-limited, and never strand the owner", async () => {
  const neutral = async (body: unknown) => {
    const response = await postResend(body)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { success: true })
  }
  await neutral({ enrollmentId: randomUUID(), email: "nobody@example.test" })
  const g = await activatedEnrollment()
  withoutProviderUser(g.identity)
  await neutral({ enrollmentId: g.id, email: "someone-else@example.test" })
  const blocked = await activatedEnrollment()
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_state='blocked',revision=revision+1 WHERE id=?",
    [blocked.id]
  )
  await neutral({ enrollmentId: blocked.id, email: blocked.identity.email })
  for (const id of [g.id, blocked.id])
    assert.equal((await mails(id)).filter((row) => row.generation > 1).length, 0)
  assert.equal(
    (await postResend({ enrollmentId: g.id, email: g.identity.email }, "https://foreign.test")).status,
    403
  )
  // Per-minute limit.
  const h = await activatedEnrollment()
  for (let index = 0; index < 3; index++)
    await neutral({ enrollmentId: h.id, email: h.identity.email })
  assert.equal(
    (await postResend({ enrollmentId: h.id, email: h.identity.email })).status,
    429
  )
  // A full 24h window is a silent no-op that leaves the latest invite usable.
  const k = await newOwnerInvite()
  await parkRows(k.f.id, [2, 3, 4, 5, 6])
  const latest = await mintInvite(k.f)
  await neutral({ enrollmentId: k.f.id, email: k.f.identity.email })
  assert.equal((await mails(k.f.id)).some((row) => row.generation === 7), false)
  assert.equal((await challengeRow(latest.id))?.state, "pending")
  const saved = process.env.MCA_ONBOARDING_RUNTIME_ENABLED
  delete process.env.MCA_ONBOARDING_RUNTIME_ENABLED
  try {
    assert.equal(
      (await postResend({ enrollmentId: k.f.id, email: k.f.identity.email })).status,
      503
    )
  } finally {
    process.env.MCA_ONBOARDING_RUNTIME_ENABLED = saved
  }
})

test("an edit refuses the current and purchase addresses, and the 24h window caps edits", async () => {
  const { f, invite } = await newOwnerInvite()
  const target = `next-${randomUUID()}@example.test`
  assert.equal(
    (
      await postInvite({
        challengeId: invite.id,
        token: invite.token,
        newEmail: target,
      })
    ).status,
    200
  )
  const change = await mintInvite(f, {
    email: target,
    generation: 2,
    emailChange: true,
  })
  for (const newEmail of [target, f.identity.email]) {
    const response = await postInvite({
      challengeId: change.id,
      token: change.token,
      newEmail,
    })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, "validation_failed")
  }
  assert.equal((await challengeRow(change.id))?.state, "pending")
  const g = await newOwnerInvite()
  await parkRows(g.f.id, [2, 3, 4, 5, 6])
  const capped = await postInvite({
    challengeId: g.invite.id,
    token: g.invite.token,
    newEmail: `capped-${randomUUID()}@example.test`,
  })
  assert.equal(capped.status, 429)
  assert.equal((await challengeRow(g.invite.id))?.state, "pending")
})

const enrollmentPost = (action: string, body: unknown) =>
  new Request(`http://localhost:3000/api/enrollment/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  })
const challengeState = async (id: string) =>
  (
    await getDatabase().queryOne<{ state: string }>(
      "SELECT state FROM mca_enrollment_challenges WHERE id=?",
      [id]
    )
  )?.state

test("a confirmed buyer verifies an 8-digit code with email OTP semantics", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth")
  assert.ok(f.identity.user.email_confirmed_at)
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email: f.identity.email })
  const challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  const result = await auth.verifyEnrollmentAuthentication({
    challengeId,
    email: f.identity.email,
    token: "59480900",
  })
  assert.equal(result.destination, `/enrollment?enrollment=${f.id}`)
  assert.deepEqual(provider.verificationInputs, [
    { email: f.identity.email, token: "59480900", type: "email" },
  ])
})

test("a brand-new unconfirmed buyer verifies the emailed code with email OTP semantics", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth")
  const user = f.identity.user as { email_confirmed_at?: string }
  delete user.email_confirmed_at
  provider.current = null
  provider.onOtp = async () => {
    user.email_confirmed_at = nowIso()
    provider.current = f.identity
  }
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email: f.identity.email })
  const challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  const result = await auth.verifyEnrollmentAuthentication({
    challengeId,
    email: f.identity.email,
    token: "12345678",
  })
  assert.equal(result.destination, `/enrollment?enrollment=${f.id}`)
  assert.deepEqual(provider.verificationInputs, [
    { email: f.identity.email, token: "12345678", type: "email" },
  ])
})

test("resending for a confirmed buyer requests a fresh sign-in code and supersedes the old challenge", async () => {
  const f = await activatedEnrollment()
  const { handleEnrollmentHttp } = await import("../src/lib/mca/onboarding/http")
  const send = async () => {
    const response = await handleEnrollmentHttp(
      enrollmentPost("auth", { enrollmentId: f.id, email: f.identity.email }),
      "auth"
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ["challengeId", "success"])
    assert.equal(body.success, true)
    return body.challengeId as string
  }
  const first = await send(),
    second = await send()
  assert.notEqual(first, second)
  assert.equal(provider.otpInputs.length, 2)
  for (const input of provider.otpInputs as {
    email: string
    options: { shouldCreateUser: boolean }
  }[]) {
    assert.equal(input.email, f.identity.email)
    assert.equal(input.options.shouldCreateUser, true)
  }
  assert.equal(await challengeState(first), "revoked")
  assert.equal(await challengeState(second), "pending")
})

test("HTTP verify accepts a pasted code with separators and sends only digits", async () => {
  const f = await activatedEnrollment(),
    auth = await import("../src/lib/mca/onboarding/auth")
  const { handleEnrollmentHttp } = await import("../src/lib/mca/onboarding/http")
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email: f.identity.email })
  const challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  const response = await handleEnrollmentHttp(
    enrollmentPost("verify", { challengeId, email: f.identity.email, token: " 5948 0900 " }),
    "verify"
  )
  assert.equal(response.status, 200)
  assert.equal((provider.verificationInputs[0] as { token: string }).token, "59480900")
})

for (const failure of [
  { status: 429, code: "over_email_send_rate_limit", name: "AuthApiError", message: "private provider detail" },
  Object.assign(new Error("private provider detail"), { code: "over_email_send_rate_limit", status: 429 }),
])
  test(`a provider send ${failure instanceof Error ? "exception" : "error"} is logged without contact data and stays account-neutral`, async () => {
    const f = await activatedEnrollment(),
      auth = await import("../src/lib/mca/onboarding/auth")
    provider.otpError = failure
    const logged = mock.method(console, "error", () => undefined)
    try {
      assert.equal(
        await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email: f.identity.email }),
        undefined
      )
    } finally {
      logged.mock.restore()
    }
    const cookie = browserCookies.get(auth.enrollmentAuthCookie)!,
      challengeId = cookie.split(".")[0]
    assert.equal(await challengeState(challengeId), "revoked")
    const lines = logged.mock.calls
      .map((call) => String(call.arguments[0]))
      .filter((line) => line.includes("enrollment_auth_email_failed"))
    assert.equal(lines.length, 1)
    const line = JSON.parse(lines[0])
    assert.equal(line.event, "operational_error")
    assert.deepEqual(line.provider, {
      code: "over_email_send_rate_limit",
      status: 429,
      name: failure instanceof Error ? "Error" : "AuthApiError",
    })
    assert.equal(line.enrollmentId, f.id)
    assert.equal(line.challengeId, challengeId)
    for (const secret of [f.identity.email, "private provider detail", cookie.split(".")[1]])
      assert.ok(!lines[0].includes(secret))
  })
