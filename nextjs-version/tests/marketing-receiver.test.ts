import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { createDemoReceiver } from "../src/lib/marketing/receiver"
import { createDemoHandler } from "../src/lib/marketing/demo"
import { decryptSensitive } from "../src/lib/mca/crypto"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

const token = "synthetic-receiver-test-token"
const envelope = () => ({ type: "fundlane.demo_requested", version: 1, requestId: randomBytes(32).toString("hex"), name: "Synthetic Operator", email: "demo@example.test", brokerage: "Synthetic Capital", teamSize: "2–5", message: "Synthetic verification; do not contact." })
function request(body = envelope(), headers: Record<string, string> = {}) {
  return new Request("https://fundlane.io/api/marketing/receiver", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": body.requestId, ...headers }, body: JSON.stringify(body) })
}

test("receiver rejects unauthenticated, malformed and oversized input without persisting", async () => {
  let writes = 0
  const receiver = createDemoReceiver({ token: () => token, persist: async () => { writes++ } })
  assert.equal((await receiver(request(envelope(), { authorization: "Bearer wrong" }))).status, 401)
  assert.equal((await receiver(request(envelope(), { "content-type": "text/plain" }))).status, 415)
  assert.equal((await receiver(request(envelope(), { "idempotency-key": "wrong" }))).status, 400)
  assert.equal((await receiver(request({ ...envelope(), message: "x".repeat(13_000) }))).status, 413)
  assert.equal(writes, 0)
  const unavailable = createDemoReceiver({ token: () => undefined, persist: async () => { writes++ } })
  assert.equal((await unavailable(request())).status, 503)
  const failed = createDemoReceiver({ token: () => token, persist: async () => { throw new Error("private details") } })
  const result = await failed(request())
  assert.equal(result.status, 503)
  assert.equal((await result.text()).includes("private details"), false)
})

test("demo to receiver commits one encrypted record across concurrent and ambiguous retries", async () => {
  const db = await createPostgresTestDatabase("marketing_receiver")
  const previous = { url: process.env.DATABASE_URL, token: process.env.MCA_DEMO_WEBHOOK_TOKEN, key: process.env.MCA_DATA_ENCRYPTION_KEY }
  process.env.DATABASE_URL = db.databaseUrl
  process.env.MCA_DEMO_WEBHOOK_TOKEN = token
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  try {
    const receiver = createDemoReceiver()
    let loseResponse = true
    const handler = createDemoHandler({
      configuration: () => ({ enabled: true, databaseEnabled: false, token, privacyUrl: "https://fundlane.io/privacy", webhookUrl: "https://fundlane.io/api/marketing/receiver" }),
      rateLimit: async () => undefined,
      metric: () => undefined,
      fetch: async (url, init) => {
        const result = await receiver(new Request(url, init))
        if (loseResponse) { loseResponse = false; throw new Error("Connection lost after commit") }
        return result
      },
    })
    const form = { name: "Synthetic Operator", email: "demo@example.test", brokerage: "Synthetic Capital", teamSize: "2–5", message: "Synthetic verification; do not contact.", requestId: randomUUID(), website: "" }
    const submit = () => handler(new Request("https://fundlane.io/api/marketing/demo", { method: "POST", headers: { origin: "https://fundlane.io", "content-type": "application/json" }, body: JSON.stringify(form) }))
    assert.equal((await submit()).status, 502)
    const results = await Promise.all(Array.from({ length: 8 }, submit))
    assert.ok(results.every(r => r.status === 202))
    const { requestId } = await results[0].json()
    const rows = await db.query("SELECT * FROM marketing_demo_requests")
    assert.equal(rows.rows.length, 1)
    const row = rows.rows[0] as unknown as { request_id: string; payload_cipher: string }
    assert.equal(row.request_id, requestId)
    assert.equal(row.payload_cipher.includes(form.email), false)
    const stored = JSON.parse(decryptSensitive(row.payload_cipher, `marketing-demo:${requestId}`))
    assert.equal(stored.email, form.email)
    assert.equal(stored.name, form.name)
    assert.throws(() => decryptSensitive(row.payload_cipher, "other-record"))
    assert.equal((await receiver(request({ ...stored, name: "Conflicting retry" }))).status, 503)
    assert.equal((await db.query("SELECT request_id FROM marketing_demo_requests")).rows.length, 1)
  } finally {
    await closeDatabaseForTests()
    for (const [key, value] of Object.entries({ DATABASE_URL: previous.url, MCA_DEMO_WEBHOOK_TOKEN: previous.token, MCA_DATA_ENCRYPTION_KEY: previous.key })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    await db.close()
  }
})
