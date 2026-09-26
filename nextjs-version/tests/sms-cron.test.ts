import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { GET } from "../src/app/api/cron/sms/route"
import { POST as runLegacySmsJobs } from "../src/app/api/mca/sms/jobs/route"
import { runScheduledSmsJobs } from "../src/lib/mca/sms/scheduler"

const previous = { ...process.env }
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const request = (authorization?: string) => new Request("https://crm.example.test/api/cron/sms", {
  headers: authorization ? { authorization } : {},
})

before(async () => {
  database = await createPostgresTestDatabase("sms_cron")
  process.env.DATABASE_URL = database.databaseUrl
  process.env.CRON_SECRET = "synthetic-cron-secret"
})
after(async () => {
  await closeDatabaseForTests()
  await database.close()
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
  Object.assign(process.env, previous)
})

test("SMS cron defaults off and requires a configured bearer secret", async () => {
  delete process.env.MCA_SMS_CRON_ENABLED
  const disabled = await GET(request())
  assert.equal(disabled.status, 200)
  assert.deepEqual(await disabled.json(), { enabled: false })
  process.env.MCA_SMS_JOB_TOKEN = "synthetic-legacy-token"
  const legacyRequest = () => new Request("https://crm.example.test/api/mca/sms/jobs", {
    method: "POST", headers: { authorization: "Bearer synthetic-legacy-token" },
  })
  assert.equal((await runLegacySmsJobs(legacyRequest())).status, 200)

  process.env.MCA_SMS_CRON_ENABLED = "TRUE"
  assert.deepEqual(await (await GET(request())).json(), { enabled: false })
  process.env.MCA_SMS_CRON_ENABLED = "true"
  delete process.env.CRON_SECRET
  assert.equal((await GET(request())).status, 503)
  process.env.CRON_SECRET = "synthetic-cron-secret"
  assert.equal((await GET(request("Bearer wrong"))).status, 401)
  assert.equal((await runLegacySmsJobs(legacyRequest())).status, 409)
})

test("unapproved or uncredentialed cron does no provider work", async () => {
  delete process.env.MCA_SMS_ISV_APPROVED
  const disabled = await GET(request("Bearer synthetic-cron-secret"))
  assert.equal(disabled.status, 200)
  assert.equal((await disabled.json()).ready, false)
  process.env.MCA_SMS_ISV_APPROVED = "true"
  process.env.MCA_SMS_ELIGIBILITY_REFERENCE = "synthetic-approval"
  process.env.MCA_TWILIO_PRIMARY_PROFILE_SID = `BU${"a".repeat(32)}`
  delete process.env.MCA_TWILIO_PARENT_AUTH_TOKEN
  const noCredentials = await runScheduledSmsJobs(async () => { throw new Error("provider called") })
  assert.equal(noCredentials.ready, false)
})

test("one database-backed cron consumer runs and reports operation states", async () => {
  process.env.MCA_TWILIO_PARENT_ACCOUNT_SID = `AC${"a".repeat(32)}`
  process.env.MCA_TWILIO_PARENT_AUTH_TOKEN = "synthetic-only"
  const now = new Date().toISOString()
  await getDatabase().prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',5,'{}','{}','{}',?,?)").run("sms-cron-workspace", "SMS cron fixture", now, now)
  await getDatabase().prepare("INSERT INTO sms_operations (id,workspace_id,kind,request_key,payload_cipher,state,created_at,updated_at) VALUES (?,?, 'purchase', ?, ?, 'needs_review', ?, ?)").run("sms-cron-review", "sms-cron-workspace", "synthetic-review", "synthetic-only", now, now)
  const blocker = new Client({ connectionString: database.databaseUrl, ssl: false })
  await blocker.connect()
  try {
    await blocker.query("BEGIN")
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["mca:sms:scheduled"])
    const skipped = await runScheduledSmsJobs(async () => { throw new Error("provider called") })
    assert.equal(skipped.running, true)
    assert.equal(skipped.operations, 0)
  } finally {
    await blocker.query("ROLLBACK")
    await blocker.end()
  }
  const response = await GET(request("Bearer synthetic-cron-secret"))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ready, true)
  assert.equal(body.running, false)
  assert.deepEqual(body.operationStates, { needs_review: 1 })
  assert.equal(body.operations, 0)
  assert.equal(body.companies, 0)
  assert.equal(typeof body.durationMs, "number")
})
