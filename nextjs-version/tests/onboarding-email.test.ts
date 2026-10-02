import "./helpers/business-auth";
import test, { after, before, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";
import { assertTransactionExecutor, closeDatabaseForTests, getDatabase, withTransaction } from "../src/lib/mca/db";
import { decryptSensitive } from "../src/lib/mca/crypto";
import { createEnrollment, findEnrollment, recordEnrollmentActivation } from "../src/lib/mca/onboarding/store";
import { enqueueOnboardingEmailIntents } from "../src/lib/mca/onboarding/email-intents";
import type { EnrollmentActivation, EnrollmentOffer } from "../src/lib/mca/onboarding/contracts";
import { renderOnboardingEmail } from "../src/lib/mca/onboarding/email-content";
import { runOnboardingEmails, recordOnboardingEmailDispatchOutcome } from "../src/lib/mca/onboarding/email-worker";
import { runScheduledCommsJobs } from "../src/lib/mca/comms/scheduler";

const instant = "2030-01-01T12:00:00.000Z", end = "2030-01-15T12:00:00.000Z";
const offer: EnrollmentOffer = { version: 1, accountId: "acct_synthetic", basePriceId: "price_base", seatPriceId: "price_seats", currency: "usd", baseAmount: 39900, quantity: 1, trialDays: 14, livemode: false, promotionCodes: true, automaticTax: false };
type MailRow = { id: string; enrollment_id: string; purpose: "business_information_requested" | "getting_started"; generation: number; delivery_key: string; state: string; attempts: number; next_attempt_at: string; recipient_hash: string; recipient_cipher: string | null; content_cipher: string | null; provider_config_cipher: string | null; provider: string | null; provider_account_id: string | null; claim_token: string | null; lease_until: string | null; provider_message_id: string | null; error_code: string | null };
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
const savedEnv = { ...process.env }, savedFetch = globalThis.fetch;
before(async () => {
  fixture = await createPostgresTestDatabase("onboarding_email");
  process.env.DATABASE_URL = fixture.databaseUrl;
});
beforeEach(async t => {
  (t as TestContext).mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
  for (const name of Object.keys(process.env)) if (/^MCA_(EMAIL_|SYSTEM_EMAIL_|USESEND_|RESEND_|ONBOARDING_)/.test(name)) delete process.env[name];
  Object.assign(process.env, { MCA_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"), MCA_APP_ORIGIN: "https://app.example.test", MCA_ONBOARDING_RUNTIME_ENABLED: "true", MCA_ONBOARDING_EMAIL_ENABLED: "true", MCA_USESEND_API_KEY: "synthetic-key", MCA_USESEND_FROM: "Fundlane <service@example.test>", MCA_SYSTEM_EMAIL_REPLY_TO: "help@example.test" });
  globalThis.fetch = async (_url, init) => Response.json({ emailId: `accepted-${new Headers(init?.headers).get("idempotency-key")}` });
  await getDatabase().execute("TRUNCATE mca_enrollments CASCADE");
});
after(async () => {
  globalThis.fetch = savedFetch;
  await closeDatabaseForTests();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (fixture) await fixture.close();
});
async function activate() {
  const row = await createEnrollment({ resumeSecret: randomUUID() + randomUUID(), offer }), id = randomUUID();
  const activation: EnrollmentActivation = { sessionId: `cs_${id}`, customerId: `cus_${id}`, subscriptionId: `sub_${id}`, email: "owner@example.test", businessName: "Synthetic company", trialStartedAt: instant, trialEndsAt: end, verifiedAt: instant, billingStatus: "trialing", livemode: false };
  await withTransaction(db => recordEnrollmentActivation(row.id, activation, db));
  return { row, activation };
}
async function emails(id?: string) {
  return (await getDatabase().query<MailRow>(`SELECT * FROM mca_onboarding_service_emails ${id ? "WHERE enrollment_id=?" : ""} ORDER BY purpose`, id ? [id] : [])).rows;
}
const scope = (row: MailRow) => `onboarding:email:${row.enrollment_id}:${row.generation}`;

test("distinct service messages use auth-required locators, secure details and authoritative trial guidance", () => {
  const business = renderOnboardingEmail({ purpose: "business_information_requested", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test" });
  const welcome = renderOnboardingEmail({ purpose: "getting_started", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test" });
  assert.equal(business.subject, "Complete your Fundlane business details");
  assert.equal(welcome.subject, "Get started with Fundlane");
  assert.match(business.text, /Do not reply with your EIN/);
  assert.match(business.text, /secure form/);
  assert.match(business.text, /confirm or correct/i);
  assert.match(business.text, /additional registration and approval/);
  assert.match(business.text, /https:\/\/app.example.test\/enrollment\?enrollment=opaque-id&destination=business&generation=2/);
  assert.match(welcome.text, /https:\/\/app.example.test\/enrollment\?enrollment=opaque-id&destination=crm&generation=2/);
  assert.match(welcome.text, /Sign in and verify/i);
  assert.match(welcome.text, /2030-01-15T12:00:00.000Z/);
  assert.match(welcome.text, /Plans & Billing/);
  const connect = welcome.text.indexOf("Connect"), own = welcome.text.indexOf("address you control"), defaultSender = welcome.text.indexOf("default sender"), submission = welcome.text.indexOf("synthetic submission");
  assert.ok(connect >= 0 && connect < own && own < defaultSender && defaultSender < submission);
  assert.match(welcome.text, /explicitly/i);
  assert.match(welcome.text, /prerequisites/i);
  assert.match(welcome.text, /received/i);
  for (const mail of [business, welcome]) assert.doesNotMatch(JSON.stringify(mail), /\d{2}-\d{7}|token=|secret=|billing\.stripe\.com|unsubscribe/i);
  assert.match(business.html, /&amp;destination=business&amp;generation=2/);
});

test("renderer rejects unsafe origins, invalid locators and generations", () => {
  const input = { purpose: "getting_started" as const, enrollmentId: "opaque", generation: 1, trialEndsAt: end, origin: "https://app.example.test" };
  for (const bad of [{ origin: "http://evil.example" }, { origin: "https://user:pass@app.example.test" }, { enrollmentId: "<script>" }, { generation: 0 }, { trialEndsAt: "invalid" }]) assert.throws(() => renderOnboardingEmail({ ...input, ...bad }));
});

test("pre-company intents freeze encrypted content and accept independently without changing CRM state", async () => {
  const { row, activation } = await activate();
  const initial = await emails(row.id);
  assert.equal(initial.length, 2);
  assert.equal((await findEnrollment(row.id))?.workspaceId, null);
  globalThis.fetch = async (_url, init) => {
    assert.throws(() => assertTransactionExecutor(getDatabase()), { code: "transaction_required" });
    const persisted = await emails(row.id);
    assert.ok(persisted.some(mail => mail.state === "sending" && mail.recipient_cipher && mail.content_cipher && mail.provider_config_cipher));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.to, activation.email);
    assert.equal(body.replyTo, "help@example.test");
    assert.doesNotMatch(JSON.stringify(body), /unsubscribe|token=|secret=|Synthetic company/);
    return body.subject === "Complete your Fundlane business details" ? Response.json({}, { status: 400 }) : Response.json({ emailId: "welcome-accepted" });
  };
  assert.deepEqual(await runOnboardingEmails({ clock: instant }), { attempted: 2, accepted: 1, uncertain: 0, suppressed: 0 });
  const final = await emails(row.id);
  assert.deepEqual(final.map(mail => mail.state), ["failed", "accepted"]);
  for (const mail of final) {
    assert.ok(mail.recipient_cipher && mail.content_cipher && mail.provider_config_cipher);
    assert.doesNotMatch(mail.recipient_cipher + mail.content_cipher + mail.provider_config_cipher, /owner@example|synthetic-key|Complete your/);
    assert.equal(decryptSensitive(mail.recipient_cipher!, scope(mail)), "owner@example.test");
    assert.throws(() => decryptSensitive(mail.content_cipher!, "foreign-scope"));
  }
  assert.equal((await findEnrollment(row.id))?.finalizationState, "pending");
});

test("activation repair reuses intent identities and successful mail never replays", async () => {
  const { row, activation } = await activate(), initial = await emails(row.id);
  await withTransaction(db => recordEnrollmentActivation(row.id, activation, db));
  await withTransaction(db => enqueueOnboardingEmailIntents(row.id, 1, db));
  assert.deepEqual((await emails(row.id)).map(mail => mail.id), initial.map(mail => mail.id));
  await runOnboardingEmails({ clock: instant });
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not replay"); };
  await runOnboardingEmails({ clock: end });
  assert.equal(calls, 0);
  assert.equal((await emails(row.id)).length, 2);
});

test("dispatch gate and expired absolute deadline preserve queued work", async () => {
  await activate();
  for (const flag of [undefined, "false", "TRUE"]) {
    if (flag) process.env.MCA_ONBOARDING_EMAIL_ENABLED = flag; else delete process.env.MCA_ONBOARDING_EMAIL_ENABLED;
    assert.equal((await runOnboardingEmails({ clock: instant })).attempted, 0);
  }
  process.env.MCA_ONBOARDING_EMAIL_ENABLED = "true";
  assert.equal((await runOnboardingEmails({ clock: instant, deadlineMs: Date.now() - 1 })).attempted, 0);
  assert.ok((await emails()).every(mail => mail.state === "queued" && mail.attempts === 0));
});

test("missing provider configuration defers durable work without attempts or busy spinning", async () => {
  await activate();
  delete process.env.MCA_USESEND_API_KEY;
  assert.equal((await runOnboardingEmails({ clock: instant, limit: 100 })).attempted, 0);
  for (const mail of await emails()) { assert.equal(mail.state, "queued"); assert.equal(mail.attempts, 0); assert.equal(mail.error_code, "onboarding_email_unconfigured"); assert.equal(mail.next_attempt_at, "2030-01-01T12:15:00.000Z"); }
});

test("concurrent workers send each stable intent once and persist acceptance rather than delivery", async () => {
  await activate();
  const keys: string[] = [];
  globalThis.fetch = async (_url, init) => { const key = new Headers(init?.headers).get("idempotency-key")!; keys.push(key); return Response.json({ emailId: `id-${key}` }); };
  await Promise.all(Array.from({ length: 4 }, () => runOnboardingEmails({ clock: instant })));
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  assert.ok((await emails()).every(mail => mail.state === "accepted" && mail.attempts === 1));
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts WHERE state='accepted'"))?.count, 2);
});

test("proven 429 nonacceptance retries at fifteen and thirty minutes and stops at three", async t => {
  await activate();
  const requests: string[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(String(init?.body)); return Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 }); };
  await runOnboardingEmails({ clock: instant });
  assert.ok((await emails()).every(mail => mail.state === "retry" && mail.attempts === 1 && mail.next_attempt_at === "2030-01-01T12:15:00.000Z"));
  assert.equal((await runOnboardingEmails({ clock: "2030-01-01T12:14:59.000Z" })).attempted, 0);
  t.mock.timers.setTime(Date.parse("2030-01-01T12:15:00.000Z"));
  await runOnboardingEmails({ clock: "2030-01-01T12:15:00.000Z" });
  assert.ok((await emails()).every(mail => mail.attempts === 2 && mail.next_attempt_at === "2030-01-01T12:45:00.000Z"));
  t.mock.timers.setTime(Date.parse("2030-01-01T12:45:00.000Z"));
  await runOnboardingEmails({ clock: "2030-01-01T12:45:00.000Z" });
  assert.ok((await emails()).every(mail => mail.state === "failed" && mail.attempts === 3));
  assert.deepEqual(requests.slice(0, 2).sort(), requests.slice(2, 4).sort());
  assert.equal((await runOnboardingEmails({ clock: end })).attempted, 0);
});

for (const mode of ["network", "409", "500", "malformed", "204"] as const) test(`${mode} ambiguous acceptance is uncertain and never automatically resent`, async () => {
  await activate();
  let calls = 0;
  globalThis.fetch = async () => { calls++; if (mode === "network") throw new Error("private raw provider error"); return mode === "204" ? new Response(null, { status: 204 }) : Response.json({ private: "body" }, { status: mode === "malformed" ? 200 : Number(mode) }); };
  await runOnboardingEmails({ clock: instant });
  assert.ok((await emails()).every(mail => mail.state === "uncertain" && !mail.error_code?.includes("private")));
  await runOnboardingEmails({ clock: end });
  assert.equal(calls, 2);
});

test("killed worker lease expiry is uncertain and stale completion cannot append a receipt", async () => {
  const { row } = await activate(), mail = (await emails(row.id))[0], token = randomUUID();
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state='sending',attempts=1,claim_token=?,lease_until=? WHERE id=?", [token, "2030-01-01T11:59:59.000Z", mail.id]);
  assert.equal(await recordOnboardingEmailDispatchOutcome(mail.id, token, { state: "accepted", providerMessageId: "stale-id" }), false);
  await runOnboardingEmails({ clock: instant });
  assert.equal((await emails(row.id))[0].state, "uncertain");
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts WHERE email_id=?", [mail.id]))?.count, 0);
});

test("duplicate completion and wrong claim token cannot mutate or duplicate acceptance receipts", async () => {
  await activate();
  globalThis.fetch = async (_url, init) => {
    const key = new Headers(init?.headers).get("idempotency-key"), mail = (await emails()).find(mail => mail.delivery_key === key)!;
    assert.equal(await recordOnboardingEmailDispatchOutcome(mail.id, "foreign-token", { state: "accepted", providerMessageId: "foreign" }), false);
    return Response.json({ emailId: `id-${key}` });
  };
  await runOnboardingEmails({ clock: instant });
  for (const mail of await emails()) assert.equal(await recordOnboardingEmailDispatchOutcome(mail.id, "old-token", { state: "accepted", providerMessageId: mail.provider_message_id! }), false);
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts"))?.count, 2);
});

for (const changed of ["provider", "from", "replyTo", "key", "endpoint"] as const) test(`frozen ${changed} change rejects retry without a provider call`, async t => {
  await activate();
  globalThis.fetch = async () => Response.json({}, { status: 429 });
  await runOnboardingEmails({ clock: instant });
  const before = await emails();
  if (changed === "provider") Object.assign(process.env, { MCA_SYSTEM_EMAIL_PROVIDER: "resend", MCA_RESEND_API_KEY: "new-key", MCA_RESEND_FROM: "service@example.test" });
  if (changed === "from") process.env.MCA_USESEND_FROM = "other@example.test";
  if (changed === "replyTo") process.env.MCA_SYSTEM_EMAIL_REPLY_TO = "other@example.test";
  if (changed === "key") process.env.MCA_USESEND_API_KEY = "other-key";
  if (changed === "endpoint") process.env.MCA_USESEND_BASE_URL = "https://other.example.test";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "unexpected" }); };
  t.mock.timers.setTime(Date.parse("2030-01-01T12:15:00.000Z"));
  await runOnboardingEmails({ clock: "2030-01-01T12:15:00.000Z" });
  assert.equal(calls, 0);
  const after = await emails();
  assert.ok(after.every(mail => mail.state === "failed" && mail.attempts === 1));
  assert.deepEqual(after.map(mail => mail.provider_config_cipher), before.map(mail => mail.provider_config_cipher));
});

test("bounce safety ledger suppresses remaining work immediately before send", async () => {
  await activate();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const mail = (await emails()).find(mail => mail.delivery_key === new Headers(init?.headers).get("idempotency-key"))!;
    await getDatabase().execute("INSERT INTO mca_service_email_suppressions(recipient_hash,provider,provider_account_id,reason,created_at,updated_at) VALUES(?,?,?,'bounce',?,?)", [mail.recipient_hash, mail.provider, mail.provider_account_id, instant, instant]);
    return Response.json({ emailId: "first-accepted" });
  };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(calls, 1);
  assert.equal(counts.suppressed, 1);
  assert.deepEqual((await emails()).map(mail => mail.state).sort(), ["accepted", "suppressed"]);
});

