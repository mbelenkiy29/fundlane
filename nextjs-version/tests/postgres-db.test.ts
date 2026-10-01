import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";
import { attachDeadlineStatementTimeout } from "../src/lib/mca/db";
import { withExecutionDeadline } from "../src/lib/mca/jobs/execution";

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

test("rollback callbacks await the outer rollback and released client, detach context, and preserve errors", { timeout: 20000 }, async (t) => {
  const { getDatabase, withTransaction, closeDatabaseForTests } = await import("../src/lib/mca/db");
  await closeDatabaseForTests();
  process.env.MCA_DB_POOL_MAX = "1";
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  try {
    await getDatabase().execute("CREATE TABLE rollback_probe (id text PRIMARY KEY)");
    const original = new Error("original transaction failure");
    let calls = 0;
    await assert.rejects(withTransaction(async tx => {
      await tx.execute("INSERT INTO rollback_probe VALUES ('rolled-back')");
      await withTransaction(async nested => { assert.equal(nested, tx); }, { onRollback: async () => {
        calls++;
        assert.notEqual(getDatabase(), tx);
        assert.equal(await getDatabase().queryOne("SELECT id FROM rollback_probe WHERE id='rolled-back'"), undefined);
        await withTransaction(db => db.execute("INSERT INTO rollback_probe VALUES ('callback')"));
      } });
      await withTransaction(async () => {}, { onRollback: async () => { throw new Error("callback failed"); } });
      await withTransaction(async () => {}, { onRollback: async () => { calls++; } });
      assert.equal(calls, 0);
      throw original;
    }), actual => actual === original);
    assert.equal(calls, 2, "one failed callback does not skip the rest");
    assert.ok(await getDatabase().queryOne("SELECT id FROM rollback_probe WHERE id='callback'"));
    assert.ok(logs.some(args => String(args[0]).includes("transaction_rollback_callback_failed")));
    await withTransaction(async () => {
      await withTransaction(async () => {}, { onRollback: async () => { calls++; } });
    }, { onRollback: async () => { calls++; } });
    assert.equal(calls, 2, "committed transactions discard callbacks");
  } finally {
    await closeDatabaseForTests();
    process.env.MCA_DB_POOL_MAX = "4";
  }
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

test("runOutsideTransaction uses the pool while an outer transaction is open", async () => {
  const { getDatabase, runOutsideTransaction, withTransaction } = await import("../src/lib/mca/db");
  await getDatabase().execute("CREATE TABLE outside_txn_probe (id text PRIMARY KEY)");
  await withTransaction(async (tx) => {
    await tx.execute("INSERT INTO outside_txn_probe (id) VALUES (?)", ["uncommitted"]);
    assert.equal(getDatabase(), tx);
    await runOutsideTransaction(async () => {
      assert.notEqual(getDatabase(), tx);
      assert.equal(await getDatabase().queryOne("SELECT id FROM outside_txn_probe WHERE id = ?", ["uncommitted"]), undefined);
    });
  });
  assert.equal((await getDatabase().queryOne<{ id: string }>("SELECT id FROM outside_txn_probe WHERE id = ?", ["uncommitted"]))?.id, "uncommitted");
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

test("deadline SQL rewrite keeps WITH / WITH RECURSIVE valid and does not add result columns", () => {
  const select = attachDeadlineStatementTimeout("SELECT id FROM deals WHERE workspace_id = $1", ["ws"], 1_500);
  assert.equal(select.text, "WITH mca_statement_timeout AS MATERIALIZED (SELECT set_config('statement_timeout', $2, true)) SELECT id FROM deals WHERE workspace_id = $1");
  assert.deepEqual(select.values, ["ws", "1500ms"]);
  const existing = attachDeadlineStatementTimeout("WITH candidate AS (SELECT id FROM jobs) UPDATE jobs j SET state='running' FROM candidate c WHERE j.id=c.id RETURNING j.id", [], 200);
  assert.match(existing.text, /^WITH mca_statement_timeout AS MATERIALIZED \(SELECT set_config\('statement_timeout', \$1, true\)\), candidate AS /);
  const recursive = attachDeadlineStatementTimeout("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<3) SELECT max(n)::int n FROM t", [], 90);
  assert.match(recursive.text, /^WITH RECURSIVE mca_statement_timeout AS MATERIALIZED \(SELECT set_config\('statement_timeout', \$1, true\)\), t\(n\) AS /);
});

test("deadline pool queries apply statement_timeout without a dedicated transaction or leaked session GUC", { timeout: 20000 }, async () => {
  const { AppError } = await import("../src/lib/mca/errors");
  const { getDatabase, withTransaction } = await import("../src/lib/mca/db");
  await withExecutionDeadline(async () => {
    const recursive = await getDatabase().queryOne<{ n: number }>("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM t WHERE n<3) SELECT max(n)::int n FROM t");
    assert.equal(recursive?.n, 3);
  }, undefined, 10_000);
  await assert.rejects(
    withExecutionDeadline(() => getDatabase().query("SELECT pg_sleep(2)"), undefined, 250),
    (error: unknown) => error instanceof AppError && error.code === "execution_expired",
  );
  const leaked = await getDatabase().queryOne<{ statement_timeout: string }>("SHOW statement_timeout");
  assert.ok(["0", "0ms", "0s"].includes(leaked?.statement_timeout ?? ""));
  await withTransaction(async (tx) => {
    const first = await tx.queryOne<{ pid: number }>("SELECT pg_backend_pid() pid");
    const second = await getDatabase().queryOne<{ pid: number }>("SELECT pg_backend_pid() pid");
    assert.equal(first?.pid, second?.pid);
  });
});
