import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { postgresConnection } from "../../src/lib/mca/db-connection.ts";

const { Client, Pool } = pg;

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe Postgres database identifier.");
  return `"${value}"`;
}

export async function createPostgresTestDatabase(label = "suite") {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "suite";
  const databaseName = `fundlane_test_${safeLabel}_${randomBytes(5).toString("hex")}`;
  const adminUrl = process.env.MCA_TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error("MCA_TEST_DATABASE_ADMIN_URL must point at an isolated disposable Postgres cluster; production fallback is prohibited.");
  const endpoint = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) && process.env.MCA_TEST_DATABASE_DISPOSABLE !== "true") throw new Error("Remote tests require an explicitly disposable cluster.");
  const admin = new Client(postgresConnection(adminUrl));
  await admin.connect();
  try {
    const current = await admin.query("select current_database() as database, current_user as role");
    if (!current.rows[0]?.database) throw new Error("Test administration database is unavailable.");
    await admin.query(`CREATE DATABASE ${identifier(databaseName)} TEMPLATE template0 ENCODING 'UTF8'`);
  } finally {
    await admin.end();
  }

  endpoint.pathname = `/${databaseName}`;
  const databaseUrlUnpooled = endpoint.toString();
  const databaseUrl = databaseUrlUnpooled;
  const migrationPool = new Pool({ ...postgresConnection(databaseUrlUnpooled), max: 1 });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } catch (error) {
    await migrationPool.end();
    await dropDatabase(adminUrl, databaseName);
    throw error;
  }
  await migrationPool.end();

  let queryPool = new Pool({ ...postgresConnection(databaseUrl), max: 4 });
  let closed = false;
  return {
    databaseName,
    databaseUrl,
    databaseUrlUnpooled,
    env(overrides = {}) {
      return { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrlUnpooled, MCA_DB_POOL_MAX: "4", MCA_DOCUMENT_STORAGE_PROVIDER: "filesystem", ...overrides };
    },
    query(text, values = []) { return queryPool.query(text, values); },
    async close() {
      if (closed) return;
      closed = true;
      await queryPool.end();
      queryPool = null;
      await dropDatabase(adminUrl, databaseName);
    },
  };
}

async function dropDatabase(adminUrl, databaseName) {
  const admin = new Client(postgresConnection(adminUrl));
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`); }
  finally { await admin.end(); }
}
