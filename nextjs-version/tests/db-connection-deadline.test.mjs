import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import vm from "node:vm"
import { acquireDeadlineClient, DatabaseConnectionDeadlineError } from "../src/lib/mca/db/deadline-client.ts"

test("pool wait expires before a late client can start work and releases that client once", async () => {
  let supply
  let releases = 0
  let work = 0
  const client = { release() { releases++ } }
  const pending = acquireDeadlineClient(() => new Promise(resolve => { supply = resolve }), 15)
  await assert.rejects(pending.then(() => { work++ }), DatabaseConnectionDeadlineError)
  assert.equal(work, 0)
  supply(client)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(releases, 1)
})

test("abort also abandons a pool wait without leaking a later connection", async () => {
  const controller = new AbortController()
  let supply
  let releases = 0
  const pending = acquireDeadlineClient(() => new Promise(resolve => { supply = resolve }), 1_000, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, DatabaseConnectionDeadlineError)
  supply({ release() { releases++ } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(releases, 1)
})

test("an already cancelled scope never requests a connection", async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(acquireDeadlineClient(async () => { calls++; return { release() {} } }, 1_000, controller.signal), DatabaseConnectionDeadlineError)
  await assert.rejects(acquireDeadlineClient(async () => { calls++; return { release() {} } }, 0), DatabaseConnectionDeadlineError)
  assert.equal(calls, 0)
})

test("successful acquisition and provider errors retain their original identities", async () => {
  let releases = 0
  const client = { release() { releases++ } }
  assert.equal(await acquireDeadlineClient(async () => client, 1_000), client)
  assert.equal(await acquireDeadlineClient(async () => client), client)
  assert.equal(releases, 0)
  const error = new Error("pool unavailable")
  await assert.rejects(acquireDeadlineClient(async () => { throw error }, 1_000), actual => actual === error)
})

test("a rejected acquisition after elapsed wall-clock deadline maps to expiry before its timer fires", async t => {
  let now = 1_000
  t.mock.method(Date, "now", () => now)
  const failure = new Error("synthetic pool failure")
  for (const synchronous of [false, true]) {
    now = 1_000
    await assert.rejects(acquireDeadlineClient(() => {
      now += 100
      if (synchronous) throw failure
      return Promise.reject(failure)
    }, 50), DatabaseConnectionDeadlineError)
  }
})

// Load the real wrapper, execution scope, and acquisition helper. Only the pg,
// hosted-configuration, telemetry and API-error boundaries are synthetic; no
// database, provider or app dependency is used. Native Node stripping preserves
// the implementation being reviewed without requiring tsx or a VM-module flag.
function wrapperFixture() {
  let connect = async () => client
  let now = Date.now()
  const sql = [], events = []
  let releases = 0
  class FixtureDate extends Date { static now() { return now } }
  class AppError extends Error {
    constructor(status, code, message) { super(message); Object.assign(this, { status, code }) }
  }
  const client = {
    async query(config) {
      sql.push(config.text)
      return { rows: config.text.includes("pg_try_advisory_xact_lock") ? [{ locked: true }] : [{ value: 1 }], rowCount: 1 }
    },
    release(discard = false) { releases++; events.push(["release", discard]) },
  }
  class Pool {
    connect() { events.push("connect"); return connect() }
    query(config) { return client.query(config) }
    on() {}
    async end() {}
  }
  const context = vm.createContext({
    AsyncLocalStorage, randomUUID, Pool, AppError, URL, Error, Date: FixtureDate,
    setTimeout, clearTimeout, AbortController, console,
    process: { env: { DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:55432/disposable" } },
    assertHostedSupabaseConfig() {}, postgresConnection: url => ({ connectionString: url }),
    recordOperationalError: async (...input) => { events.push(["telemetry", ...input]) },
  })
  for (const file of ["db/deadline-client.ts", "jobs/execution.ts", "db.ts"]) {
    const source = stripTypeScriptTypes(readFileSync(new URL(`../src/lib/mca/${file}`, import.meta.url), "utf8"), { mode: "strip" })
      .replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "")
    vm.runInContext(source, context, { filename: file })
  }
  const api = vm.runInContext("({withTransaction,withTransactionAdvisoryLock,getDatabase,withExecutionDeadline})", context)
  return { api, client, sql, events, connect(next) { connect = next }, advance(ms) { now += ms }, releases: () => releases }
}

test("actual transaction, scoped pool query, and advisory wrapper expire waits before SQL and release late clients", async () => {
  for (const operation of ["transaction", "pool-query", "advisory-lock"]) {
    const f = wrapperFixture()
    let supply, callbacks = 0, cleanup = 0
    f.connect(() => new Promise(resolve => { supply = resolve }))
    const run = () => operation === "transaction"
      ? f.api.withTransaction(async () => { callbacks++ }, { onRollback: async () => { cleanup++ } })
      : operation === "pool-query" ? f.api.getDatabase().query("SELECT fixture")
      : f.api.withTransactionAdvisoryLock("fixture", async () => { callbacks++ })
    const pending = f.api.withExecutionDeadline(run, undefined, 15)
    await assert.rejects(pending, error => error.code === "execution_expired" && error.status === 503)
    assert.deepEqual(f.sql, [], operation)
    assert.equal(callbacks, 0, operation)
    supply(f.client)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.releases(), 1, operation)
    if (operation === "transaction") assert.equal(cleanup, 1)
  }
})

test("actual transaction abort during pool wait performs no SQL and releases its late client", async () => {
  const f = wrapperFixture(), parent = new AbortController()
  let supply
  f.connect(() => new Promise(resolve => { supply = resolve }))
  const pending = f.api.withExecutionDeadline(() => f.api.withTransaction(async () => assert.fail("aborted operation")), parent.signal, 1_000)
  const rejected = assert.rejects(pending, error => error.code === "execution_expired")
  parent.abort()
  await rejected
  supply(f.client)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.sql, [])
  assert.equal(f.releases(), 1)
})

