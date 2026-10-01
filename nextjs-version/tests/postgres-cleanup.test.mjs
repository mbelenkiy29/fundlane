import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";
import { postgresConnection } from "../src/lib/mca/db-connection.ts";

test("fixture cleanup waits for a closing database session rather than forcibly terminating it", async () => {
  const fixture = await createPostgresTestDatabase("cleanup_session", { migrateSchema: false });
  const client = new pg.Client(postgresConnection(fixture.databaseUrl));
  const errors = [];
  client.on("error", error => errors.push(error));
  let cleanup;
  try {
    await client.connect();
    cleanup = fixture.close();
    const outcome = await Promise.race([
      cleanup.then(() => "dropped_before_session_closed"),
      new Promise(resolve => setTimeout(() => resolve("waiting_for_session"), 500)),
    ]);
    assert.equal(outcome, "waiting_for_session");
    assert.equal((await client.query("SELECT 1 AS alive")).rows[0].alive, 1);
    assert.deepEqual(errors, []);
    await client.end();
    await cleanup;
    assert.deepEqual(errors, []);
    const admin = new pg.Client(postgresConnection(process.env.MCA_TEST_DATABASE_ADMIN_URL));
    try {
      await admin.connect();
      assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [fixture.databaseName])).rows[0].count, 0);
    } finally { await admin.end(); }
  } finally {
    await client.end().catch(() => undefined);
    await cleanup?.catch(() => undefined);
    await fixture.close();
  }
});

test("fixture cleanup can retry after an open-session deadline without leaving its database", async () => {
  const fixture = await createPostgresTestDatabase("cleanup_retry", { migrateSchema: false });
  const client = new pg.Client(postgresConnection(fixture.databaseUrl));
  const errors = [];
  client.on("error", error => errors.push(error));
  try {
    await client.connect();
    await assert.rejects(fixture.close(), /still has open sessions/);
    assert.equal((await client.query("SELECT 1 AS alive")).rows[0].alive, 1);
    await client.end();
    await fixture.close();
    assert.deepEqual(errors, []);
    const admin = new pg.Client(postgresConnection(process.env.MCA_TEST_DATABASE_ADMIN_URL));
    try {
      await admin.connect();
      assert.equal((await admin.query("SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1", [fixture.databaseName])).rows[0].count, 0);
    } finally { await admin.end(); }
  } finally {
    await client.end().catch(() => undefined);
    await fixture.close();
  }
});
