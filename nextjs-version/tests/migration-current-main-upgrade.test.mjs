import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";

test("current-main SMS ledger upgrades new feature migrations once without rewriting applied identity", async () => {
  const timestamp = 1790385600019;
  const smsHash = "cd74e933b3c1efbaf386369e94e14414ab99485f6a49b5ae37cf4e2f2311522f";
  const folder = await mkdtemp(join(tmpdir(), "fundlane-main-upgrade-"));
  let fixture, pool;
  try {
    const journal = JSON.parse(await readFile(resolve("drizzle/meta/_journal.json"), "utf8"));
    const entries = journal.entries.filter(entry => entry.when <= timestamp);
    assert.equal(entries.at(-1).tag, "0070_platform_super_admin");
    assert.equal(entries.at(-1).when, timestamp);
    await mkdir(join(folder, "meta"));
    await writeFile(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) await writeFile(join(folder, `${entry.tag}.sql`), await readFile(resolve("drizzle", `${entry.tag}.sql`)));
    assert.equal(createHash("sha256").update(await readFile(join(folder, "0068_sms_keyword_consent.sql"))).digest("hex"), smsHash);
    fixture = await createPostgresTestDatabase("current_main_upgrade", { migrateSchema: false });
    pool = new pg.Pool({ connectionString: fixture.databaseUrl, max: 1 });
    await pool.query("CREATE SCHEMA IF NOT EXISTS mca_private");
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const before = (await pool.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows;
    assert.equal(Number(before.at(-1).created_at), timestamp);
    const applied = [
      [1790385600017, smsHash],
      [1790385600018, "8e7ea3824ff8e83745e7f59ac327d9ffbdf3fbba8141544d41d53e38db5dffe9"],
      [1790385600019, "2688b607f19922c6fa6efe93a48bc1a2d52bd491f529f12acc4a9398b54426d1"],
    ];
    for (const [when, hash] of applied) {
      assert.equal(before.filter(row => Number(row.created_at) === when).length, 1);
      assert.equal(before.find(row => Number(row.created_at) === when).hash, hash);
    }
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    const after = (await pool.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows;
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, journal.entries.length);
    const tables = await pool.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('mca_notification_policies','mca_notification_preferences','mca_notifications','mca_notification_receipts') ORDER BY relname");
    assert.equal(tables.rows.length, 4);
    assert.ok(tables.rows.every(row => row.relrowsecurity));
    await migrate(drizzle(pool), { migrationsFolder: resolve("drizzle") });
    assert.deepEqual((await pool.query("SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at")).rows, after);
  } finally {
    try { await pool?.end(); }
    finally { try { await fixture?.close(); } finally { await rm(folder, { recursive: true, force: true }); } }
  }
});
