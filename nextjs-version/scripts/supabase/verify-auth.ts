import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { hashSupabaseInvitationToken } from "../../src/lib/mca/invitation-token";
import { closeDatabaseForTests, getDatabase, nowIso } from "../../src/lib/mca/db";
import { createWorkspaceWithAdmin } from "../../src/lib/mca/workspaces";

type CookieJar = Map<string, string>;
type ResponseBody = {
  user?: { id: string };
  membership?: { role: string };
  workspaces?: { id: string }[];
  workspaceId?: string;
  error?: { code?: string };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opt-in hosted verification.`);
  return value;
}

function destination() {
  const project = process.argv.find((argument) => argument.startsWith("--expected-project-ref="))?.slice("--expected-project-ref=".length);
  if (!project || !/^[a-z]{20}$/.test(project)) throw new Error("Specify the exact --expected-project-ref=STAGING_REF.");
  if (!process.argv.includes("--allow-synthetic-writes") || !["staging", "disposable"].includes(process.env.MCA_AUTH_VERIFICATION_ENV ?? "")) {
    throw new Error("Set MCA_AUTH_VERIFICATION_ENV=staging (or disposable) and --allow-synthetic-writes. Never run this against production.");
  }
  if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production" || project === process.env.MCA_PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error("Hosted Auth verification refuses a production environment.");
  }
  const url = new URL(required("NEXT_PUBLIC_SUPABASE_URL"));
  if (url.protocol !== "https:" || url.hostname !== `${project}.supabase.co` || url.username || url.password) {
    throw new Error("The explicit staging project reference must match the Supabase Auth URL.");
  }
  const db = new URL(required("DATABASE_URL"));
  if (!["postgres:", "postgresql:"].includes(db.protocol) || (db.hostname !== `db.${project}.supabase.co` &&
    !(db.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(db.username).endsWith(`.${project}`)))) {
    throw new Error("The runtime database and Supabase Auth must belong to the same explicit staging project.");
  }
  required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const key = required("SUPABASE_SECRET_KEY");
  return { project, url: url.origin, key };
}

async function unusedPort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done, fail) => socket.close((error) => error ? fail(error) : done()));
  return port;
}

async function stopServer(server?: ChildProcess) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const stopped = once(server, "exit");
  server.kill("SIGTERM");
  const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
  try { await stopped; } finally { clearTimeout(force); }
}

async function main() {
  // Complete all destination checks before creating clients, database pools or records.
  const target = destination();
  const directory = resolve(process.env.MCA_AUTH_VERIFICATION_DIRECTORY ?? ".migration/auth-verification");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(directory)).mode & 0o077) throw new Error("The verification output directory must be private (0700).");
  const lockPath = resolve(directory, "running.lock");
  const lock = await open(lockPath, "wx", 0o600);
  await lock.close();
  const runId = randomUUID();
  const reportPath = resolve(directory, `${runId}.json`);
  const identities: string[] = [], workspaceIds: string[] = [], localUserIds: string[] = [];
  const sessionIds = new Set<string>(), checks: string[] = [], cleanupErrors: string[] = [];
  let server: ChildProcess | undefined;
  let completed = false;
  const db = getDatabase();
  const admin = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }) },
  });
  const password = randomBytes(24).toString("base64url"), changedPassword = randomBytes(24).toString("base64url");
  const port = await unusedPort(), base = `http://localhost:${port}`;
  async function report() {
    // This doubles as a recovery inventory if the process is interrupted. No credentials,
    // passwords, tokens or provider responses are written to disk or the console.
    await writeFile(reportPath, JSON.stringify({
      project: target.project, runId, recordedAt: new Date().toISOString(), completed,
      checks, identities, workspaceIds, localUserIds, sessionIds: [...sessionIds], cleanupErrors,
      emailDeliveryApisInvoked: false,
    }, null, 2), { mode: 0o600 });
  }
  async function passed(name: string) { checks.push(name); console.log(`PASS ${name}`); await report(); }
  async function request(path: string, jar: CookieJar = new Map(), body?: unknown) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", redirect: "manual", signal: AbortSignal.timeout(60_000),
      headers: { origin: base, cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0], index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const encoded = [...jar].filter(([key]) => /-auth-token(?:\.\d+)?$/.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value).join("");
    if (encoded.startsWith("base64-")) {
      try {
        const session = JSON.parse(Buffer.from(encoded.slice(7), "base64url").toString()) as { access_token: string };
        const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()) as { session_id?: string };
        if (claims.session_id) sessionIds.add(claims.session_id);
      } catch { /* Cookie deletion or an incomplete chunk does not contain a live session. */ }
    }
    let payload: ResponseBody = {};
    try { payload = JSON.parse(await response.text()) as ResponseBody; } catch { /* Redirect bodies may be empty. */ }
    if (response.status >= 500) throw new Error(`Hosted verification HTTP failure: ${path.split("?")[0]} (${response.status}, ${payload.error?.code ?? "unknown"}).`);
    return { response, payload };
  }
  async function makeUser(label: string) {
    // example.test is a reserved domain. The script calls Admin createUser/generateLink,
    // never the signup, invitation-send or password-recovery email delivery APIs.
    const email = `fundlane-auth-${label}-${runId}@example.test`;
    const local = await createWorkspaceWithAdmin({ workspaceName: `Synthetic ${label} ${runId}`, adminName: "Synthetic verifier", adminEmail: email, password, role: "admin" });
    workspaceIds.push(local.workspaceId); localUserIds.push(local.userId); await report();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { mca_user_id: local.userId, mca_auth_verification_run: runId } });
    if (error || !data.user) throw new Error("Synthetic Supabase identity creation failed.");
    identities.push(data.user.id); await report();
    await db.prepare("UPDATE users SET supabase_user_id=? WHERE id=?").run(data.user.id, local.userId);
    return { ...local, email, remoteId: data.user.id };
  }
  try {
    await report();
    // Verify the deployed restricted role can perform live-session checks before any writes.
    const runtime = await db.prepare<{ role: string }>("SELECT current_user AS role").get();
    assert.equal(runtime?.role, process.env.MCA_AUTH_VERIFICATION_RUNTIME_ROLE ?? "mca_app", "Use the restricted application runtime role, not migration-owner credentials.");
    await db.prepare("SELECT id FROM mca_private.auth_sessions LIMIT 0").all();
    const owner = await makeUser("owner"), other = await makeUser("other");
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "localhost", "--port", String(port)], {
      env: { ...process.env, NODE_ENV: "development", MCA_APP_ORIGIN: base, NEXT_DIST_DIR: ".next-stage-auth", MCA_MAINTENANCE_MODE: "disabled", MCA_STRIPE_BILLING_ENABLED: "false" },
      // Next request logs may contain one-time callback tokens. Do not publish or persist them.
      stdio: ["ignore", "ignore", "ignore"],
    });
    let startError = false;
    server.on("error", () => { startError = true; });
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (startError || server.exitCode !== null) throw new Error("The isolated local verification server did not start.");
      try { await fetch(base + "/api/auth/session", { signal: AbortSignal.timeout(3000) }); ready = true; break; }
      catch { await new Promise((done) => setTimeout(done, 500)); }
    }
    assert.ok(ready, "The local verification server must be ready.");
    const a: CookieJar = new Map(), b: CookieJar = new Map(), invitee: CookieJar = new Map();
    assert.equal((await request("/api/auth/sign-in", a, { email: owner.email, password: "wrong-secret" })).response.status, 401);
    assert.equal((await request("/api/auth/sign-in", a, { email: owner.email, password })).response.status, 200);
    assert.equal((await request("/api/onboarding", a)).payload.workspaces?.[0].id, owner.workspaceId);
    assert.equal((await request("/api/onboarding", a, { workspaceId: owner.workspaceId })).response.status, 200);
    const session = await request("/api/auth/session", a);
    assert.equal(session.payload.user?.id, owner.userId); assert.equal(session.payload.membership?.role, "admin");
    await passed("Real password sign-in, SSR cookies, identity mapping and company selection");

    const foreign = new Map(a); foreign.set("mca_workspace", other.workspaceId);
    assert.equal((await request("/api/auth/session", foreign)).response.status, 401);
    assert.equal((await request("/api/onboarding", a, { workspaceId: other.workspaceId })).response.status, 403);
    await passed("Forged workspace cookie and cross-company selection denied");

    await db.prepare("UPDATE memberships SET role='rep' WHERE id=?").run(owner.membershipId);
    assert.equal((await request("/api/auth/session", a)).payload.membership?.role, "rep");
    await db.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(owner.membershipId);
    await passed("Current local roles apply without refreshing JWT");

    assert.equal((await request("/api/auth/sign-in", b, { email: owner.email, password })).response.status, 200);
    assert.equal((await request("/api/onboarding", b, { workspaceId: owner.workspaceId })).response.status, 200);
    assert.equal((await request("/api/auth/recovery/reset", a, { password: changedPassword })).response.status, 200);
    assert.equal((await request("/api/auth/session", a)).response.status, 200);
    assert.equal((await request("/api/auth/session", b)).response.status, 401);
    await passed("Password update, token refresh and immediate other-session revocation");

    const token = randomBytes(32).toString("base64url"), membershipId = randomUUID(), now = nowIso();
    await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'rep','pending',?,?)").run(membershipId, owner.workspaceId, other.userId, now, now);
    await db.prepare("INSERT INTO invitations(id,workspace_id,membership_id,email,token_hash,expires_at,status,delivery_status,delivery_correlation_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending','pending',?,?,?,?)").run(randomUUID(), owner.workspaceId, membershipId, other.email, hashSupabaseInvitationToken(token), new Date(Date.now() + 600_000).toISOString(), randomUUID(), owner.userId, now, now);
    assert.equal((await request("/api/auth/sign-in", invitee, { email: other.email, password })).response.status, 200);
    assert.equal((await request("/api/invitations/accept", invitee, { token })).response.status, 200);
    assert.equal((await request("/api/auth/session", invitee)).payload.membership?.role, "rep");
    assert.equal((await request("/api/invitations/accept", invitee, { token })).response.status, 400);
    await passed("Verified identity accepts reserved invitation once with assigned local role");

    await db.prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(membershipId);
    assert.equal((await request("/api/auth/session", invitee)).response.status, 401);
    assert.equal((await request("/api/onboarding", invitee, { workspaceId: other.workspaceId })).response.status, 200);
    await passed("Company deactivation is immediate and preserves another company membership");

    const replay = new Map(a);
    assert.equal((await request("/api/auth/sign-out", a, {})).response.status, 200);
    assert.equal((await request("/api/auth/session", replay)).response.status, 401);
    await passed("Logout rejects replay of the previously valid access token");

    const recoveryUser = await makeUser("recovery");
    const gate = await admin.auth.admin.updateUserById(recoveryUser.remoteId, { app_metadata: { mca_user_id: recoveryUser.userId, mca_migration_pending: true } });
    assert.equal(gate.error, null);
    const recovery = await admin.auth.admin.generateLink({ type: "recovery", email: recoveryUser.email });
    assert.equal(recovery.error, null); assert.ok(recovery.data.properties);
    const recovered: CookieJar = new Map();
    const recoveryPath = `/auth/callback?token_hash=${encodeURIComponent(recovery.data.properties.hashed_token)}&type=recovery&next=/reset-password`;
    const recoveryCallback = await request(recoveryPath, recovered);
    assert.equal(recoveryCallback.response.status, 307);
    assert.equal(recoveryCallback.response.headers.get("location"), base + "/reset-password");
    assert.equal((await request("/api/auth/session", recovered)).response.status, 401);
    assert.equal((await request("/api/auth/recovery/reset", recovered, { password: changedPassword })).response.status, 200);
    assert.equal((await request("/api/onboarding", recovered, { workspaceId: recoveryUser.workspaceId })).response.status, 200);
    assert.equal((await request("/api/auth/session", recovered)).response.status, 200);
    const updated = await admin.auth.admin.getUserById(recoveryUser.remoteId);
    assert.equal(updated.data.user?.app_metadata.mca_migration_pending, false);
    const recoveryReplay = await request(recoveryPath);
    assert.equal(recoveryReplay.response.status, 307);
    assert.equal(recoveryReplay.response.headers.get("location"), base + "/sign-in?error=verification_failed");
    await passed("Real one-time recovery callback, password reset and migration gate removal");

    const signup = await admin.auth.admin.generateLink({ type: "signup", email: `fundlane-auth-signup-${runId}@example.test`, password, options: { data: { name: "Synthetic new owner", companyName: `Synthetic signup ${runId}` } } });
    assert.equal(signup.error, null); assert.ok(signup.data.user); assert.ok(signup.data.properties);
    identities.push(signup.data.user.id); await report();
    const confirmed: CookieJar = new Map();
    const callback = await request(`/auth/callback?token_hash=${encodeURIComponent(signup.data.properties.hashed_token)}&type=signup&next=/onboarding`, confirmed);
    assert.equal(callback.response.status, 307); assert.equal(callback.response.headers.get("location"), base + "/onboarding");
    const created = await request("/api/onboarding", confirmed, { name: `Synthetic signup ${runId}` });
    assert.equal(created.response.status, 200); assert.ok(created.payload.workspaceId);
    workspaceIds.push(created.payload.workspaceId); await report();
    const createdSession = await request("/api/auth/session", confirmed);
    assert.equal(createdSession.response.status, 200); assert.ok(createdSession.payload.user?.id);
    localUserIds.push(createdSession.payload.user.id); await report();
    assert.equal(createdSession.payload.membership?.role, "admin");
    await passed("Real signup confirmation creates a company and administrator membership");
    completed = true;
  } finally {
    await stopServer(server);
    // Every deletion is restricted to IDs created by this run. Discover a signup's
    // local ID in case its response was interrupted after the transaction committed.
    for (const id of identities) {
      try {
        const linked = await db.prepare<{ id: string }>("SELECT id FROM users WHERE supabase_user_id=?").get(id);
        if (linked && !localUserIds.includes(linked.id)) localUserIds.push(linked.id);
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) cleanupErrors.push(`Auth identity ${id}`);
      } catch { cleanupErrors.push(`Auth identity ${id}`); }
    }
    for (const id of sessionIds) {
      try { await db.prepare("DELETE FROM auth_session_revocations WHERE id=?").run(id); }
      catch { cleanupErrors.push(`Session revocation ${id}`); }
    }
    // Recover a committed signup company whose HTTP response was interrupted. The
    // membership belongs to this run's new identity and its name contains this run ID.
    for (const id of localUserIds) {
      try {
        const created = await db.prepare<{ id: string }>(`SELECT w.id FROM workspaces w JOIN memberships m ON m.workspace_id=w.id
          WHERE m.user_id=? AND w.name LIKE ?`).all(id, `Synthetic %${runId}`);
        for (const workspace of created) if (!workspaceIds.includes(workspace.id)) workspaceIds.push(workspace.id);
      } catch { cleanupErrors.push(`Company discovery for ${id}`); }
    }
    for (const id of workspaceIds) {
      try {
        for (const table of ["invitations", "audit_events", "sms_companies", "memberships"]) await db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(id);
        await db.prepare("DELETE FROM workspaces WHERE id=?").run(id);
      } catch { cleanupErrors.push(`Workspace ${id}`); }
    }
    for (const id of localUserIds) {
      try { await db.prepare("DELETE FROM users WHERE id=?").run(id); }
      catch { cleanupErrors.push(`Local user ${id}`); }
    }
    await closeDatabaseForTests();
    await report();
    await unlink(lockPath);
    if (cleanupErrors.length) throw new Error(`Synthetic cleanup needs attention; inspect the private report ${reportPath}.`);
    console.log(`Synthetic records cleaned; verification report: ${reportPath}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Hosted Auth verification failed.");
  process.exitCode = 1;
});