test("webhook selection freezes its endpoint and requires an acceptance identifier", async () => {
  await activate();
  Object.assign(process.env, { MCA_EMAIL_WEBHOOK_URL: "https://hook.example.test/service", MCA_EMAIL_WEBHOOK_TOKEN: "synthetic-token" });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://hook.example.test/service");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-token");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.recipient, "owner@example.test");
    assert.equal(body.template, body.subject === "Get started with Fundlane" ? "getting_started" : "business_information_requested");
    return Response.json({ emailId: new Headers(init?.headers).get("idempotency-key") });
  };
  assert.equal((await runOnboardingEmails({ clock: instant })).accepted, 2);
  assert.ok((await emails()).every(mail => mail.provider === "webhook"));
});

test("comms owns one gated service-email phase with its existing absolute deadline", async () => {
  await activate();
  delete process.env.MCA_NOTIFICATION_RUNTIME;
  assert.equal((await runScheduledCommsJobs(instant)).onboardingEmails?.accepted, 2);
  delete process.env.MCA_ONBOARDING_EMAIL_ENABLED;
  assert.equal((await runScheduledCommsJobs(instant)).onboardingEmails, undefined);
});

test("a response arriving after lease expiry becomes uncertain without acceptance evidence", async t => {
  const { row } = await activate();
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) t.mock.timers.setTime(Date.parse("2030-01-01T12:02:01.000Z"));
    return Response.json({ emailId: `late-${new Headers(init?.headers).get("idempotency-key")}` });
  };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(counts.uncertain, 1);
  assert.equal((await emails(row.id)).filter(mail => mail.state === "uncertain").length, 1);
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts WHERE state='accepted'"))?.count, 1);
});

