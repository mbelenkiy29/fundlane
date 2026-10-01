import test, { after } from "node:test"
import assert from "node:assert/strict"
import pg from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { EMAIL, seedBen } from "../scripts/demo/seed-ben"
import {
  closeDatabaseForTests,
  getDatabase,
  setTestLegacyDeadlineTransactions,
  setTestWireQueryDelayMs,
} from "../src/lib/mca/db"
import { GET as runCron } from "../src/app/api/cron/jobs/route"
import { withExecutionDeadline } from "../src/lib/mca/jobs/execution"
import { enqueueBackgroundJob } from "../src/lib/mca/jobs/queue"
import { createExportJob } from "../src/lib/mca/exports/service"
import type { DealActor } from "../src/lib/mca/deals/schema"

const WORKSPACE = "ben-test"
const DELAY_MS = 15
const actor = (): DealActor => ({
  workspaceId: WORKSPACE,
  userId: null,
  membershipId: null,
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: "system",
  correlationId: "cron-export-pool-timeout",
})

async function runJobsCron() {
  return runCron(new Request("http://localhost/api/cron/jobs", { headers: { authorization: "Bearer synthetic-cron-secret" } }))
}

test("all_deals_owners export_create through cron survives pool=2 after the per-statement transaction wrap is removed", { timeout: 180_000 }, async () => {
  const previous = {
    databaseUrl: process.env.DATABASE_URL,
    poolMax: process.env.MCA_DB_POOL_MAX,
    runtime: process.env.MCA_JOB_RUNTIME,
    secret: process.env.CRON_SECRET,
    kinds: process.env.MCA_JOB_RUNTIME_KINDS,
    jobs: process.env.MCA_BACKGROUND_JOBS,
    vercel: process.env.VERCEL,
  }
  const fixture = await createPostgresTestDatabase("cron_export_pool")
  Object.assign(process.env, fixture.env({ MCA_DB_POOL_MAX: "2" }))
  process.env.MCA_BACKGROUND_JOBS = "enabled"
  process.env.MCA_JOB_RUNTIME = "vercel_cron"
  process.env.CRON_SECRET = "synthetic-cron-secret"
  process.env.MCA_JOB_RUNTIME_KINDS = "export_create"
  delete process.env.VERCEL
  const client = new pg.Client({ connectionString: fixture.databaseUrl })
  await client.connect()
  const now = "2026-09-16T16:00:00.000Z"
  try {
    await client.query(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES ($1,'Ben demo export','America/New_York',5,'{"payments":false,"reports":true}','{"payments":true,"deals":true}',
      '{"createDeal":true,"exportDeals":true,"inviteUsers":true,"manageApiKeys":true,"viewPaymentTable":true,"viewCompanyFinancials":true}',$2,$2)`, [WORKSPACE, now])
    await client.query(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES ('ben-user',$1,'Ben','APP-BEN',$2,$2)`, [EMAIL, now])
    await client.query(`INSERT INTO memberships (id,user_id,workspace_id,role,status,created_at,updated_at) VALUES ('ben-member','ben-user',$1,'admin','active',$2,$2)`, [WORKSPACE, now])
    const seeded = await seedBen(client, { apply: true, expectedWorkspace: WORKSPACE, asOf: "2026-09-16" })
    assert.equal(seeded.mode, "created")
    assert.equal(seeded.manifest.counts.deals, 120)
    await closeDatabaseForTests()
    process.env.MCA_DB_POOL_MAX = "2"

    setTestWireQueryDelayMs(DELAY_MS)
    setTestLegacyDeadlineTransactions(true)
    await assert.rejects(
      withExecutionDeadline(
        () => createExportJob(actor(), { kind: "all_deals_owners", correlationId: "legacy-per-statement-txn" }),
        undefined,
        230_000,
      ),
      /timeout exceeded when trying to connect/,
    )

    await closeDatabaseForTests()
    process.env.MCA_DB_POOL_MAX = "2"
    setTestLegacyDeadlineTransactions(false)
    setTestWireQueryDelayMs(DELAY_MS)
    const queued = await enqueueBackgroundJob({
      actor: actor(),
      kind: "export_create",
      resourceId: WORKSPACE,
      idempotencyKey: "cron-export-pool-timeout",
      payload: { kind: "all_deals_owners", correlationId: "cron-export-pool-timeout" },
    })
    const fixed = await runJobsCron()
    const body = await fixed.json() as { processed?: number; error?: unknown }
    assert.equal(fixed.status, 200, JSON.stringify(body))
    assert.equal(body.processed, 1)
    const job = await getDatabase().prepare<{ state: string; error_code: string | null }>("SELECT state,error_code FROM mca_background_jobs WHERE id=?").get(queued.id)
    assert.equal(job?.state, "complete")
    assert.equal(job?.error_code, null)
    const exported = await getDatabase().prepare<{ row_count: number; kind: string }>("SELECT row_count,kind FROM mca_export_jobs WHERE workspace_id=? AND correlation_id=?").get(WORKSPACE, "cron-export-pool-timeout")
    assert.equal(exported?.kind, "all_deals_owners")
    assert.equal(exported?.row_count, 120)
  } finally {
    setTestWireQueryDelayMs(0)
    setTestLegacyDeadlineTransactions(false)
    await client.end()
    await closeDatabaseForTests()
    await fixture.close()
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous.databaseUrl
    if (previous.poolMax === undefined) delete process.env.MCA_DB_POOL_MAX
    else process.env.MCA_DB_POOL_MAX = previous.poolMax
    if (previous.runtime === undefined) delete process.env.MCA_JOB_RUNTIME
    else process.env.MCA_JOB_RUNTIME = previous.runtime
    if (previous.secret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previous.secret
    if (previous.kinds === undefined) delete process.env.MCA_JOB_RUNTIME_KINDS
    else process.env.MCA_JOB_RUNTIME_KINDS = previous.kinds
    if (previous.jobs === undefined) delete process.env.MCA_BACKGROUND_JOBS
    else process.env.MCA_BACKGROUND_JOBS = previous.jobs
    if (previous.vercel === undefined) delete process.env.VERCEL
    else process.env.VERCEL = previous.vercel
  }
})

after(() => {
  setTestWireQueryDelayMs(0)
  setTestLegacyDeadlineTransactions(false)
})
