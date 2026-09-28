import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("roadmap page blocks reads when off and renders only supplied published rows as escaped text", () => {
  const script = `
    const { mock } = require("node:test");
    const { renderToStaticMarkup } = require("react-dom/server");
    mock.module("server-only", { exports: {} });
    mock.module("next/navigation", { exports: { notFound: () => { throw new Error("NOT_FOUND") } } });
    let reads = 0;
    mock.module("./src/lib/marketing/roadmap.ts", { namedExports: {
      roadmapGroups: [{ status: "planned", title: "Planned" }, { status: "in_progress", title: "In progress" }, { status: "shipped", title: "Shipped" }],
      getPublishedRoadmap: async () => { reads++; return global.rows; }
    } });
    mock.module("./src/components/marketing/shell.tsx", { namedExports: { MarketingShell: ({ children }) => children } });
    const Page = require("./src/app/roadmap/page.tsx").default;
    (async () => {
      delete process.env.MCA_PUBLIC_ROADMAP_ENABLED;
      let disabled;
      try { await Page() } catch (error) { disabled = error.message; }
      process.env.MCA_PUBLIC_ROADMAP_ENABLED = "true";
      global.rows = [];
      const empty = renderToStaticMarkup(await Page());
      global.rows = [
        { title: "<script>bad</script>", summary: "A & B", status: "shipped", sort_order: 0 },
        { title: "Next", summary: "Soon", status: "planned", sort_order: 0 }
      ];
      const filled = renderToStaticMarkup(await Page());
      console.log(JSON.stringify({ disabled, empty, filled, reads }));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { disabled, empty, filled, reads } = JSON.parse(result.stdout);
  assert.equal(disabled, "NOT_FOUND");
  assert.equal(reads, 2);
  assert.match(empty, /Nothing on the roadmap yet\./);
  assert.ok(filled.indexOf("Planned") < filled.indexOf("Shipped"));
  assert.match(filled, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(filled, /A &amp; B/);
  assert.doesNotMatch(filled, /<script>/);
  assert.doesNotMatch(filled, /In progress/);
});
