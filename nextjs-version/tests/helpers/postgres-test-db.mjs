import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { directUrl, pooledUrl, protectedConnections, urlForDatabase } from "../../scripts/neon/connections.ts";

const { Client, Pool } = pg;

function identifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe Postgres database identifier.");
  return `"${value}"`;
}

export async function createPostgresTestDatabase(label = "suite") {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "suite";
  const databaseName = `fundlane_test_${safeLabel}_${randomBytes(5).toString("hex")}`;
  const connections = protectedConnections();
  const adminUrl = directUrl(connections.verification);
  const admin = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  await admin.connect();
  try {
    const current = await admin.query("select current_database() as database, current_user as role");
    if (current.rows[0]?.database !== "fundlane") throw new Error("Test administration must run from the Fundlane verification database.");
    await admin.query(`CREATE DATABASE ${identifier(databaseName)}`);
  } finally {
    await admin.end();
  }

  const databaseUrlUnpooled = urlForDatabase(adminUrl, databaseName);
  const databaseUrl = pooledUrl(databaseUrlUnpooled);
  const migrationPool = new Pool({ connectionString: databaseUrlUnpooled, max: 1, ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: resolve(process.cwd(), "drizzle") });
  } catch (error) {
    await migrationPool.end();
    await dropDatabase(adminUrl, databaseName);
    throw error;
  }
  await migrationPool.end();

  let queryPool = new Pool({ connectionString: databaseUrl, max: 4, ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  let closed = false;
  return {
    databaseName,
    databaseUrl,
    databaseUrlUnpooled,
    env(overrides = {}) {
      return { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_UNPOOLED: databaseUrlUnpooled, MCA_DB_POOL_MAX: "4", ...overrides };
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
  const admin = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${identifier(databaseName)} WITH (FORCE)`); }
  finally { await admin.end(); }
}
