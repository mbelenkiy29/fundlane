import { recordOperationalError } from "./operations/telemetry";
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { AppError } from "./errors";
import { assertExecutionActive, executionFence } from "./jobs/execution";
import { postgresConnection } from "./db-connection";
import { assertHostedSupabaseConfig } from "./hosted-config";
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

interface TransactionOptions { onRollback?: () => Promise<void> }
const transactionContext = new AsyncLocalStorage<{ executor: DbExecutor; rollbackCallbacks: Array<() => Promise<void>> }>();
const globalDatabase = globalThis as typeof globalThis & { __mcaDatabasePool?: Pool; __mcaDatabaseUrl?: string };

function databaseUrl(): string {
  assertHostedSupabaseConfig();
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required. Fundlane no longer supports a SQLite runtime fallback.");
  // Keep certificate and hostname verification explicit across pg versions.
  const url = new URL(value);
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

function poolSize(): number {
  const parsed = Number.parseInt(process.env.MCA_DB_POOL_MAX ?? (process.env.VERCEL ? "2" : "10"), 10);
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
      ...postgresConnection(url),
      max: poolSize(),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // pg removes disconnected idle clients automatically, but emits an error that
    // otherwise terminates the server. Active query errors still reject normally.
    globalDatabase.__mcaDatabasePool.on("error", () => {
      void recordOperationalError("database", "idle_connection_lost");
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
    const invoke = async () => {
      assertExecutionActive();
      const fence = executionFence();
      if (serialize && fence) {
        // Hold the control/lease locks through the statement's transaction so a
        // generation revocation cannot race a checked write. Use the raw client
        // here to avoid recursively fencing the fence check itself.
        const active = await queryable.query(`SELECT e.token
          FROM mca_private.worker_executions e
          JOIN mca_private.worker_controls c ON c.subsystem=e.subsystem
          WHERE e.token=$1 AND e.subsystem=$2 AND e.generation=$3
            AND c.generation=e.generation AND c.enabled AND e.expires_at>clock_timestamp()
          FOR SHARE OF c, e`, [fence.token, fence.subsystem, fence.generation]);
        if (!active.rows.length) throw new AppError(503, "worker_execution_fenced", "The worker execution generation is no longer active.");
      }
      return queryable.query<Row>(postgresPlaceholders(sql), values);
    };
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
    executionFence()
      ? withTransaction(database => database.query<Row>(sql, values))
      : getPool().query<Row>(sql, values as unknown[] | undefined),
});

export function getDatabase(): DbExecutor { return transactionContext.getStore()?.executor ?? poolExecutor; }
export function statement<Row extends QueryResultRow = QueryResultRow>(sql: string): AsyncStatement<Row> { return getDatabase().prepare<Row>(sql); }
export async function query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row[]> { return (await getDatabase().query<Row>(sql, values)).rows; }
export function queryOne<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<Row | undefined> { return getDatabase().queryOne<Row>(sql, values); }
export function execute(sql: string, values: readonly unknown[] = []): Promise<number> { return getDatabase().execute(sql, values); }

/** Nested rollback callbacks belong to the outer transaction, even if the nested
 * operation succeeds. They run detached, after rollback and connection release. */
export async function withTransaction<T>(operation: (database: DbExecutor) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) {
    if (options.onRollback) existing.rollbackCallbacks.push(options.onRollback);
    return operation(existing.executor);
  }
  const rollbackCallbacks = options.onRollback ? [options.onRollback] : [];
  let rolledBack = false;
  let discardClient = false;
  // Also report failures to acquire a connection: no transaction was started.
  let connected = false;
  try {
    const client: PoolClient = await getPool().connect();
    connected = true;
    // A checked-out pg client cannot execute concurrent wire queries safely. Repository
    // callbacks may use Promise.all, so serialize only this transaction's command stream.
    const executor = createExecutor(client, true);
    try {
      await client.query("BEGIN");
      const result = await transactionContext.run({ executor, rollbackCallbacks }, () => operation(executor));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); rolledBack = true; }
      catch { discardClient = true; }
      throw error;
    } finally { client.release(discardClient); }
  } catch (error) {
    // Do not borrow another pool connection while the failed transaction still
    // holds a client or FK locks. run() has restored the outside async context.
    if (rolledBack || !connected) {
      for (const callback of rollbackCallbacks) {
        try { await transactionContext.exit(callback); }
        catch { await recordOperationalError("database", "transaction_rollback_callback_failed").catch(() => undefined); }
      }
    } else {
      await recordOperationalError("database", "transaction_rollback_failed").catch(() => undefined);
    }
    throw error;
  }
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
