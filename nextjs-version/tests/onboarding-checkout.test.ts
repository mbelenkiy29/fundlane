import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { startEnrollmentCheckout } from "../src/lib/mca/onboarding/checkout"
import { findEnrollment } from "../src/lib/mca/onboarding/store"
import {
  enrollmentTestEnv,
  resumeSecret,
  stripeFixture,
} from "./helpers/onboarding-billing"
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const env = { ...process.env }
before(async () => {
  database = await createPostgresTestDatabase("enrollment_checkout")
  Object.assign(process.env, enrollmentTestEnv, {
    DATABASE_URL: database.databaseUrl,
  })
})
after(async () => {
  await closeDatabaseForTests()
  await database?.close()
  for (const k of Object.keys(process.env))
    if (!(k in env)) delete process.env[k]
  Object.assign(process.env, env)
})
test("freezes server-selected card-first fourteen-day Checkout before I/O without a company or local trial", async () => {
  const f = stripeFixture()
  Object.assign(process.env, {
    MCA_BILLING_TRIAL_DAYS: "90",
    MCA_STRIPE_TAX_ENABLED: "true",
    MCA_STRIPE_PROMOTION_CODES_ENABLED: "true",
  })
  f.state.onCreate = async (p) => {
    assert.ok(
      await getDatabase().queryOne(
        "SELECT id FROM mca_enrollment_checkout_requests WHERE enrollment_id=?",
        [p.client_reference_id]
      )
    )
  }
  try {
    const result = await startEnrollmentCheckout(
      { resumeSecret: resumeSecret() },
      f.client
    )
    const p = f.state.createCalls[0].params
    assert.equal(
      p.success_url,
      `http://localhost:3000/enrollment?enrollment=${result.enrollmentId}`
    )
    assert.equal(
      p.cancel_url,
      `http://localhost:3000/enrollment?enrollment=${result.enrollmentId}&checkout=canceled`
    )
    assert.deepEqual(p.line_items, [{ price: "price_base", quantity: 1 }])
    assert.equal(p.subscription_data?.trial_period_days, 14)
    assert.equal(p.payment_method_collection, "always")
    assert.deepEqual(p.payment_method_types, ["card"])
    assert.deepEqual(p.name_collection, {
      business: { enabled: true, optional: false },
    })
    assert.deepEqual(p.automatic_tax, { enabled: true })
    assert.equal(p.billing_address_collection, "required")
    assert.equal(p.tax_id_collection, undefined)
    assert.equal(p.allow_promotion_codes, true)
    assert.equal(
      (await findEnrollment(result.enrollmentId))?.trialStartedAt,
      null
    )
    assert.deepEqual(
      await getDatabase().queryOne(
        "SELECT count(*)::int count FROM workspaces"
      ),
      { count: 0 }
    )
  } finally {
    delete process.env.MCA_STRIPE_TAX_ENABLED
    delete process.env.MCA_STRIPE_PROMOTION_CODES_ENABLED
    delete process.env.MCA_BILLING_TRIAL_DAYS
  }
})
test("concurrent starts reuse one Checkout and lost response replays the committed request key", async () => {
  const f = stripeFixture(),
    secret = resumeSecret()
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      startEnrollmentCheckout({ resumeSecret: secret }, f.client)
    )
  )
  assert.ok(results.some((r) => r.status === "fulfilled"))
  assert.equal(f.state.sessions.size, 1)
  const lost = stripeFixture(),
    other = resumeSecret()
  lost.state.loseCreate = true
  await assert.rejects(
    startEnrollmentCheckout({ resumeSecret: other }, lost.client)
  )
  await startEnrollmentCheckout({ resumeSecret: other }, lost.client)
  assert.equal(lost.state.sessions.size, 1)
  assert.equal(new Set(lost.state.createCalls.map((c) => c.key)).size, 1)
  assert.deepEqual(
    lost.state.createCalls[0].params,
    lost.state.createCalls[1].params
  )
})
test("missing encryption, origin, account or mismatched catalog cannot create Checkout", async () => {
  for (const [key, value] of [
    ["MCA_APP_ORIGIN", "javascript:alert(1)"],
    ["MCA_STRIPE_EXPECTED_ACCOUNT_ID", ""],
    ["MCA_DATA_ENCRYPTION_KEY", ""],
  ] as const) {
    const f = stripeFixture(),
      old = process.env[key],
      node = process.env.NODE_ENV
    process.env[key] = value
    if (key === "MCA_DATA_ENCRYPTION_KEY")
      Object.assign(process.env, { NODE_ENV: "production" })
    try {
      await assert.rejects(
        startEnrollmentCheckout({ resumeSecret: resumeSecret() }, f.client)
      )
      assert.equal(f.state.createCalls.length, 0)
    } finally {
      process.env[key] = old
      if (node === undefined) Reflect.deleteProperty(process.env, "NODE_ENV")
      else Object.assign(process.env, { NODE_ENV: node })
    }
  }
  for (const mismatch of ["account", "price"]) {
    const f = stripeFixture()
    if (mismatch === "account") f.state.account = "acct_foreign"
    else f.state.priceAmount = 1
    await assert.rejects(
      startEnrollmentCheckout({ resumeSecret: resumeSecret() }, f.client)
    )
    assert.equal(f.state.createCalls.length, 0)
  }
})
test("uncertain create past provider retention finds the exact existing session and never recreates", async () => {
  const f = stripeFixture(),
    secret = resumeSecret()
  f.state.loseCreate = true
  await assert.rejects(
    startEnrollmentCheckout({ resumeSecret: secret }, f.client)
  )
  const old = Date.now
  Date.now = () => old() + 26 * 3600000
  try {
    await assert.rejects(
      startEnrollmentCheckout({ resumeSecret: secret }, f.client)
    )
    assert.equal(f.state.createCalls.length, 1)
  } finally {
    Date.now = old
  }
})
test("negative or incomplete provider history after retention creates operator work without another create", async () => {
  for (const incomplete of [false, true]) {
    const f = stripeFixture(),
      secret = resumeSecret()
    f.state.loseCreate = true
    await assert.rejects(
      startEnrollmentCheckout({ resumeSecret: secret }, f.client)
    )
    f.state.sessions.clear()
    f.client.checkout.sessions.list = (async () => ({
      data: [],
      has_more: incomplete,
    })) as unknown as typeof f.client.checkout.sessions.list
    const old = Date.now
    Date.now = () => old() + 26 * 3600000
    try {
      await assert.rejects(
        startEnrollmentCheckout({ resumeSecret: secret }, f.client),
        { code: "enrollment_operator_required" }
      )
      assert.equal(f.state.createCalls.length, 1)
      assert.equal(
        (
          await getDatabase().queryOne<{ state: string }>(
            "SELECT state FROM mca_enrollment_checkout_requests WHERE request_key=?",
            [f.state.createCalls[0].key]
          )
        )?.state,
        "operator_required"
      )
    } finally {
      Date.now = old
    }
  }
})
test("only verified expiration permits a fresh generation; an open session is reused", async () => {
  const f = stripeFixture(),
    secret = resumeSecret(),
    first = await startEnrollmentCheckout({ resumeSecret: secret }, f.client)
  await startEnrollmentCheckout({ resumeSecret: secret }, f.client)
  assert.equal(f.state.createCalls.length, 1)
  ;[...f.state.sessions.values()][0].status = "expired"
  await startEnrollmentCheckout({ resumeSecret: secret }, f.client)
  assert.equal(f.state.createCalls.length, 2)
  assert.notEqual(f.state.createCalls[0].key, f.state.createCalls[1].key)
  assert.equal(
    (await findEnrollment(first.enrollmentId))?.checkoutGeneration,
    2
  )
  assert.equal(
    (
      await getDatabase().queryOne<{ count: number }>(
        "SELECT count(*)::int count FROM mca_enrollment_checkout_requests WHERE enrollment_id=?",
        [first.enrollmentId]
      )
    )?.count,
    2
  )
})
test("known ineligibility holds a reservation atomically and never falls back to paid Checkout", async () => {
  const userId = crypto.randomUUID(),
    providerId = crypto.randomUUID(),
    email = `${userId}@example.test`,
    now = new Date().toISOString()
  await getDatabase().execute(
    "INSERT INTO users(id,supabase_user_id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,'Owner',?,?,?)",
    [userId, providerId, email, userId, now, now]
  )
  process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED = "true"
  try {
    const a = stripeFixture(),
      b = stripeFixture()
    const results = await Promise.allSettled([
      startEnrollmentCheckout(
        { resumeSecret: resumeSecret(), initiatingProviderUserId: providerId },
        a.client
      ),
      startEnrollmentCheckout(
        { resumeSecret: resumeSecret(), initiatingProviderUserId: providerId },
        b.client
      ),
    ])
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.equal(a.state.createCalls.length + b.state.createCalls.length, 1)
    const rejected = results.find((r) => r.status === "rejected")
    assert.equal(
      rejected?.status === "rejected" ? rejected.reason.code : null,
      "enrollment_trial_ineligible"
    )
  } finally {
    delete process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED
  }
})
for (const failure of ["superseded", "expired", "replacement"]) {
  test(`lost or expired Checkout leases preserve request ownership: ${failure}`, async () => {
    const f = stripeFixture(),
      secret = resumeSecret()
    if (failure === "replacement") {
      await startEnrollmentCheckout({ resumeSecret: secret }, f.client)
      ;[...f.state.sessions.values()][0].status = "expired"
    }
    f.state.onCreate = async (params) => {
      if (failure === "expired")
        await getDatabase().execute(
          "UPDATE mca_enrollments SET lease_until=?,revision=revision+1 WHERE id=?",
          [
            new Date(Date.now() - 1000).toISOString(),
            params.client_reference_id,
          ]
        )
      else
        await getDatabase().execute(
          "UPDATE mca_enrollments SET claim_token=?,lease_until=?,revision=revision+1 WHERE id=?",
          [
            crypto.randomUUID(),
            new Date(Date.now() + 600000).toISOString(),
            params.client_reference_id,
          ]
        )
    }
    await assert.rejects(
      startEnrollmentCheckout({ resumeSecret: secret }, f.client),
      { code: "enrollment_busy" }
    )
    const latest = f.state.createCalls.at(-1)!
    assert.equal(
      (
        await getDatabase().queryOne<{ state: string }>(
          "SELECT state FROM mca_enrollment_checkout_requests WHERE request_key=?",
          [latest.key]
        )
      )?.state,
      "creating"
    )
  })
}
