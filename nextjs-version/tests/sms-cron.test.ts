import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { Client } from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { GET } from "../src/app/api/cron/sms/route"
import { POST as runLegacySmsJobs } from "../src/app/api/mca/sms/jobs/route"
import { runScheduledSmsJobs } from "../src/lib/mca/sms/scheduler"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { reviewQueue } from "../src/lib/mca/sms/onboarding"
import type { TwilioApi } from "../src/lib/mca/sms/provisioning"

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

test("bounded refresh rotates after failed calls without changing the review queue", async () => {
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_PLATFORM_OPERATOR_USER_IDS = "sms-cron-first-owner"
  const refreshed: string[] = []
  for (const [index, id] of ["sms-cron-first", "sms-cron-second", "sms-cron-third"].entries()) {
    const sid = `AC${String(index + 1).repeat(32)}`
    await getDatabase().prepare("INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run(`${id}-owner`, `${id}@example.test`, "SMS cron owner", id, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z")
    await getDatabase().prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',5,'{}','{}','{}',?,?)")
      .run(id, id, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z")
    const config = { accountSid: sid, authToken: "synthetic", ...(index === 2 ? { serviceSid: `MG${"3".repeat(32)}`, campaignSid: `QE${"3".repeat(32)}` } : {}) }
    await getDatabase().prepare("INSERT INTO sms_companies (workspace_id,owner_user_id,provider_cipher,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(id, `${id}-owner`, encryptSensitive(JSON.stringify(config), id), "2020-01-01T00:00:00.000Z", `2020-01-0${index + 1}T00:00:00.000Z`)
  }
  // The pending company is exactly the 100th review row. Routine refreshes
  // must not push it out of the bounded operator queue.
  await getDatabase().prepare("UPDATE sms_companies SET review_state='pending',registration_state='approved' WHERE workspace_id=?").run("sms-cron-third")
  await getDatabase().prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) SELECT 'sms-cron-filler-'||n,'SMS filler','America/New_York',5,'{}','{}','{}','2020-01-04T00:00:00.000Z','2020-01-04T00:00:00.000Z' FROM generate_series(1,99) AS n").run()
  await getDatabase().prepare("INSERT INTO sms_companies (workspace_id,owner_user_id,created_at,updated_at) SELECT 'sms-cron-filler-'||n,'sms-cron-first-owner','2020-01-04T00:00:00.000Z','2020-01-04T00:00:00.000Z' FROM generate_series(1,99) AS n").run()
  let failRefresh = true
  const api: TwilioApi = async (config, _host, path) => {
    if (path.includes("/Compliance/Usa2p/")) {
      refreshed.push(config!.accountSid)
      if (failRefresh) throw new Error("synthetic provider failure")
    }
    return path.includes("/Compliance/Usa2p/") ? { campaign_status: "VERIFIED" } : { usage_records: [] }
  }
  const first = await runScheduledSmsJobs(api)
  assert.equal(first.companies, 2)
  assert.deepEqual(refreshed, [])
  const firstCompany = await getDatabase().prepare<{ updated_at: string; refresh_attempted_at: string | null }>("SELECT updated_at,refresh_attempted_at FROM sms_companies WHERE workspace_id=?").get("sms-cron-first")
  assert.equal(firstCompany?.updated_at, "2020-01-01T00:00:00.000Z")
  assert.ok(firstCompany?.refresh_attempted_at)
  const queue = await reviewQueue({ authType: "session", userId: "sms-cron-first-owner", membershipId: null, workspaceId: "sms-cron-first", role: null, scopes: [], sessionId: null })
  assert.equal(queue.companies.length, 100)
  assert.ok(queue.companies.some((company) => company.workspaceId === "sms-cron-third" && company.reviewState === "pending"))
  const second = await runScheduledSmsJobs(api)
  assert.equal(second.companies, 2)
  assert.deepEqual(refreshed, [`AC${"3".repeat(32)}`])
  assert.deepEqual(second.failedWorkspaces, ["sms-cron-third"])
  const failedCompany = await getDatabase().prepare<{ updated_at: string; refresh_attempted_at: string | null }>("SELECT updated_at,refresh_attempted_at FROM sms_companies WHERE workspace_id=?").get("sms-cron-third")
  assert.equal(failedCompany?.updated_at, "2020-01-03T00:00:00.000Z")
  assert.ok(failedCompany?.refresh_attempted_at)
  failRefresh = false
  const third = await runScheduledSmsJobs(api)
  assert.equal(third.companies, 2)
  assert.deepEqual(third.failedWorkspaces, [])
  assert.deepEqual(refreshed, [`AC${"3".repeat(32)}`, `AC${"3".repeat(32)}`])
  const unchangedCompany = await getDatabase().prepare<{ updated_at: string }>("SELECT updated_at FROM sms_companies WHERE workspace_id=?").get("sms-cron-third")
  assert.equal(unchangedCompany?.updated_at, "2020-01-03T00:00:00.000Z")
})