test("a superseded generation cannot accept a stale result or mutate its replacement", async () => {
  const { row } = await activate(), first = (await emails(row.id))[0], token = randomUUID();
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state='sending',attempts=1,claim_token=?,lease_until=? WHERE id=?", [token, "2030-01-01T12:02:00.000Z", first.id]);
  await getDatabase().execute("UPDATE mca_enrollments SET email_generation=2,revision=revision+1 WHERE id=?", [row.id]);
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET superseded_by_generation=2 WHERE enrollment_id=?", [row.id]);
  await withTransaction(db => enqueueOnboardingEmailIntents(row.id, 2, db));
  assert.equal(await recordOnboardingEmailDispatchOutcome(first.id, token, { state: "accepted", providerMessageId: "stale-generation" }), false);
  assert.ok((await emails(row.id)).filter(mail => mail.generation === 2).every(mail => mail.state === "queued" && mail.attempts === 0));
});

test("explicit Resend selection ignores unrelated useSend configuration", async () => {
  await activate();
  Object.assign(process.env, { MCA_SYSTEM_EMAIL_PROVIDER: "resend", MCA_RESEND_API_KEY: "synthetic-resend", MCA_RESEND_FROM: "Fundlane <service@example.test>", MCA_USESEND_BASE_URL: "invalid unrelated origin" });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.resend.com/emails");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-resend");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.to, ["owner@example.test"]);
    assert.equal(body.reply_to, "help@example.test");
    return Response.json({ id: `resend-${new Headers(init?.headers).get("idempotency-key")}` });
  };
  assert.equal((await runOnboardingEmails({ clock: instant })).accepted, 2);
});