test("cancellation between acquired-helper resolution and BEGIN sends neither BEGIN nor ROLLBACK", async () => {
  for (const operation of ["transaction", "advisory-lock"]) {
    const f = wrapperFixture(), parent = new AbortController()
    let callbacks = 0, cleanup = 0
    f.connect(() => {
      queueMicrotask(() => queueMicrotask(() => parent.abort()))
      return Promise.resolve(f.client)
    })
    const run = () => operation === "transaction"
      ? f.api.withTransaction(async () => { callbacks++ }, { onRollback: async () => { cleanup++ } })
      : f.api.withTransactionAdvisoryLock("fixture", async () => { callbacks++ })
    await assert.rejects(f.api.withExecutionDeadline(run, parent.signal, 1_000), error => error.code === "execution_expired")
    assert.deepEqual(f.sql, [], operation)
    assert.equal(callbacks, 0, operation)
    assert.equal(f.releases(), 1, operation)
    if (operation === "transaction") assert.equal(cleanup, 1)
  }
})

test("actual wrapper maps post-deadline pool rejection to execution_expired", async () => {
  const f = wrapperFixture(), failure = new Error("synthetic pool failure")
  f.connect(() => { f.advance(1_000); return Promise.reject(failure) })
  await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransaction(async () => {}), undefined, 100), error => error.code === "execution_expired")
  assert.deepEqual(f.sql, [])
})

test("ordinary unscoped transaction behavior and pre-deadline pool error identity remain unchanged", async () => {
  const f = wrapperFixture()
  assert.equal(await f.api.withTransaction(async db => (await db.query("SELECT fixture")).rows[0].value), 1)
  assert.deepEqual(f.sql, ["BEGIN", "SELECT fixture", "COMMIT"])
  assert.equal(f.releases(), 1)
  const failure = new Error("synthetic pre-deadline pool failure")
  f.connect(() => Promise.reject(failure))
  await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransaction(async () => {}), undefined, 1_000), error => error === failure)
})

