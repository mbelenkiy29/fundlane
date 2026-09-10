import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import { targetFromArgs, targetUrl } from "./connections";
import { APP_TABLES, quoteColumn, quoteIdentifier } from "./table-inventory";

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function canonical(value: unknown): string {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? JSON.stringify(number) : JSON.stringify(value.toString());
  }
  if (typeof value === "number" && Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

function digestRows(columns: string[], rows: Array<Record<string, unknown>>): string {
  const hash = createHash("sha256").update(`${columns.join(",")}\n`);
  for (const row of rows) hash.update(`${columns.map((column) => canonical(row[column])).join("|")}\n`);
  return hash.digest("hex");
}

function environmentValue(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = resolve(process.cwd(), ".env.local");
  const line = readFileSync(envPath, "utf8").split(/\r?\n/).find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1);
}

function verifyCiphertext(ciphertext: string, workspaceId: string, key: Buffer): void {
  const [version, nonce, tag, payload] = ciphertext.split(".");
  if (version !== "v1" || !nonce || !tag || !payload) throw new Error("Invalid encrypted field format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAAD(Buffer.from(workspaceId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  decipher.update(Buffer.from(payload, "base64url"));
  decipher.final();
}

async function main(): Promise<void> {
  const target = targetFromArgs();
  const path = resolve(argument("source") ?? process.env.MCA_SQLITE_SNAPSHOT ?? "data/mca-pre-neon-20260908T164321Z.sqlite");
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const sourceTables = new Set((sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(({ name }) => name));
  const client = new Client({ connectionString: targetUrl(target, true), ssl: { rejectUnauthorized: true }, enableChannelBinding: true });
  await client.connect();
  let total = 0;
  let checkedCiphertexts = 0;
  try {
    for (const table of APP_TABLES) {
      const destinationCount = Number((await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`)).rows[0]?.count ?? 0);
      if (!sourceTables.has(table)) {
        if (destinationCount !== 0) throw new Error(`${table}: source table absent but destination contains ${destinationCount} rows.`);
        continue;
      }
      const info = sqlite.prepare(`PRAGMA table_info(${quoteColumn(table)})`).all() as Array<{ name: string; pk: number }>;
      const columns = info.map(({ name }) => name);
      const keys = info.filter(({ pk }) => pk > 0).sort((a, b) => a.pk - b.pk).map(({ name }) => name);
      const order = keys.length ? ` ORDER BY ${keys.map(quoteColumn).join(", ")}` : "";
      const sourceStatement = sqlite.prepare(`SELECT ${columns.map(quoteColumn).join(", ")} FROM ${quoteIdentifier(table)}${order}`);
      sourceStatement.setReadBigInts(true);
      const sourceRows = sourceStatement.all() as Array<Record<string, unknown>>;
      if (sourceRows.length !== destinationCount) throw new Error(`${table}: count mismatch (${sourceRows.length} source, ${destinationCount} destination).`);
      const destinationRows = (await client.query<Record<string, unknown>>(
        `SELECT ${columns.map(quoteColumn).join(", ")} FROM ${quoteIdentifier(table)}${order}`,
      )).rows;
      if (digestRows(columns, sourceRows) !== digestRows(columns, destinationRows)) throw new Error(`${table}: canonical row digest mismatch.`);
      total += sourceRows.length;

      const cipherColumns = columns.filter((column) => column.endsWith("_cipher"));
      if (cipherColumns.length) {
        const configured = environmentValue("MCA_DATA_ENCRYPTION_KEY");
        for (const row of sourceRows.slice(0, 10)) {
          for (const column of cipherColumns) {
            if (!row[column]) continue;
            if (!configured) throw new Error("Encrypted data exists but MCA_DATA_ENCRYPTION_KEY is unavailable.");
            const key = Buffer.from(configured, "base64url");
            if (key.length !== 32) throw new Error("MCA_DATA_ENCRYPTION_KEY is not 32 bytes.");
            verifyCiphertext(String(row[column]), String(row.workspace_id), key);
            checkedCiphertexts += 1;
          }
        }
      }
    }
    const invalidConstraints = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM pg_constraint WHERE NOT convalidated");
    if (Number(invalidConstraints.rows[0]?.count ?? 0) !== 0) throw new Error("Destination has unvalidated constraints.");
    const ledger = await client.query("SELECT 1 FROM mca_data_migrations LIMIT 1");
    if (!ledger.rowCount) throw new Error("Destination migration ledger is missing.");
    process.stdout.write(`Parity passed for ${APP_TABLES.length} mapped tables and ${total} rows on ${target}; ${checkedCiphertexts} encrypted values authenticated.\n`);
  } finally {
    sqlite.close();
    await client.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
