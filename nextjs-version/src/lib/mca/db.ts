import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { AppError } from "./errors";
import type { AuditEvent, AuthContext, JobResourceReference, WorkspaceResource } from "./types";

export interface RunResult { changes: number }

export interface AsyncStatement<Row extends QueryResultRow = QueryResultRow> {
  get(...values: unknown[]): Promise<Row | undefined>;
  all(...values: unknown[]): Promise<Row[]>;
  run(...values: unknown[]): Promise<RunResult>;
}

export interface DbExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
  queryOne<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<Row | undefined>;
  execute(sql: string, values?: readonly unknown[]): Promise<number>;
  prepare<Row extends QueryResultRow = QueryResultRow>(sql: string): AsyncStatement<Row>;
}

interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const transactionContext = new AsyncLocalStorage<DbExecutor>();
const globalDatabase = globalThis as typeof globalThis & { __mcaDatabasePool?: Pool; __mcaDatabaseUrl?: string };

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required. Fundlane no longer supports a SQLite runtime fallback.");
  return value;
}

function poolSize(): number {
  const parsed = Number.parseInt(process.env.MCA_DB_POOL_MAX ?? "10", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 50) : 10;
}

function getPool(): Pool {
  const url = databaseUrl();
  if (globalDatabase.__mcaDatabasePool && globalDatabase.__mcaDatabaseUrl !== url) {
    const previous = globalDatabase.__mcaDatabasePool;
    globalDatabase.__mcaDatabasePool = undefined;
    globalDatabase.__mcaDatabaseUrl = undefined;
    void previous.end().catch(() => undefined);
  }
  if (!globalDatabase.__mcaDatabasePool) {
    globalDatabase.__mcaDatabasePool = new Pool({
      connectionString: url,
      max: poolSize(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: true },
      enableChannelBinding: true,
    });
    globalDatabase.__mcaDatabaseUrl = url;
  }
  return globalDatabase.__mcaDatabasePool;
}

/** Convert only real SQLite-style bind markers; quoted SQL and comments are preserved. */
export function postgresPlaceholders(sql: string): string {
  let output = "";
  let index = 0;
  let parameter = 0;
  let state: "code" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "code";
  let blockDepth = 0;
  let dollarTag = "";
  let escapeString = false;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (state === "code") {
      if (character === "'") {
        const previous = sql[index - 1];
        const beforePrevious = sql[index - 2];
        escapeString = (previous === "e" || previous === "E") && (!beforePrevious || !/[A-Za-z0-9_$]/.test(beforePrevious));
        state = "single"; output += character; index += 1; continue;
      }
      if (character === '"') { state = "double"; output += character; index += 1; continue; }
      if (character === "-" && next === "-") { state = "line-comment"; output += "--"; index += 2; continue; }
      if (character === "/" && next === "*") { state = "block-comment"; blockDepth = 1; output += "/*"; index += 2; continue; }
      if (character === "$") {
        const tag = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
        if (tag) { state = "dollar"; dollarTag = tag; output += tag; index += tag.length; continue; }
      }
      if (character === "?") { parameter += 1; output += `$${parameter}`; index += 1; continue; }
      output += character; index += 1; continue;
    }
    if (state === "single") {
      output += character; index += 1;
      if (escapeString && character === "\\" && index < sql.length) { output += sql[index]; index += 1; }
      else if (character === "'" && next === "'") { output += next; index += 1; }
      else if (character === "'") state = "code";
      continue;
    }
    if (state === "double") {
      output += character; index += 1;
      if (character === '"' && next === '"') { output += next; index += 1; }
      else if (character === '"') state = "code";
      continue;
    }
    if (state === "line-comment") { output += character; index += 1; if (character === "\n" || character === "\r") state = "code"; continue; }
    if (state === "block-comment") {
      if (character === "/" && next === "*") { blockDepth += 1; output += "/*"; index += 2; }
      else if (character === "*" && next === "/") { blockDepth -= 1; output += "*/"; index += 2; if (blockDepth === 0) state = "code"; }
      else { output += character; index += 1; }
      continue;
    }
    if (sql.startsWith(dollarTag, index)) { output += dollarTag; index += dollarTag.length; state = "code"; }
    else { output += character; index += 1; }
  }
  return output;
}

