import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { isDemoStorageAvailable, notifyDemoSubmission, storeDemoSubmission } from "../src/lib/marketing/demo-storage"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"

test("demo submissions persist once and reject conflicting request IDs", async () => {
  const db = await createPostgresTestDatabase("demo_submissions")
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = db.databaseUrl
  try {
    assert.equal(await isDemoStorageAvailable(), true)
    const id = randomUUID()
    const contact = { name: "Alex Morgan", email: "alex@example.test", brokerage: "Synthetic Capital", teamSize: "2–5" as const, message: "Follow-ups" }
    assert.equal(await storeDemoSubmission(id, contact), true)
    assert.equal(await storeDemoSubmission(id, contact), false)
    await assert.rejects(storeDemoSubmission(id, { ...contact, brokerage: "Different" }))
    const rows = await db.query("SELECT request_id, name, email, brokerage, team_size, message, created_at FROM marketing_demo_submissions")
    assert.equal(rows.rows.length, 1)
    assert.equal(rows.rows[0].request_id, id)
    assert.equal(rows.rows[0].email, contact.email)
    assert.ok(rows.rows[0].created_at)
    const security = await db.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'marketing_demo_submissions'::regclass")
    assert.equal(security.rows[0].relrowsecurity, true)
    await db.query("DROP TABLE marketing_demo_submissions")
    assert.equal(await isDemoStorageAvailable(), false)
  } finally {
    await closeDatabaseForTests()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
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
