import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { targetFromArgs, targetUrl } from "./connections";

async function main(): Promise<void> {
  const target = targetFromArgs();
  const pool = new Pool({
    connectionString: targetUrl(target, true),
    max: 1,
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
  });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    process.stdout.write(`Applied checked Drizzle migrations to the ${target} branch.\n`);
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