test("retry preserves frozen content and original trial date when application origin changes", async t => {
  await activate();
  const sent: string[] = [];
  globalThis.fetch = async (_url, init) => { sent.push(String(init?.body)); return Response.json({}, { status: 429 }); };
  await runOnboardingEmails({ clock: instant });
  process.env.MCA_APP_ORIGIN = "https://new-app.example.test";
  t.mock.timers.setTime(Date.parse("2030-01-01T12:15:00.000Z"));
  await runOnboardingEmails({ clock: "2030-01-01T12:15:00.000Z" });
  assert.deepEqual(sent.slice(0, 2).sort(), sent.slice(2, 4).sort());
  assert.ok(sent.every(body => !body.includes("new-app.example.test")));
});

test("duplicate provider identifiers hold ambiguous acceptance and do not stop another intent", async () => {
  await activate();
  await activate();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: calls <= 2 ? "duplicate-id" : `other-${calls}` }); };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(calls, 4);
  assert.equal(counts.accepted, 3);
  assert.equal(counts.uncertain, 1);
  assert.equal((await emails()).filter(mail => mail.state === "uncertain").length, 1);
});

test("outcome lease is checked after waiting for a row lock", async t => {
  const { row } = await activate(), mail = (await emails(row.id))[0], token = randomUUID();
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state='sending',attempts=1,claim_token=?,lease_until=? WHERE id=?", [token, "2030-01-01T12:02:00.000Z", mail.id]);
  const holder = new pg.Client({ connectionString: fixture.databaseUrl });
  await holder.connect();
  let pending: Promise<boolean> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM mca_onboarding_service_emails WHERE id=$1 FOR UPDATE", [mail.id]);
    pending = recordOnboardingEmailDispatchOutcome(mail.id, token, { state: "accepted", providerMessageId: "expired-after-lock" });
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const waiting = await fixture.query("SELECT count(*)::int count FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%mca_onboarding_service_emails%'", [fixture.databaseName]);
      blocked = waiting.rows[0].count > 0;
      if (!blocked) await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(blocked, true);
    t.mock.timers.setTime(Date.parse("2030-01-01T12:02:01.000Z"));
    await holder.query("COMMIT");
    assert.equal(await pending, false);
    assert.equal((await emails(row.id))[0].provider_message_id, null);
  } finally {
    await holder.query("ROLLBACK");
    await holder.end();
    if (pending) await pending;
  }
});

for (const missing of ["origin", "malformed_endpoint", "webhook_token"] as const) test(`${missing} configuration holds queued work without attempts`, async () => {
  await activate();
  if (missing === "origin") delete process.env.MCA_APP_ORIGIN;
  if (missing === "malformed_endpoint") process.env.MCA_USESEND_BASE_URL = "invalid endpoint";
  if (missing === "webhook_token") process.env.MCA_EMAIL_WEBHOOK_URL = "https://hook.example.test/service";
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "should-not-send" }); };
  assert.equal((await runOnboardingEmails({ clock: instant })).attempted, 0);
  assert.equal(calls, 0);
  assert.ok((await emails()).every(mail => mail.state === "queued" && mail.attempts === 0 && mail.next_attempt_at === "2030-01-01T12:15:00.000Z"));
});
