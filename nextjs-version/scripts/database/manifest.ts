import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Only checked application migrations define transferable tables. No provider-owned schemas. */
export function applicationTables(migrations = resolve('drizzle')): string[] {
  const journal = JSON.parse(readFileSync(resolve(migrations, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const tables = new Set<string>();
  for (const { tag } of journal.entries) {
    const sql = readFileSync(resolve(migrations, `${tag}.sql`), 'utf8');
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi)) tables.add(match[1]);
  }
  return [...tables].sort();
}
