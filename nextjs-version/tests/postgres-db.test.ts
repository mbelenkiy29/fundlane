import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
let originalDatabaseUrl: string | undefined;
let originalPoolMax: string | undefined;

before(async () => {
  fixture = await createPostgresTestDatabase("db_contract");
  originalDatabaseUrl = process.env.DATABASE_URL;
  originalPoolMax = process.env.MCA_DB_POOL_MAX;
  process.env.DATABASE_URL = fixture.databaseUrl;
  process.env.MCA_DB_POOL_MAX = "4";
});

after(async () => {
  const { closeDatabaseForTests } = await import("../src/lib/mca/db");
  await closeDatabaseForTests();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalPoolMax === undefined) delete process.env.MCA_DB_POOL_MAX;
  else process.env.MCA_DB_POOL_MAX = originalPoolMax;
  await fixture.close();
});

test("placeholder conversion skips strings, identifiers, dollar quotes, and nested comments", async () => {
  const { postgresPlaceholders } = await import("../src/lib/mca/db");
  const sql = `select ?, '?' literal, "?" identifier, $$?$$ dollar,
    $tag$?$tag$ tagged, E'escaped\\'?still' escape
    -- ? line
    /* ? outer /* ? inner */ done */ where value = ?`;
  assert.equal(
    postgresPlaceholders(sql),
    `select $1, '?' literal, "?" identifier, $$?$$ dollar,
    $tag$?$tag$ tagged, E'escaped\\'?still' escape
    -- ? line
    /* ? outer /* ? inner */ done */ where value = $2`,
  );
});

test("transactions keep nested operations on one client, see their writes, and roll back failures", async () => {
  const { getDatabase, withTransaction } = await import("../src/lib/mca/db");
  await getDatabase().execute("CREATE TABLE transaction_probe (id text PRIMARY KEY, value text NOT NULL)");

  await assert.rejects(
    withTransaction(async (tx) => {
      const outerPid = await tx.queryOne<{ pid: number }>("SELECT pg_backend_pid() pid");
      await tx.execute("INSERT INTO transaction_probe (id, value) VALUES (?, ?)", ["rolled-back", "visible"]);
      const nestedPid = await getDatabase().queryOne<{ pid: number }>("SELECT pg_backend_pid() pid");
      const ownWrite = await getDatabase().queryOne<{ value: string }>("SELECT value FROM transaction_probe WHERE id = ?", ["rolled-back"]);
      assert.equal(nestedPid?.pid, outerPid?.pid);
      assert.equal(ownWrite?.value, "visible");
      throw new Error("injected failure after write and read");
    }),
    /injected failure/,
  );

  const missing = await getDatabase().queryOne("SELECT id FROM transaction_probe WHERE id = ?", ["rolled-back"]);
  assert.equal(missing, undefined);

  await withTransaction(async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      getDatabase().execute("INSERT INTO transaction_probe (id, value) VALUES (?, ?)", [`concurrent-${index}`, `value-${index}`]),
    ));
    await getDatabase().execute("INSERT INTO transaction_probe (id, value) VALUES (?, ?)", ["committed", "kept"]);
    await withTransaction(async (nested) => {
      const row = await nested.queryOne<{ value: string }>("SELECT value FROM transaction_probe WHERE id = ?", ["committed"]);
      assert.equal(row?.value, "kept");
    });
  });
  assert.equal((await getDatabase().queryOne<{ value: string }>("SELECT value FROM transaction_probe WHERE id = ?", ["committed"]))?.value, "kept");
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM transaction_probe WHERE id LIKE 'concurrent-%'"))?.count, 8);
});
