import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { targetFromArgs, targetUrl } from "./connections";
import { APP_TABLES, quoteColumn, quoteIdentifier } from "./table-inventory";

type SqliteRow = Record<string, string | number | bigint | null>;

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function sourcePath(): string {
  return resolve(argument("source") ?? process.env.MCA_SQLITE_SNAPSHOT ?? "data/mca-pre-neon-20260908T164321Z.sqlite");
}

function snapshotSha256(path: string): string {
  const digest = createHash("sha256").update(readFileSync(path));
  const wal = `${path}-wal`;
  if (existsSync(wal)) digest.update(readFileSync(wal));
  return digest.digest("hex");
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? JSON.stringify(number) : JSON.stringify(value.toString());
  }
  if (typeof value === "number" && Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

function rowDigest(rowsByTable: Map<string, { columns: string[]; rows: SqliteRow[] }>): string {
  const hash = createHash("sha256");
  for (const table of APP_TABLES) {
    const data = rowsByTable.get(table);
    hash.update(`${table}\n`);
    if (!data) continue;
    hash.update(`${data.columns.join(",")}\n`);
    for (const row of data.rows) hash.update(`${data.columns.map((column) => canonical(row[column])).join("|")}\n`);
  }
  return hash.digest("hex");
}

function readSource(path: string) {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const declared = new Set<string>(APP_TABLES);
  const sourceTables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  for (const table of sourceTables) {
    if (declared.has(table)) continue;
    const count = Number((sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteColumn(table)}`).get() as { count: number }).count);
    if (count > 0) throw new Error(`Unexpected populated SQLite table: ${table}`);
  }
  const rowsByTable = new Map<string, { columns: string[]; rows: SqliteRow[] }>();
  for (const table of APP_TABLES) {
    if (!sourceTables.includes(table)) continue;
    const columns = (sqlite.prepare(`PRAGMA table_info(${quoteColumn(table)})`).all() as Array<{ name: string; pk: number }>)
      .map(({ name }) => name);
    const primaryKeys = (sqlite.prepare(`PRAGMA table_info(${quoteColumn(table)})`).all() as Array<{ name: string; pk: number }>)
      .filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name);
    const order = primaryKeys.length ? ` ORDER BY ${primaryKeys.map(quoteColumn).join(", ")}` : "";
    const statement = sqlite.prepare(`SELECT ${columns.map(quoteColumn).join(", ")} FROM ${quoteIdentifier(table)}${order}`);
    statement.setReadBigInts(true);
    rowsByTable.set(table, { columns, rows: statement.all() as SqliteRow[] });
  }
  return { sqlite, rowsByTable };
}

async function main(): Promise<void> {
  const target = targetFromArgs();
  if (target === "production" && !process.argv.includes("--confirm-production")) {
    throw new Error("Production import requires --confirm-production after verification rehearsal.");
  }
  const path = sourcePath();
  const snapshotDigest = snapshotSha256(path);
  const { sqlite, rowsByTable } = readSource(path);
  const digest = rowDigest(rowsByTable);
  const counts = Object.fromEntries(APP_TABLES.map((table) => [table, rowsByTable.get(table)?.rows.length ?? 0]));
  const client = new Client({ connectionString: targetUrl(target, true), ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE mca_data_migrations IN EXCLUSIVE MODE");
    const prior = await client.query<{ snapshot_sha256: string; row_digest: string }>("SELECT snapshot_sha256, row_digest FROM mca_data_migrations ORDER BY imported_at DESC LIMIT 1");
    if (prior.rows[0]) {
      if (prior.rows[0].snapshot_sha256 === snapshotDigest && prior.rows[0].row_digest === digest) {
        await client.query("ROLLBACK");
        process.stdout.write(`Snapshot already imported on ${target}; verified matching ledger digest.\n`);
        return;
      }
      throw new Error("Destination has a different completed data migration; refusing to merge snapshots.");
    }
    let destinationRows = 0;
    for (const table of APP_TABLES) {
      const result = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`);
      destinationRows += Number(result.rows[0]?.count ?? 0);
    }
    if (destinationRows !== 0) throw new Error(`Destination-empty guard failed: ${destinationRows} application rows already exist.`);

    const targetColumnsResult = await client.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY ordinal_position",
    );
    const targetColumns = new Map<string, Set<string>>();
    for (const row of targetColumnsResult.rows) {
      const set = targetColumns.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name); targetColumns.set(row.table_name, set);
    }

    const managerAssignments: Array<{ id: string; managerId: string }> = [];
    for (const table of APP_TABLES) {
      const source = rowsByTable.get(table);
      if (!source?.rows.length) continue;
      const allowed = targetColumns.get(table);
      if (!allowed) throw new Error(`Destination schema is missing table ${table}.`);
      const unexpected = source.columns.filter((column) => !allowed.has(column));
      if (unexpected.length) throw new Error(`Destination ${table} is missing source columns: ${unexpected.join(", ")}`);
      const columnsSql = source.columns.map(quoteColumn).join(", ");
      const placeholders = source.columns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of source.rows) {
        const values = source.columns.map((column) => {
          const value = row[column];
          if (table === "memberships" && column === "manager_membership_id" && value != null) {
            managerAssignments.push({ id: String(row.id), managerId: String(value) });
            return null;
          }
          return typeof value === "bigint" ? Number(value) : value;
        });
        await client.query(`INSERT INTO ${quoteIdentifier(table)} (${columnsSql}) VALUES (${placeholders})`, values);
      }
    }
    for (const assignment of managerAssignments) {
      await client.query("UPDATE memberships SET manager_membership_id = $1 WHERE id = $2", [assignment.managerId, assignment.id]);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query(
      "INSERT INTO mca_data_migrations (id, snapshot_sha256, row_digest, table_counts_json, imported_at) VALUES ($1, $2, $3, $4, $5)",
      [`sqlite-${snapshotDigest.slice(0, 24)}`, snapshotDigest, digest, JSON.stringify(counts), new Date().toISOString()],
    );
    await client.query("COMMIT");
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    process.stdout.write(`Imported ${total} rows across ${APP_TABLES.length} mapped tables to ${target}.\n`);
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  } finally {
    sqlite.close();
    await client.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
