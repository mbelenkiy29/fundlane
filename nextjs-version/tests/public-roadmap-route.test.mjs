import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("operator roadmap routes gate flag, authority, MFA, origin, and input before writes", () => {
  const script = `
    const { mock } = require("node:test");
    mock.module("server-only", { exports: {} });
    const { AppError } = require("./src/lib/mca/errors.ts");
    let mode = "anonymous";
    mock.module("./src/lib/mca/platform-auth.ts", { namedExports: { requireSuperAdmin: async () => {
      if (mode === "anonymous") throw new AppError(401, "authentication_required", "Sign in.");
      if (mode === "nonoperator") throw new AppError(403, "platform_admin_required", "Forbidden.");
      if (mode === "mfa") throw new AppError(403, "mfa_required", "MFA required.");
      return { userId: "operator", email: "mike@sentineltechsolutions.io", sessionId: "session" };
    } } });
    mock.module("./src/lib/mca/platform-audit.ts", { namedExports: {
      assertStrictPlatformMutation: request => { if (!request.headers.get("origin")) throw new AppError(403,"untrusted_origin","Origin required."); },
      withSuperAdminAction: async (_input, action) => action(),
    } });
    mock.module("./src/lib/mca/auth.ts", { namedExports: {
      assertTrustedMutation: request => { if (request.headers.get("origin") !== new URL(request.url).origin) throw new AppError(403,"untrusted_origin","Origin denied."); },
      consumeRequestRateLimit: async () => {},
    } });
    const route = require("./src/app/api/platform/roadmap/route.ts");
    const item = require("./src/app/api/platform/roadmap/[id]/route.ts");
    const base = "https://app.example.test/api/platform/roadmap";
    const request = (method, body, origin) => new Request(base, { method, headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    (async () => {
      const out = [];
      delete process.env.MCA_PUBLIC_ROADMAP_ENABLED;
      out.push((await route.GET()).status);
      out.push((await route.POST(request("POST", {}))).status);
      process.env.MCA_PUBLIC_ROADMAP_ENABLED = "true";
      out.push((await route.GET()).status);
      mode = "nonoperator"; out.push((await route.GET()).status);
      mode = "mfa"; out.push((await route.POST(request("POST", {}))).status);
      mode = "operator";
      out.push((await route.POST(request("POST", {}, "https://evil.example.test"))).status);
      out.push((await route.POST(request("POST", { title: "", summary: "", status: "bad", sort_order: -1 }, "https://app.example.test"))).status);
      out.push((await item.PUT(request("PUT", { updated_at: "bad" }, "https://app.example.test"), { params: Promise.resolve({ id: "valid-but-no-db" }) })).status);
      console.log(JSON.stringify(out));
    })().catch(error => { console.error(error); process.exitCode = 1 });
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "-e", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [401, 401, 401, 403, 403, 403, 400, 400]);
});
