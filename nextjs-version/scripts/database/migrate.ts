import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { assertMigrationDestination, postgresConnection, requiredUrl } from './connections';

async function main() {
  const destination = requiredUrl('DATABASE_URL_UNPOOLED');
  assertMigrationDestination(destination);
  const pool = new Pool({ ...postgresConnection(destination), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve('drizzle') });
    console.log('Checked application migrations applied.');
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed.'); process.exitCode = 1; });
