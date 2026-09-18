import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { claimWorkerExecution, releaseWorkerExecution } from "../src/lib/mca/jobs/edge-control"
import { withExecutionDeadline } from "../src/lib/mca/jobs/execution"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
before(async () => {
  fixture = await createPostgresTestDatabase("edge_controls")
  await fixture.query(`DO $$ BEGIN
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='mca_app') THEN CREATE ROLE mca_app LOGIN; END IF;
  END $$`)
  await fixture.query(readFileSync("supabase/migrations/20260914133456_edge_worker_foundation.sql", "utf8"))
  const url = new URL(fixture.databaseUrl); url.username = "mca_app"
  process.env.DATABASE_URL = url.toString()
})
after(async () => { await closeDatabaseForTests(); await fixture?.close() })

test("new workers are inactive and runtime credentials cannot enable them", async () => {
  assert.equal(await claimWorkerExecution("messaging"),null)
  await assert.rejects(getDatabase().execute("UPDATE mca_private.worker_controls SET enabled=true WHERE subsystem='messaging'"), /permission denied/)
})
test("concurrent admissions enforce the configured limit and revoked generations cannot write", async () => {
  await fixture.query("UPDATE mca_private.worker_controls SET enabled=true WHERE subsystem='messaging'")
  const attempts = await Promise.all(Array.from({length:8},()=>claimWorkerExecution("messaging")))
  const active = attempts.filter(item=>item!==null)
  assert.equal(active.length,4)
  const execution = active[0]!
  await withExecutionDeadline(async () => { assert.equal((await getDatabase().queryOne<{value:number}>("SELECT 1 AS value"))?.value,1) },undefined,90000,execution)
  await fixture.query("UPDATE mca_private.worker_controls SET generation=generation+1 WHERE subsystem='messaging'")
  await assert.rejects(withExecutionDeadline(()=>getDatabase().execute("UPDATE mca_private.worker_executions SET expires_at=now()+interval '1 hour' WHERE token=$1",[execution.token]),undefined,90000,execution), /generation/)
  await Promise.all(active.map(releaseWorkerExecution))
  assert.ok(await claimWorkerExecution("messaging"))
})
