import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("retention hold routes default off and require operator MFA and trusted mutations", () => {
  const script = `
    const { mock } = require("node:test");
    mock.module("server-only", { exports: {} });
    const { AppError } = require("./src/lib/mca/errors.ts");
    let mode = "operator", calls = 0;
    mock.module("./src/lib/mca/platform-auth.ts", { namedExports: { requireSuperAdmin: async () => {
      if (mode === "nonoperator") throw new AppError(403, "platform_admin_required", "Forbidden.");
      if (mode === "mfa") throw new AppError(403, "mfa_required", "MFA required.");
      return { userId: "operator", email: "mike@sentineltechsolutions.io", sessionId: "session" };
    } } });
    mock.module("./src/lib/mca/retention-holds.ts", { namedExports: {
      retentionHoldsEnabled: () => process.env.MCA_RETENTION_HOLDS_ENABLED === "true",
      placeRetentionHoldSchema: require("zod").z.object({ workspaceId: require("zod").z.string(), reason: require("zod").z.enum(["dispute","chargeback","subpoena","regulator_request"]), note: require("zod").z.string().min(1) }).strict(),
      placeRetentionHold: async () => (++calls, { id: "hold" }), releaseRetentionHold: async () => (++calls, { id: "hold" })
    } });
    mock.module("./src/lib/mca/platform-audit.ts", { namedExports: {
      assertStrictPlatformMutation: request => { if (!request.headers.get("origin")) throw new AppError(403,"untrusted_origin","Origin required."); },
      withSuperAdminAction: async (_input, action) => action(),
    } });
    mock.module("./src/lib/mca/auth.ts", { namedExports: {
      assertTrustedMutation: request => { if (request.headers.get("origin") !== new URL(request.url).origin) throw new AppError(403,"untrusted_origin","Origin denied."); },
      consumeRequestRateLimit: async () => {},
    } });
    const route = require("./src/app/api/platform/retention-holds/route.ts");
    const item = require("./src/app/api/platform/retention-holds/[id]/route.ts");
    const base = "https://app.example.test/api/platform/retention-holds";
    const request = (origin="https://app.example.test") => new Request(base, { method:"POST", headers:{ origin, "content-type":"application/json" }, body:JSON.stringify({workspaceId:"workspace",reason:"dispute",note:"Synthetic dispute"}) });
    (async () => {
      const out=[]; delete process.env.MCA_RETENTION_HOLDS_ENABLED;
      out.push((await route.POST(request())).status, calls);
      process.env.MCA_RETENTION_HOLDS_ENABLED="TRUE"; out.push((await route.POST(request())).status);
      process.env.MCA_RETENTION_HOLDS_ENABLED="true";
      mode="nonoperator"; out.push((await route.POST(request())).status);
      mode="mfa"; out.push((await route.POST(request())).status);
      mode="operator"; out.push((await route.POST(request("https://evil.example.test"))).status);
      out.push((await route.POST(request())).status);
      out.push((await item.POST(request(), {params:Promise.resolve({id:"00000000-0000-4000-8000-000000000000"})})).status, calls);
      console.log(JSON.stringify(out));
    })().catch(error => { console.error(error); process.exitCode=1; });
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding:"utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [404, 0, 404, 403, 403, 403, 201, 200, 2]);
});
