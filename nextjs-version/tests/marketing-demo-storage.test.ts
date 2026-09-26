import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { decryptSensitive } from "../src/lib/mca/crypto"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { isDemoStorageAvailable, notifyDemoSubmission, storeDemoSubmission } from "../src/lib/marketing/demo-storage"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("demo submissions persist once and reject conflicting request IDs", async () => {
  const db = await createPostgresTestDatabase("demo_submissions")
  const previous = process.env.DATABASE_URL
  const previousKey = process.env.MCA_DATA_ENCRYPTION_KEY
  process.env.DATABASE_URL = db.databaseUrl
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  try {
    assert.equal(await isDemoStorageAvailable(), true)
    const id = randomUUID()
    const contact = { name: "Alex Morgan", email: "alex@example.test", brokerage: "Synthetic Capital", teamSize: "2–5" as const, message: "Follow-ups" }
    assert.equal(await storeDemoSubmission(id, contact), true)
    assert.equal(await storeDemoSubmission(id, contact), false)
    await assert.rejects(storeDemoSubmission(id, { ...contact, brokerage: "Different" }))
    const rows = await db.query("SELECT * FROM marketing_demo_submissions")
    assert.equal(rows.rows.length, 1)
    const row = rows.rows[0] as { request_id: string; payload_cipher: string; payload_digest: string; created_at: Date }
    assert.deepEqual(Object.keys(row).sort(), ["created_at", "payload_cipher", "payload_digest", "request_id"])
    assert.equal(row.request_id, id)
    assert.ok(row.payload_cipher.startsWith("v1."))
    assert.deepEqual(JSON.parse(decryptSensitive(row.payload_cipher, `marketing-demo-submission:${id}`)), contact)
    assert.throws(() => decryptSensitive(row.payload_cipher, "marketing-demo-submission:another-request"))
    assert.equal(JSON.stringify(row).includes(contact.email), false)
    assert.equal(JSON.stringify(row).includes(contact.name), false)
    assert.equal(JSON.stringify(row).includes(contact.brokerage), false)
    assert.equal(JSON.stringify(row).includes(contact.message), false)
    assert.ok(row.created_at)
    const security = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'marketing_demo_submissions'::regclass")
    assert.equal(security.rows[0].relrowsecurity, true)
    await db.query("DROP TABLE marketing_demo_submissions")
    assert.equal(await isDemoStorageAvailable(), false)
  } finally {
    await closeDatabaseForTests()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    if (previousKey === undefined) delete process.env.MCA_DATA_ENCRYPTION_KEY
    else process.env.MCA_DATA_ENCRYPTION_KEY = previousKey
    await db.close()
  }
})

test("notification uses configured destination and escapes HTML without a live send", async () => {
  const keys = ["MCA_DEMO_NOTIFY_EMAIL", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM"] as const
  const previous = keys.map((key) => process.env[key])
  const originalFetch = globalThis.fetch
  const sent: { url: string; body: Record<string, string> }[] = []
  try {
    delete process.env.MCA_DEMO_NOTIFY_EMAIL
    assert.equal(await notifyDemoSubmission(randomUUID(), { name: "Alex", email: "alex@example.test", brokerage: "Synthetic", teamSize: "1", message: "" }), false)
    process.env.MCA_DEMO_NOTIFY_EMAIL = "sales@example.test"
    process.env.MCA_USESEND_API_KEY = "test-key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    globalThis.fetch = async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ emailId: "synthetic-email-id" })
    }
    assert.equal(await notifyDemoSubmission(randomUUID(), { name: "Alex", email: "alex@example.test", brokerage: "<Synthetic>", teamSize: "1", message: "" }), true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].body.to, "sales@example.test")
    assert.match(sent[0].body.html, /&lt;Synthetic&gt;/)
    assert.doesNotMatch(sent[0].body.html, /<Synthetic>/)
  } finally {
    globalThis.fetch = originalFetch
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  }
})
