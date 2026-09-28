import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("public probe uses bounded query, coarse failure, and 60-second cache", () => {
  const script = `
    const { mock } = require("node:test");
    const queries = [];
    let options;
    let fail = false;
    mock.module("server-only", { exports: {} });
    mock.module("next/cache", { exports: { unstable_cache: (fn, key, value) => { options = value; return fn } } });
    mock.module("./src/lib/mca/db.ts", { namedExports: { withTransaction: async fn => fn({ query: async sql => { queries.push(sql); if (fail && sql === "SELECT 1") throw new Error("secret SQL connection detail") } }) } });
    const { getPublicStatusCheck } = require("./src/lib/marketing/public-status.ts");
    (async () => {
      const ok = await getPublicStatusCheck();
      fail = true;
      const down = await getPublicStatusCheck();
      console.log(JSON.stringify({ ok, down, queries, options }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { ok, down, queries, options } = JSON.parse(result.stdout);
  assert.deepEqual(queries, ["SET LOCAL statement_timeout='2000ms'", "SELECT 1", "SET LOCAL statement_timeout='2000ms'", "SELECT 1"]);
  assert.equal(options.revalidate, 60);
  assert.equal(ok.databaseAvailable, true);
  assert.equal(down.databaseAvailable, false);
  assert.ok(Number.isFinite(Date.parse(ok.checkedAt)));
  assert.deepEqual(Object.keys(down).sort(), ["checkedAt", "databaseAvailable"]);
  assert.doesNotMatch(JSON.stringify(down), /secret|SQL|connection/i);
});