function createExecutor(queryable: Queryable, serialize = false): DbExecutor {
  let queryTail: Promise<void> = Promise.resolve();
  const runQuery = <Row extends QueryResultRow>(sql: string, values: readonly unknown[]) => {
    const invoke = () => queryable.query<Row>(postgresPlaceholders(sql), values);
    if (!serialize) return invoke();
    const pending = queryTail.then(invoke, invoke);
    queryTail = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const executor: DbExecutor = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      const result = await runQuery<Row>(sql, values);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async queryOne<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
      return (await executor.query<Row>(sql, values)).rows[0] as Row | undefined;
    },
    async execute(sql: string, values: readonly unknown[] = []) { return (await executor.query(sql, values)).rowCount; },
    prepare<Row extends QueryResultRow = QueryResultRow>(sql: string): AsyncStatement<Row> {
      return {
        get: (...values) => executor.queryOne<Row>(sql, values),
        all: async (...values) => (await executor.query<Row>(sql, values)).rows,
        run: async (...values) => ({ changes: await executor.execute(sql, values) }),
      };
    },
  };
  return executor;
}

const poolExecutor = createExecutor({
  query: <Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) =>
    getPool().query<Row>(sql, values as unknown[] | undefined),
});

export function getDatabase(): DbExecutor { return transactionContext.getStore() ?? poolExecutor; }
export function statement<Row extends QueryResultRow = QueryResultRow>(sql: string): AsyncStatement<Row> { return getDatabase().prepare<Row>(sql); }
export async function query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row[]> { return (await getDatabase().query<Row>(sql, values)).rows; }
export function queryOne<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row | undefined> { return getDatabase().queryOne<Row>(sql, values); }
export function execute(sql: string, values: readonly unknown[] = []): Promise<number> { return getDatabase().execute(sql, values); }

export async function withTransaction<T>(operation: (database: DbExecutor) => Promise<T>): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) return operation(existing);
  const client: PoolClient = await getPool().connect();
  // A checked-out pg client cannot execute concurrent wire queries safely. Repository
  // callbacks may use Promise.all, so serialize only this transaction's command stream.
  const executor = createExecutor(client, true);
  try {
    await client.query("BEGIN");
    const result = await transactionContext.run(executor, () => operation(executor));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the operation error */ }
    throw error;
  } finally { client.release(); }
}

export const withImmediateTransaction = withTransaction;

export async function closeDatabaseForTests(): Promise<void> {
  const pool = globalDatabase.__mcaDatabasePool;
  delete globalDatabase.__mcaDatabasePool;
  delete globalDatabase.__mcaDatabaseUrl;
  if (pool) await pool.end();
}

export function newId(): string { return randomUUID(); }
export function nowIso(): string { return new Date().toISOString(); }
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function assertResourceWorkspace<T extends WorkspaceResource>(resource: T | undefined, workspaceId: string): T {
  if (!resource || resource.workspaceId !== workspaceId) throw new AppError(404, "resource_not_found", "The requested resource was not found.");
  return resource;
}

export function validateJobResource(reference: JobResourceReference, lookup: (resourceType: string, resourceId: string) => WorkspaceResource | undefined): WorkspaceResource {
  return assertResourceWorkspace(lookup(reference.resourceType, reference.resourceId), reference.workspaceId);
}

export async function recordAuditEvent(input: {
  context: Pick<AuthContext, "workspaceId" | "userId"> & { authType?: "session" | "api_key"; source?: "user" | "api_key" | "system" };
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  executor?: DbExecutor;
}): Promise<AuditEvent> {
  const event: AuditEvent = {
    id: newId(), workspaceId: input.context.workspaceId, actorUserId: input.context.userId,
    source: input.context.source ?? (input.context.authType === "api_key" ? "api_key" : "user"),
    action: input.action, resourceType: input.resourceType, resourceId: input.resourceId,
    metadata: input.metadata ?? {}, correlationId: input.correlationId ?? newId(), createdAt: nowIso(),
  };
  await (input.executor ?? getDatabase()).prepare(`INSERT INTO audit_events
    (id, workspace_id, actor_user_id, source, action, resource_type, resource_id, metadata, correlation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.workspaceId, event.actorUserId, event.source, event.action, event.resourceType,
      event.resourceId, JSON.stringify(event.metadata), event.correlationId, event.createdAt,
    );
  return event;
}