test("scoped BEGIN, initial statement timeout setup and COMMIT have wire deadlines and normalize pg timeouts", async () => {
  for (const blocked of ["BEGIN", "SELECT set_config('statement_timeout', $1, true)", "COMMIT"]) {
    const f = wrapperFixture(), original = f.client.query
    let timeout, cleanup = 0
    f.client.query = async config => {
      if (config.text !== blocked) return original(config)
      timeout = config.query_timeout
      return new Promise((resolve, reject) => setTimeout(() => reject(new Error("Query read timeout")), timeout ?? 200))
    }
    await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransaction(async () => true, { onRollback: async () => { cleanup++ } }), undefined, 25), error => error.code === "execution_expired" && error.status === 503)
    assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= 25, `${blocked} must inherit the execution budget`)
    assert.equal(f.releases(), 1)
    assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0] === "release"), [["release", blocked === "COMMIT"]])
    assert.equal(cleanup, blocked === "COMMIT" ? 0 : 1)
    if (blocked === "COMMIT") assert.equal(f.sql.includes("ROLLBACK"), false)
  }
})

test("scoped advisory BEGIN and COMMIT also have wire deadlines", async () => {
  for (const blocked of ["BEGIN", "COMMIT"]) {
    const f = wrapperFixture(), original = f.client.query
    let timeout
    f.client.query = async config => {
      if (config.text !== blocked) return original(config)
      timeout = config.query_timeout
      return new Promise((resolve, reject) => setTimeout(() => reject(new Error("Query read timeout")), timeout ?? 200))
    }
    await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransactionAdvisoryLock("fixture", async () => true), undefined, 25), error => error.code === "execution_expired" && error.status === 503)
    assert.ok(Number.isFinite(timeout) && timeout > 0 && timeout <= 25, blocked)
    assert.equal(f.releases(), 1)
    assert.deepEqual(f.events.filter(event => Array.isArray(event) && event[0] === "release"), [["release", blocked === "COMMIT"]])
    if (blocked === "COMMIT") assert.equal(f.sql.includes("ROLLBACK"), false)
  }
})

test("uncertain scoped COMMIT discards its connection and runs neither outer nor nested rollback cleanup", async () => {
  const f = wrapperFixture(), original = f.client.query
  let outerCleanup = 0, nestedCleanup = 0
  f.client.query = async config => {
    if (config.text !== "COMMIT") return original(config)
    throw new Error("Query read timeout")
  }
  const transaction = () => f.api.withTransaction(async () => {
    await f.api.withTransaction(async () => true, { onRollback: async () => { nestedCleanup++ } })
  }, { onRollback: async () => { outerCleanup++ } })
  await assert.rejects(f.api.withExecutionDeadline(transaction, undefined, 1_000), error => error.code === "execution_expired")
  assert.equal(outerCleanup, 0)
  assert.equal(nestedCleanup, 0)
  assert.equal(f.sql.includes("ROLLBACK"), false)
  assert.equal(f.releases(), 1)
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === "release" && event[1] === true))
})

test("failed deadline-bound rollback discards the client and preserves the transaction failure", async () => {
  const f = wrapperFixture(), original = f.client.query
  const failure = new Error("synthetic transaction failure")
  let rollbackTimeout
  f.client.query = async config => {
    if (config.text !== "ROLLBACK") return original(config)
    rollbackTimeout = config.query_timeout
    throw new Error("Query read timeout")
  }
  await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransaction(async () => { throw failure }), undefined, 2_000), error => error === failure)
  assert.equal(rollbackTimeout, 1_000)
  assert.equal(f.releases(), 1)
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === "release" && event[1] === true))
})

test("rollback after cancellation gets a minimal wire timeout and cannot reuse its failed client", async () => {
  const f = wrapperFixture(), parent = new AbortController(), original = f.client.query
  let rollbackTimeout
  f.client.query = async config => {
    if (config.text !== "ROLLBACK") return original(config)
    rollbackTimeout = config.query_timeout
    throw new Error("Query read timeout")
  }
  await assert.rejects(f.api.withExecutionDeadline(() => f.api.withTransaction(async () => { parent.abort() }), parent.signal, 1_000), error => error.code === "execution_expired")
  assert.equal(rollbackTimeout, 1)
  assert.ok(f.events.some(event => Array.isArray(event) && event[0] === "release" && event[1] === true))
})

test("unscoped transaction control commands keep their existing wire options", async () => {
  const f = wrapperFixture(), original = f.client.query
  f.client.query = async config => {
    assert.equal(config.query_timeout, undefined)
    return original(config)
  }
  await f.api.withTransaction(async () => true)
  await f.api.withTransactionAdvisoryLock("fixture", async () => true)
  assert.equal(f.releases(), 2)
})
