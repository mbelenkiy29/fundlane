import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createDemoHandler } from "../src/lib/marketing/demo"
import { AppError } from "../src/lib/mca/errors"
import { getDemoConfiguration } from "../src/lib/marketing/config"

const configuration = () => ({
  enabled: true,
  databaseEnabled: false,
  privacyUrl: "https://fundlane.io/privacy",
  webhookUrl: "https://sales.example.test/demo",
  token: "synthetic-test-token",
})
const valid = () => ({
  requestId: randomUUID(),
  name: "Alex Morgan",
  email: "Alex@example.test",
  brokerage: "Synthetic Capital",
  teamSize: "2–5",
  message: "Follow-ups",
  website: "",
})
function request(
  body: unknown = valid(),
  headers: Record<string, string> = {}
) {
  return new Request("https://fundlane.io/api/marketing/demo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://fundlane.io",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
function fixture(extra: Parameters<typeof createDemoHandler>[0] = {}) {
  const sent: { headers: Headers; body: Record<string, unknown> }[] = []
  const metrics: string[] = []
  const rateKeys: [string, number][] = []
  const handler = createDemoHandler({
    configuration,
    rateLimit: async (key, limit) => {
      rateKeys.push([key, limit])
    },
    fetch: async (_url, init) => {
      sent.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      return new Response(null, { status: 202 })
    },
    metric: (event) => {
      metrics.push(event)
    },
    ...extra,
  })
  return { handler, sent, metrics, rateKeys }
}

test("accepts normalized data only after authenticated receiver acceptance", async () => {
  const f = fixture()
  const response = await f.handler(request())
  assert.equal(response.status, 202)
  const result = await response.json()
  assert.equal(result.accepted, true)
  assert.equal(
    f.sent[0].headers.get("authorization"),
    "Bearer synthetic-test-token"
  )
  assert.equal(f.sent[0].headers.get("idempotency-key"), result.requestId)
  assert.equal(f.sent[0].body.email, "alex@example.test")
  assert.equal(f.sent[0].body.type, "fundlane.demo_requested")
  assert.equal("website" in f.sent[0].body, false)
  assert.deepEqual(f.metrics, ["accepted"])
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.deepEqual(
    f.rateKeys.map(([, n]) => n),
    [120, 5]
  )
})

test("duplicates, concurrent submissions, and response-loss retries share a receiver deduplication key", async () => {
  const accepted = new Set<string>()
  const keys: string[] = []
  let loseResponse = true
  const f = fixture({
    fetch: async (_url, init) => {
      const key = new Headers(init?.headers).get("idempotency-key")!
      keys.push(key)
      accepted.add(key) // Receiver's atomic unique key contract.
      if (loseResponse) {
        loseResponse = false
        throw new Error("Response lost after acceptance")
      }
      return new Response(null, { status: 202 })
    },
  })
  const payload = valid()
  assert.equal((await f.handler(request(payload))).status, 502)
  const results = await Promise.all([
    f.handler(request(payload)),
    f.handler(request(payload)),
  ])
  assert.deepEqual(
    results.map((r) => r.status),
    [202, 202]
  )
  assert.equal(accepted.size, 1)
  assert.equal(new Set(keys).size, 1)
  await f.handler(request({ ...payload, brokerage: "Edited Brokerage" }))
  assert.equal(accepted.size, 2)
})

test("invalid fields, unexpected payload, honeypot and oversized bodies never reach sales", async () => {
  const f = fixture()
  for (const body of [
    { ...valid(), name: " " },
    { ...valid(), email: "invalid" },
    { ...valid(), teamSize: "unknown" },
    { ...valid(), website: "spam.test" },
    { ...valid(), unexpected: "injected" },
    "not-json",
  ]) {
    assert.equal((await f.handler(request(body))).status, 400)
  }
  assert.equal((await f.handler(request("a".repeat(12_001)))).status, 413)
  assert.equal(
    (await f.handler(request(valid(), { "content-type": "text/plain" })))
      .status,
    415
  )
  assert.equal(f.sent.length, 0)
})

test("cross-site requests and exhausted rate limits are rejected before delivery", async () => {
  const f = fixture()
  assert.equal(
    (await f.handler(request(valid(), { origin: "https://attacker.test" })))
      .status,
    403
  )
  assert.equal(f.sent.length, 0)
  assert.equal(f.rateKeys.length, 0)
  const limited = fixture({
    rateLimit: async () => {
      throw new AppError(
        429,
        "rate_limit_exceeded",
        "Too many attempts. Try again shortly."
      )
    },
  })
  const response = await limited.handler(request())
  assert.equal(response.status, 429)
  assert.equal(response.headers.get("retry-after"), "60")
  assert.equal(limited.sent.length, 0)
})

test("unconfigured destination/privacy and unavailable rate storage fail closed", async () => {
  const disabled = fixture({
    configuration: () => ({ ...configuration(), enabled: false }),
  })
  assert.equal((await disabled.handler(request())).status, 503)
  assert.equal(disabled.sent.length, 0)
  let stored = 0
  const unpublishedDatabase = fixture({
    configuration: () => ({ ...configuration(), enabled: false, databaseEnabled: true, privacyUrl: null }),
    store: async () => { stored++; return true },
  })
  assert.equal((await unpublishedDatabase.handler(request())).status, 503)
  assert.equal(stored, 0)
  assert.equal(unpublishedDatabase.rateKeys.length, 0)
  const broken = fixture({
    rateLimit: async () => {
      throw new Error("private database error")
    },
  })
  const response = await broken.handler(request())
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes("private database"), false)
  assert.equal(broken.sent.length, 0)
})

test("provider rejection, network failure and abort never produce false success or expose receiver content", async () => {
  for (const mode of ["reject", "network", "timeout"] as const) {
    const f = fixture({
      timeout: () => AbortSignal.abort(),
      fetch: async (_url, init) => {
        if (mode === "reject")
          return new Response("private sales information", { status: 500 })
        if (mode === "timeout") init?.signal?.throwIfAborted()
        throw new Error("private provider error")
      },
    })
    const response = await f.handler(request())
    assert.equal(response.status, 502)
    assert.equal((await response.text()).includes("private"), false)
    assert.deepEqual(f.metrics, ["delivery_failed"])
  }
})

test("database mode stores normalized requests and attempts notification", async () => {
  const stored: Array<{ id: string; email: string }> = []
  const notified: string[] = []
  const f = fixture({
    configuration: () => ({ ...configuration(), databaseEnabled: true, webhookUrl: null, token: null }),
    store: async (id, contact) => { stored.push({ id, email: contact.email }); return true },
    notify: async (id) => { notified.push(id); return true },
    isTracked: async () => false,
  })
  const payload = valid()
  const response = await f.handler(request(payload))
  assert.equal(response.status, 202)
  assert.deepEqual(stored, [{ id: payload.requestId, email: "alex@example.test" }])
  assert.deepEqual(notified, [payload.requestId])
  assert.deepEqual(f.metrics, ["accepted"])
  assert.equal(f.sent.length, 0)
})

test("a row marked historical during migration still receives its initial email", async () => {
  let direct = 0
  const f = fixture({
    configuration: () => ({ ...configuration(), databaseEnabled: true }),
    store: async () => true,
    isTracked: async () => false,
    notify: async () => { direct++; return true },
    deliver: async () => { throw new Error("historical row must not use tracked delivery") },
  })
  assert.equal((await f.handler(request())).status, 202)
  assert.equal(direct, 1)
})

test("duplicate request retries an unsent notification only when visibility is enabled", async () => {
  const old = process.env.MCA_DEMO_VISIBILITY_ENABLED
  try {
    let attempts = 0
    const f = fixture({
      configuration: () => ({ ...configuration(), databaseEnabled: true }),
      store: async () => false,
      notify: async () => { attempts++; return true },
      deliver: async () => { attempts++; return true },
      isTracked: async () => true,
    })
    delete process.env.MCA_DEMO_VISIBILITY_ENABLED
    assert.equal((await f.handler(request())).status, 202)
    assert.equal(attempts, 0)
    process.env.MCA_DEMO_VISIBILITY_ENABLED = "true"
    assert.equal((await f.handler(request())).status, 202)
    assert.equal(attempts, 1)
    assert.deepEqual(f.metrics, ["accepted", "accepted"])
  } finally {
    if (old === undefined) delete process.env.MCA_DEMO_VISIBILITY_ENABLED
    else process.env.MCA_DEMO_VISIBILITY_ENABLED = old
  }
})

test("notification failures and missing delivery configuration do not lose a stored request", async () => {
  for (const notify of [async () => { throw new Error("provider secret") }, async () => false]) {
    let stored = 0
    const f = fixture({
      configuration: () => ({ ...configuration(), databaseEnabled: true }),
      store: async () => { stored++; return true },
      notify,
      isTracked: async () => false,
    })
    assert.equal((await f.handler(request())).status, 202)
    assert.equal(stored, 1)
    assert.equal(f.metrics[1], "accepted")
    assert.ok(["notification_failed", "notification_skipped"].includes(f.metrics[0]))
  }
})

test("database mode keeps validation, rate limits, and storage failures closed", async () => {
  let stores = 0
  const f = fixture({
    configuration: () => ({ ...configuration(), databaseEnabled: true }),
    store: async () => { stores++; throw new Error("private database error") },
    notify: async () => { throw new Error("must not notify") },
  })
  assert.equal((await f.handler(request({ ...valid(), name: " " }))).status, 400)
  assert.equal(stores, 0)
  const response = await f.handler(request())
  assert.equal(response.status, 503)
  assert.equal((await response.text()).includes("private database"), false)
  assert.equal(stores, 1)
  const limited = fixture({
    configuration: () => ({ ...configuration(), databaseEnabled: true }),
    rateLimit: async () => { throw new AppError(429, "rate_limit_exceeded", "Too many attempts.") },
    store: async () => { throw new Error("must not store") },
  })
  assert.equal((await limited.handler(request())).status, 429)
})

test("production configuration requires HTTPS destination, token and approved privacy URL", () => {
  const keys = [
    "MCA_DEMO_WEBHOOK_URL",
    "MCA_DEMO_WEBHOOK_TOKEN",
    "MCA_MARKETING_PRIVACY_URL",
  ] as const
  const old = keys.map((key) => process.env[key])
  const oldFlag = process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED
  try {
    delete process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED
    process.env.MCA_DEMO_WEBHOOK_URL = "https://sales.example.test/demo"
    process.env.MCA_DEMO_WEBHOOK_TOKEN = "synthetic"
    process.env.MCA_MARKETING_PRIVACY_URL = "https://fundlane.io/privacy"
    assert.equal(getDemoConfiguration().enabled, true)
    for (const key of keys) {
      const value = process.env[key]
      delete process.env[key]
      assert.equal(getDemoConfiguration().enabled, false)
      process.env[key] = value
    }
    process.env.MCA_DEMO_WEBHOOK_URL = "http://sales.example.test/demo"
    assert.equal(getDemoConfiguration().enabled, false)
    process.env.MCA_DEMO_WEBHOOK_URL =
      "https://user:secret@sales.example.test/demo"
    assert.equal(getDemoConfiguration().enabled, false)
    process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED = "TRUE"
    assert.equal(getDemoConfiguration().databaseEnabled, false)
    process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED = "true"
    assert.equal(getDemoConfiguration().enabled, true)
    delete process.env.MCA_MARKETING_PRIVACY_URL
    assert.equal(getDemoConfiguration().databaseEnabled, true)
    assert.equal(getDemoConfiguration().privacyUrl, null)
    assert.equal(getDemoConfiguration().enabled, false)
    process.env.MCA_MARKETING_PRIVACY_URL = "http://fundlane.io/privacy"
    assert.equal(getDemoConfiguration().enabled, false)
    process.env.MCA_MARKETING_PRIVACY_URL = "https://fundlane.io/privacy"
    assert.equal(getDemoConfiguration().enabled, true)
  } finally {
    if (oldFlag === undefined) delete process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED
    else process.env.MCA_DEMO_DB_SUBMISSIONS_ENABLED = oldFlag
    keys.forEach((key, i) => {
      if (old[i] === undefined) delete process.env[key]
      else process.env[key] = old[i]
    })
  }
})
