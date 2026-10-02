import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile } from "node:fs/promises"
import { decryptSensitive } from "../src/lib/mca/crypto"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { deliverStoredDemoSubmission, hasUnnotifiedDemoSubmissions, isDemoSubmissionTracked, isDemoStorageAvailable, listDemoSubmissions, notifyDemoSubmission, retryUnsentDemoSubmissions, storeDemoSubmission } from "../src/lib/marketing/demo-storage"
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
    assert.equal(await isDemoSubmissionTracked(id), true)
    assert.equal(await storeDemoSubmission(id, contact), false)
    await assert.rejects(storeDemoSubmission(id, { ...contact, brokerage: "Different" }))
    const rows = await db.query("SELECT * FROM marketing_demo_submissions")
    assert.equal(rows.rows.length, 1)
    const row = rows.rows[0] as { request_id: string; payload_cipher: string; payload_digest: string; created_at: Date }
    assert.deepEqual(Object.keys(row).sort(), ["created_at", "notification_attempts", "notification_error", "notification_lease_until", "notification_tracking_enabled", "notified_at", "payload_cipher", "payload_digest", "request_id"])
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

test("pre-migration submissions keep best-effort email and remain visible", async () => {
  const db = await createPostgresTestDatabase("demo_before_tracking")
  const keys = ["DATABASE_URL", "MCA_DATA_ENCRYPTION_KEY", "MCA_DEMO_NOTIFY_EMAIL", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_DEMO_VISIBILITY_ENABLED"] as const
  const previous = keys.map(key => process.env[key])
  const originalFetch = globalThis.fetch
  process.env.DATABASE_URL = db.databaseUrl
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_DEMO_NOTIFY_EMAIL = "sales@example.test"
  process.env.MCA_USESEND_API_KEY = "test-key"
  process.env.MCA_USESEND_FROM = "sender@example.test"
  delete process.env.MCA_DEMO_VISIBILITY_ENABLED
  let sends = 0
  globalThis.fetch = async () => { sends++; return Response.json({ emailId: "synthetic" }) }
  try {
    await db.query("ALTER TABLE marketing_demo_submissions DROP COLUMN notified_at, DROP COLUMN notification_error, DROP COLUMN notification_attempts, DROP COLUMN notification_lease_until, DROP COLUMN notification_tracking_enabled")
    const id = randomUUID()
    const contact = { name: "Alex", email: "alex@example.test", brokerage: "Synthetic", teamSize: "1" as const, message: "Call" }
    assert.equal(await storeDemoSubmission(id, contact), true)
    assert.equal(await notifyDemoSubmission(id, contact), true)
    assert.equal(await isDemoSubmissionTracked(id), false)
    assert.equal(sends, 1)
    assert.equal((await listDemoSubmissions())[0].notification_status, "unknown")
    assert.equal(await hasUnnotifiedDemoSubmissions(), true)
    const inbox = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/marketing/inbox.ts", "list"], { env: process.env })
    assert.equal(JSON.parse(inbox.stdout).find((row: { request_id: string }) => row.request_id === id).notification_status, "unknown")
    const migration = await readFile("drizzle/0064_demo_notification_status.sql", "utf8")
    for (const statement of migration.split("--> statement-breakpoint")) await db.query(statement)
    assert.equal(await isDemoSubmissionTracked(id), false)
    assert.equal((await listDemoSubmissions())[0].notification_status, "unknown")
    process.env.MCA_DEMO_VISIBILITY_ENABLED = "true"
    assert.equal(await retryUnsentDemoSubmissions(), 0)
    assert.equal(await deliverStoredDemoSubmission(id), false)
    assert.equal(sends, 1)
    assert.equal(await hasUnnotifiedDemoSubmissions(), true)
  } finally {
    globalThis.fetch = originalFetch
    await closeDatabaseForTests()
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
    await db.close()
  }
})

test("stored requests expose failed and unconfigured notifications; bounded retry sends once", async () => {
  const db = await createPostgresTestDatabase("demo_visibility")
  const keys = ["DATABASE_URL", "MCA_DATA_ENCRYPTION_KEY", "MCA_DEMO_NOTIFY_EMAIL", "MCA_USESEND_API_KEY", "MCA_USESEND_FROM", "MCA_DEMO_VISIBILITY_ENABLED"] as const
  const previous = keys.map(key => process.env[key])
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const warnings: string[] = []
  let sends = 0
  process.env.DATABASE_URL = db.databaseUrl
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_DEMO_VISIBILITY_ENABLED = "true"
  delete process.env.MCA_DEMO_NOTIFY_EMAIL
  console.warn = (message) => { warnings.push(String(message)) }
  try {
    const id = randomUUID()
    const contact = { name: "Alex", email: "alex@example.test", brokerage: "Synthetic", teamSize: "1" as const, message: "Call" }
    await storeDemoSubmission(id, contact)
    const inbox = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/marketing/inbox.ts", "list"], { env: process.env })
    assert.equal(JSON.parse(inbox.stdout).find((row: { request_id: string }) => row.request_id === id).notification_status, "pending")
    const shown = await promisify(execFile)(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/marketing/inbox.ts", "show", id], { env: process.env })
    assert.deepEqual(JSON.parse(shown.stdout), contact)
    assert.equal(await deliverStoredDemoSubmission(id), false)
    assert.equal((await listDemoSubmissions())[0].notification_status, "not configured")
    assert.equal(await hasUnnotifiedDemoSubmissions(), true)
    assert.equal(JSON.parse(warnings[0]).reason, "not_configured")
    process.env.MCA_DEMO_NOTIFY_EMAIL = "sales@example.test"
    process.env.MCA_USESEND_API_KEY = "test-key"
    process.env.MCA_USESEND_FROM = "sender@example.test"
    globalThis.fetch = async () => { sends++; return Response.json({ error: "synthetic failure" }, { status: 503 }) }
    assert.equal(await retryUnsentDemoSubmissions(), 0)
    assert.equal((await listDemoSubmissions())[0].notification_status, "failed")
    assert.equal(JSON.parse(warnings[1]).reason, "delivery_failed")
    globalThis.fetch = async () => { sends++; return Response.json({ emailId: "synthetic" }) }
    assert.equal(await retryUnsentDemoSubmissions(), 1)
    assert.equal(await retryUnsentDemoSubmissions(), 0)
    assert.equal(sends, 2)
    const listed = (await listDemoSubmissions())[0]
    assert.deepEqual(listed.contact, contact)
    assert.equal(listed.notification_status, "sent")
    assert.equal(listed.notification_attempts, 3)
    assert.equal(await hasUnnotifiedDemoSubmissions(), false)
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    await closeDatabaseForTests()
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index] })
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
