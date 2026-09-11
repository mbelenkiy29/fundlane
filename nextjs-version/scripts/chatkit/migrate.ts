/** Release-specific additive migration; ignores runtime DATABASE_URL overrides. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { Client } from "pg"
import { directUrl, protectedConnections } from "../neon/connections"

async function main() {
  const target = process.argv.find(arg => arg.startsWith("--target="))?.split("=")[1]
  assert.ok(target === "production" || target === "verification", "Specify an explicit target")
  const apply = process.argv.includes("--apply"), connections = protectedConnections()
  assert.notEqual(new URL(connections.production).hostname, new URL(connections.verification).hostname)
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries as { tag: string; when: number }[]
  const release = journal.findIndex(entry => entry.tag === "0024_chatkit")
  assert.equal(release, 24)
  const entries = journal.slice(0, release + 1).map(entry => {
    const sql = readFileSync(`drizzle/${entry.tag}.sql`, "utf8")
    return { ...entry, sql, hash: createHash("sha256").update(sql).digest("hex") }
  })
  const db = new Client({ connectionString: directUrl(connections[target]), ssl: { rejectUnauthorized: true }, enableChannelBinding: true })
  await db.connect()
  try {
    await db.query("BEGIN")
    await db.query("SET LOCAL lock_timeout='5s'")
    await db.query("SET LOCAL statement_timeout='30s'")
    await db.query("SELECT pg_advisory_xact_lock(hashtext('mca-chatkit-release-migration'))")
    assert.equal((await db.query("SELECT current_database() AS name")).rows[0].name, "fundlane")
    await db.query("LOCK TABLE drizzle.__drizzle_migrations IN EXCLUSIVE MODE")
    const history = (await db.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows
    assert.ok(history.length === release || history.length === release + 1, "Unexpected migration history")
    history.forEach((row, i) => {
      assert.equal(row.hash, entries[i].hash, `Migration hash mismatch at ${i}`)
      assert.equal(Number(row.created_at), entries[i].when)
    })
    const tables = ["mca_chatkit_items", "mca_chatkit_references", "mca_chatkit_requests", "mca_chatkit_threads"]
    if (history.length === release) {
      assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)", [tables])).rowCount, 0, "Partial schema exists")
      for (const sql of entries[release].sql.split("--> statement-breakpoint")) {
        assert.match(sql.trim(), /^(CREATE TABLE "mca_chatkit_|ALTER TABLE "mca_chatkit_|CREATE INDEX "mca_chatkit_)/)
        await db.query(sql)
      }
      await db.query("INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)", [entries[release].hash, entries[release].when])
    }
    assert.equal((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)", [tables])).rowCount, 4)
    assert.equal((await db.query("SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid IN (SELECT oid FROM pg_class WHERE relname=ANY($1) AND relnamespace='public'::regnamespace)", [tables])).rowCount, 6)
    assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)", [tables])).rowCount, 7)
    await db.query(apply ? "COMMIT" : "ROLLBACK")
    console.log(JSON.stringify({ target, branch: target === "production" ? connections.productionBranch : connections.verificationBranch, migration: entries[release].tag, hash: entries[release].hash, priorHistoryVerified: release, tables: 4, foreignKeys: 6, indexes: 7, result: apply ? "applied-and-verified" : "transactional-rehearsal-rolled-back" }))
  } catch (error) { await db.query("ROLLBACK"); throw error }
  finally { await db.end() }
}
void main().catch(() => { console.error("ChatKit migration failed; transaction rolled back. Inspect migration history and schema before retrying."); process.exitCode = 1 })
