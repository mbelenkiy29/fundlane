import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

test("estimates route is flag-gated and parses broker assumptions", () => {
  const script = `
    const { mock } = require("node:test");
    mock.module("server-only", { exports: {} });
    const calls = [];
    mock.module("./src/lib/mca/underwriting/scoring.ts", { namedExports: { requireScoreActor: async () => ({ userId: "user", workspaceId: "workspace" }) } });
    mock.module("./src/lib/mca/underwriting/estimates-loader.ts", { namedExports: {
      dealEstimatesEnabled: () => process.env.MCA_DEAL_ESTIMATES_ENABLED === "true",
      getDealEstimates: async (_actor, dealId, assumptions) => (calls.push([dealId, assumptions]), { lenders: [] }),
    } });
    const route = require("./src/app/api/mca/underwriting/estimates/[dealId]/route.ts");
    const get = (query = "") => route.GET(new Request("https://app.example.test/api/mca/underwriting/estimates/deal" + query), { params: Promise.resolve({ dealId: "deal" }) });
    (async () => {
      const out = []; delete process.env.MCA_DEAL_ESTIMATES_ENABLED;
      out.push((await get()).status, calls.length);
      process.env.MCA_DEAL_ESTIMATES_ENABLED = "true";
      out.push((await get("?factor=1.4&termMonths=8&frequency=weekly&holdbackPct=0.3")).status, calls);
      out.push((await get("?frequency=monthly")).status, (await get("?factor=abc")).status, calls.length);
      console.log(JSON.stringify(out));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), [404, 0, 200, [["deal", { factor: 1.4, termMonths: 8, holdbackPct: 0.3, frequency: "weekly" }]], 422, 422, 1])
})
