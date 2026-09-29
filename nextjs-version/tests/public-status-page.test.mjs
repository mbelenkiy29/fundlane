import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("status page gates probe and renders coarse states", () => {
  const script = `
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    mock.module("server-only", { exports: {} });
    mock.module("next/navigation", { exports: { notFound: () => { throw new Error("NOT_FOUND") } } });
    let reads = 0;
    mock.module("./src/lib/marketing/public-status.ts", { namedExports: {
      getPublicStatusCheck: async () => { reads++; return global.check; }
    } });
    mock.module("./src/components/marketing/shell.tsx", { namedExports: { MarketingShell: ({ children }) => children } });
    const Page = require("./src/app/status/page.tsx").default;
    (async () => {
      const disabled = [];
      for (const value of [undefined, "false", "TRUE", "1"]) {
        if (value === undefined) delete process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED;
        else process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = value;
        try { await Page() } catch (error) { disabled.push(error.message) }
      }
      const before = reads;
      process.env.MCA_PUBLIC_STATUS_PAGE_ENABLED = "true";
      process.env.NEXT_PUBLIC_STATUS_PAGE_URL = "https://status.example.test/";
      global.check = { databaseAvailable: true, checkedAt: "2026-09-28T12:00:00.000Z" };
      const available = renderToStaticMarkup(await Page());
      global.check = { databaseAvailable: false, checkedAt: "2026-09-28T12:01:00.000Z" };
      const unavailable = renderToStaticMarkup(await Page());
      console.log(JSON.stringify({ disabled, before, available, unavailable, reads }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { disabled, before, available, unavailable, reads } = JSON.parse(result.stdout);
  assert.deepEqual(disabled, Array(4).fill("NOT_FOUND"));
  assert.equal(before, 0);
  assert.equal(reads, 2);
  assert.match(available, /Website<\/h2><p>Available/);
  assert.match(available, /Database<\/h2><p>Available/);
  assert.match(unavailable, /Database<\/h2><p>Unavailable/);
  assert.match(unavailable, /2026-09-28T12:01:00.000Z/);
  assert.match(available, /href="https:\/\/status\.example\.test\/"/);
  assert.doesNotMatch(unavailable, /error|password|deployment|worker/i);
});
