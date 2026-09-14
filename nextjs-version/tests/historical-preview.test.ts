import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { createSupabaseHttpFixture } from "./helpers/supabase-http.mjs"
import { closeDatabaseForTests } from "../src/lib/mca/db"
import { postgresConnection } from "../src/lib/mca/db-connection"
import { previewHistoricalImport } from "../src/lib/mca/historical/service"
import type { DealActor } from "../src/lib/mca/deals/schema"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let auth: Awaited<ReturnType<typeof createSupabaseHttpFixture>>
let actor: DealActor
const base = "http://localhost:3000"
const row = (id: string) => ({ externalId: id, legalName: "Synthetic Merchant", funderName: "Synthetic Funder", fundedAt: "2025-01-01", amountCents: 10000 })

before(async () => {
  database = await createPostgresTestDatabase("historical_preview")
  auth = await createSupabaseHttpFixture(database)
  Object.assign(process.env, database.env(), auth.env, { MCA_APP_ORIGIN: base })
  await auth.login("historical-preview@example.test", "Synthetic Preview Password 99!")
  const member = await queryRow<{ workspace_id: string; id: string; user_id: string }>("SELECT * FROM memberships ORDER BY created_at LIMIT 1")
  actor = { workspaceId: member.workspace_id, membershipId: member.id, userId: member.user_id, role: "admin", source: "user", managedMembershipIds: [], activeMembershipIds: [member.id], correlationId: "historical-test" }
})
after(async () => { await auth?.close(); await closeDatabaseForTests(); await database?.close() })

async function queryRow<T>(sql: string, values: string[] = []): Promise<T> {
  return (await database.query(sql, values)).rows[0] as T
}

test("duplicates stay scoped by workspace and source; missing deal IDs are row errors", async () => {
  const input = { sourceId: "duplicates", batchId: "first", rows: [row("same"), row("same"), { ...row("inaccessible"), dealId: "missing-deal" }, { ...row("inaccessible-again"), dealId: "missing-deal" }] }
  const preview = await previewHistoricalImport(actor, input)
  assert.equal(preview.totals.valid, 1)
  assert.equal(preview.totals.duplicates, 1)
  assert.equal(preview.totals.invalid, 2)
  assert.match(preview.rows[2].errors.join(" "), /not accessible/)
  const duplicate = await previewHistoricalImport(actor, { ...input, batchId: "second", rows: [row("same")] })
  assert.equal(duplicate.totals.duplicates, 1)
  const otherSource = await previewHistoricalImport(actor, { ...input, sourceId: "other-source", rows: [row("same")] })
  assert.equal(otherSource.totals.valid, 1)
  const otherLogin = await auth.login("historical-other@example.test", "Synthetic Preview Password 99!")
  assert.ok(otherLogin.cookie)
  const other = await queryRow<{ workspace_id: string; id: string; user_id: string }>("SELECT m.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email=$1", ["historical-other@example.test"])
  const otherActor = { ...actor, workspaceId: other.workspace_id, userId: other.user_id, membershipId: other.id, activeMembershipIds: [other.id] }
  assert.equal((await previewHistoricalImport(otherActor, { ...input, rows: [row("same")] })).totals.valid, 1)
})

test("concurrent previews reserve each external ID once and same-batch retries share one run", async () => {
  const input = { sourceId: "concurrent", batchId: "same", rows: Array.from({ length: 501 }, (_, i) => row(`bulk-${i}`)) }
  const [first, replay] = await Promise.all([previewHistoricalImport(actor, input), previewHistoricalImport(actor, input)])
  assert.equal(first.runId, replay.runId)
  assert.equal(first.totals.valid, 501)
  assert.equal(replay.rows.length, 501)
  const [a, b] = await Promise.all(["a", "b"].map((batchId) => previewHistoricalImport(actor, { sourceId: "competing", batchId, rows: [row("competing")] })))
  assert.equal(a.totals.valid + b.totals.valid, 1)
  assert.equal(a.totals.duplicates + b.totals.duplicates, 1)
})

test("a lock timeout rolls back staged run and rows; the same batch can safely retry", { timeout: 20_000 }, async () => {
  const blocker = new Client(postgresConnection(database.databaseUrl))
  await blocker.connect()
  await blocker.query("BEGIN")
  await blocker.query("LOCK TABLE mca_historical_import_rows IN SHARE MODE")
  const input = { sourceId: "locked", batchId: "retry", rows: [row("locked-row")] }
  try {
    await assert.rejects(previewHistoricalImport(actor, input), (error: unknown) => {
      assert.equal((error as { status: number }).status, 503)
      assert.match((error as Error).message, /Retry with the same file/)
      return true
    })
    assert.equal(Number((await queryRow<{ count: string }>("SELECT count(*) FROM mca_historical_import_runs WHERE source_id='locked'")).count), 0)
  } finally { await blocker.query("ROLLBACK"); await blocker.end() }
  const recovered = await previewHistoricalImport(actor, input)
  assert.equal(recovered.totals.valid, 1)
  assert.equal((await previewHistoricalImport(actor, input)).runId, recovered.runId)
  assert.equal(Number((await queryRow<{ count: string }>("SELECT count(*) FROM mca_historical_import_rows WHERE source_id='locked'")).count), 1)
})
