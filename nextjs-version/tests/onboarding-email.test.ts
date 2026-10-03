import "./helpers/business-auth";
import test, { after, before, beforeEach, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";
import { assertTransactionExecutor, closeDatabaseForTests, getDatabase, withTransaction } from "../src/lib/mca/db";
import { decryptSensitive, encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto";
import { createEnrollment, findEnrollment, recordEnrollmentActivation } from "../src/lib/mca/onboarding/store";
import { enqueueOnboardingEmailIntents } from "../src/lib/mca/onboarding/email-intents";
import type { EnrollmentActivation, EnrollmentOffer, EnrollmentRecord } from "../src/lib/mca/onboarding/contracts";
import { enrollmentEvidenceScope, readVerifiedEnrollmentBilling, type VerifiedEnrollmentBilling } from "../src/lib/mca/onboarding/evidence";
import { onboardingEmailConfiguration, onboardingEmailProviderIdentity } from "../src/lib/mca/onboarding/email-transport";
import { enrollmentTestEnv, resumeSecret, stripeFixture } from "./helpers/onboarding-billing";
import { startEnrollmentCheckout } from "../src/lib/mca/onboarding/checkout";
import { reconcileEnrollment } from "../src/lib/mca/onboarding/reconcile";
import { persistEntitlement } from "../src/lib/mca/billing";
import { renderOnboardingEmail } from "../src/lib/mca/onboarding/email-content";
import { runOnboardingEmails, recordOnboardingEmailDispatchOutcome } from "../src/lib/mca/onboarding/email-worker";
import { runScheduledCommsJobs } from "../src/lib/mca/comms/scheduler";
import { enqueueNotification, getNotification } from "../src/lib/mca/notifications/service";
import { recordNotificationOutcome, setNotificationReceiptLookupForTests } from "../src/lib/mca/notifications/worker";
import type { DealActor } from "../src/lib/mca/deals/schema";

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
async function activate(initiatingProviderUserId?: string) {
  const row = await createEnrollment({ resumeSecret: randomUUID() + randomUUID(), offer, ...(initiatingProviderUserId ? { initiatingProviderUserId } : {}) }), id = randomUUID();
  const activation: EnrollmentActivation = { sessionId: `cs_${id}`, customerId: `cus_${id}`, subscriptionId: `sub_${id}`, email: "owner@example.test", businessName: "Synthetic company", trialStartedAt: instant, trialEndsAt: end, verifiedAt: instant, billingStatus: "trialing", livemode: false };
  await withTransaction(async db => {
    await recordEnrollmentActivation(row.id, activation, db);
    const evidence: VerifiedEnrollmentBilling = { version: 1, enrollmentId: row.id, accountId: "acct_synthetic", livemode: false, requestGeneration: 1, sessionId: activation.sessionId, customerId: activation.customerId, subscriptionId: activation.subscriptionId, verifiedAt: instant, trialStartedAt: instant, trialEndsAt: end, paymentMethodVerified: true, cardFingerprint: null, entitlement: { subscriptionId: activation.subscriptionId, planId: "price_base", planSlug: "fundlane:1", planName: "Fundlane", status: "trialing", periodStart: instant, periodEnd: end, seatLimit: 1, paymentPastDue: false }, invoices: [], hasUnpaidInvoices: false, delinquentSince: null, delinquentInvoiceId: null, graceEndsAt: null, processingExtensionUntil: null, processingExtensionGrantedAt: null, collectionPaused: false };
    await db.execute("INSERT INTO mca_enrollment_billing_evidence(enrollment_id,provider_account_id,revision,snapshot_cipher,verified_at) VALUES (?,?,1,?,?)", [row.id, "acct_synthetic", encryptSensitive(JSON.stringify(evidence), enrollmentEvidenceScope(row.id)), instant]);
  });
  return { row, activation };
}
async function updateBilling(id: string, status: EnrollmentRecord["billingState"], details: { periodEnd?: string; graceEndsAt?: string | null; processingExtensionUntil?: string | null } = {}) {
  const evidence = (await readVerifiedEnrollmentBilling(id))!;
  const next: VerifiedEnrollmentBilling = { ...evidence, verifiedAt: new Date().toISOString(), entitlement: { ...evidence.entitlement, status, periodEnd: details.periodEnd ?? evidence.entitlement.periodEnd, paymentPastDue: !["trialing", "active"].includes(status) }, graceEndsAt: details.graceEndsAt ?? null, processingExtensionUntil: details.processingExtensionUntil ?? null };
  await withTransaction(async db => {
    await db.execute("UPDATE mca_enrollments SET billing_state=?,revision=revision+1 WHERE id=?", [status, id]);
    await db.execute("UPDATE mca_enrollment_billing_evidence SET snapshot_cipher=?,verified_at=?,revision=revision+1 WHERE enrollment_id=?", [encryptSensitive(JSON.stringify(next), enrollmentEvidenceScope(id)), next.verifiedAt, id]);
  });
}
async function emails(id?: string) {
  return (await getDatabase().query<MailRow>(`SELECT * FROM mca_onboarding_service_emails ${id ? "WHERE enrollment_id=?" : ""} ORDER BY purpose`, id ? [id] : [])).rows;
}
const scope = (row: MailRow) => `onboarding:email:${row.enrollment_id}:${row.generation}`;
type ChallengeRow = { id: string; enrollment_id: string; purpose: string; token_hash: string; state: string; attempts: number; expires_at: string; created_at: string };
async function challenges(id?: string) {
  return (await getDatabase().query<ChallengeRow>(`SELECT * FROM mca_enrollment_challenges ${id ? "WHERE enrollment_id=?" : ""} ORDER BY created_at,id`, id ? [id] : [])).rows;
}
const inviteLink = /https:\/\/app\.example\.test\/api\/enrollment\/invite\?challenge=([0-9a-f-]{36})&token=([A-Za-z0-9_-]{32,256})/;
function namedReplyToConfiguration(provider: "usesend" | "resend" | "webhook") {
  process.env.MCA_SYSTEM_EMAIL_REPLY_TO = "  Replies <Reply@Example.test>  ";
  if (provider === "resend") Object.assign(process.env, { MCA_SYSTEM_EMAIL_PROVIDER: "resend", MCA_RESEND_API_KEY: "synthetic-resend", MCA_RESEND_FROM: "Fundlane <service@example.test>" });
  if (provider === "webhook") Object.assign(process.env, { MCA_EMAIL_WEBHOOK_URL: "https://hook.example.test/service", MCA_EMAIL_WEBHOOK_TOKEN: "synthetic-token" });
  return onboardingEmailConfiguration();
}

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

test("new-owner invite renders a single-use set-password link only for getting_started", () => {
  const invite = { challengeId: randomUUID(), token: "a".repeat(43) };
  const mail = renderOnboardingEmail({ purpose: "getting_started", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test", invite });
  assert.equal(mail.subject, "Set your Fundlane password");
  assert.match(mail.text, new RegExp(`https://app.example.test/api/enrollment/invite\\?challenge=${invite.challengeId}&token=${invite.token}`));
  assert.match(mail.text, /works once/);
  assert.match(mail.text, /24 hours/);
  assert.match(mail.text, /does not create a company/);
  assert.match(mail.text, /Plans & Billing/);
  assert.match(mail.html, /&amp;token=a{43}/);
  assert.doesNotMatch(mail.text, /\/enrollment\?enrollment=/);
  assert.throws(() => renderOnboardingEmail({ purpose: "business_information_requested", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test", invite }));
  for (const bad of [{ challengeId: "not-a-uuid", token: invite.token }, { challengeId: invite.challengeId, token: "short" }, { challengeId: invite.challengeId, token: `${"a".repeat(40)}<x>` }]) assert.throws(() => renderOnboardingEmail({ purpose: "getting_started", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test", invite: bad }));
  const business = renderOnboardingEmail({ purpose: "business_information_requested", enrollmentId: "opaque-id", generation: 2, trialEndsAt: end, origin: "https://app.example.test" });
  for (const item of [/A2P 10DLC/, /business type/, /address/, /website/, /authorized contact/, /use-case description/, /sample messages/, /opt in/]) assert.match(business.text, item);
});

test("first freeze mints exactly one hashed 24-hour invite and frozen retries never mint another", async t => {
  const { row } = await activate();
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(String(init?.body)); return Response.json({}, { status: 429 }); };
  await runOnboardingEmails({ clock: instant });
  const minted = await challenges(row.id);
  assert.equal(minted.length, 1);
  const welcome = (await emails(row.id)).find(mail => mail.purpose === "getting_started")!;
  const content = JSON.parse(decryptSensitive(welcome.content_cipher!, scope(welcome))) as { text: string };
  const [, challengeId, token] = content.text.match(inviteLink)!;
  assert.equal(minted[0].id, challengeId);
  assert.equal(minted[0].purpose, "authentication");
  assert.equal(minted[0].token_hash, hashOpaqueToken(token));
  assert.equal(minted[0].state, "pending");
  assert.equal(minted[0].attempts, 0);
  assert.equal(Date.parse(minted[0].expires_at) - Date.parse(minted[0].created_at), 86_400_000);
  assert.ok(!JSON.stringify((await getDatabase().query("SELECT * FROM mca_enrollment_challenges")).rows).includes(token));
  t.mock.timers.setTime(Date.parse("2030-01-01T12:15:00.000Z"));
  await runOnboardingEmails({ clock: "2030-01-01T12:15:00.000Z" });
  assert.equal((await challenges(row.id)).length, 1);
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies.slice(2).sort(), bodies.slice(0, 2).sort());
});

test("existing accounts receive the sign-in link and no invite", async () => {
  const { row } = await activate(randomUUID());
  const sent: string[] = [];
  globalThis.fetch = async (_url, init) => { sent.push(String(init?.body)); return Response.json({ emailId: randomUUID() }); };
  await runOnboardingEmails({ clock: instant });
  assert.equal((await challenges(row.id)).length, 0);
  const welcome = sent.map(body => JSON.parse(body)).find(body => body.subject === "Get started with Fundlane");
  assert.match(welcome.text, /\/enrollment\?enrollment=.*&destination=crm&generation=1/);
  assert.doesNotMatch(sent.join(), /token=/);
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
    assert.doesNotMatch(JSON.stringify(body), /unsubscribe|secret=|Synthetic company/);
    if (body.subject === "Set your Fundlane password") assert.match(body.text, inviteLink);
    else assert.doesNotMatch(JSON.stringify(body), /token=/);
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

for (const provider of ["usesend", "resend", "webhook"] as const) {
  test(`${provider} first send preserves supported named Reply-To`, async () => {
    const { row } = await activate(), configuration = namedReplyToConfiguration(provider);
    const requests: string[] = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(String(init?.body));
      const id = new Headers(init?.headers).get("idempotency-key");
      return Response.json(provider === "resend" ? { id } : { emailId: id });
    };
    assert.deepEqual(await runOnboardingEmails({ clock: instant }), { attempted: 2, accepted: 2, uncertain: 0, suppressed: 0 });
    assert.equal(requests.length, 2);
    for (const body of requests) assert.equal(JSON.parse(body)[provider === "resend" ? "reply_to" : "replyTo"], "Replies <Reply@Example.test>");
    for (const mail of await emails(row.id)) {
      assert.equal(mail.state, "accepted");
      assert.equal(mail.attempts, 1);
      assert.equal(decryptSensitive(mail.provider_config_cipher!, scope(mail)), JSON.stringify(configuration));
    }
  });

  test(`${provider} frozen retry preserves supported named Reply-To and unchanged payload`, async t => {
    const { row, activation } = await activate(), configuration = namedReplyToConfiguration(provider);
    // A supported snapshot already frozen by a prior worker, after known nonacceptance.
    for (const mail of await emails(row.id)) {
      const content = renderOnboardingEmail({ purpose: mail.purpose, enrollmentId: row.id, generation: mail.generation, trialEndsAt: end, origin: "https://app.example.test" });
      await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state='retry',attempts=1,error_code='onboarding_email_rate_limited',recipient_cipher=?,content_cipher=?,provider_config_cipher=?,provider=?,provider_account_id=?,frozen_at=? WHERE id=?", [encryptSensitive(activation.email, scope(mail)), encryptSensitive(JSON.stringify(content), scope(mail)), encryptSensitive(JSON.stringify(configuration), scope(mail)), provider, onboardingEmailProviderIdentity(configuration), instant, mail.id]);
    }
    const frozen = await emails(row.id), requests: { key: string; body: string }[] = [];
    globalThis.fetch = async (_url, init) => {
      requests.push({ key: new Headers(init?.headers).get("idempotency-key")!, body: String(init?.body) });
      return Response.json({}, { status: 429 });
    };
    assert.deepEqual(await runOnboardingEmails({ clock: instant }), { attempted: 2, accepted: 0, uncertain: 0, suppressed: 0 });
    assert.ok((await emails(row.id)).every(mail => mail.state === "retry" && mail.attempts === 2 && mail.next_attempt_at === "2030-01-01T12:30:00.000Z"));
    globalThis.fetch = async (_url, init) => {
      const key = new Headers(init?.headers).get("idempotency-key")!;
      requests.push({ key, body: String(init?.body) });
      return Response.json(provider === "resend" ? { id: key } : { emailId: key });
    };
    t.mock.timers.setTime(Date.parse("2030-01-01T12:30:00.000Z"));
    assert.deepEqual(await runOnboardingEmails({ clock: "2030-01-01T12:30:00.000Z" }), { attempted: 2, accepted: 2, uncertain: 0, suppressed: 0 });
    assert.deepEqual(requests.slice(0, 2).sort((a, b) => a.key.localeCompare(b.key)), requests.slice(2).sort((a, b) => a.key.localeCompare(b.key)));
    for (const request of requests) assert.equal(JSON.parse(request.body)[provider === "resend" ? "reply_to" : "replyTo"], "Replies <Reply@Example.test>");
    const final = await emails(row.id);
    assert.ok(final.every(mail => mail.state === "accepted" && mail.attempts === 3));
    assert.deepEqual(final.map(mail => [mail.delivery_key, mail.recipient_cipher, mail.content_cipher, mail.provider_config_cipher]), frozen.map(mail => [mail.delivery_key, mail.recipient_cipher, mail.content_cipher, mail.provider_config_cipher]));
  });
}

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
  assert.equal((await challenges(row.id)).length, 1);
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
  assert.equal((await challenges()).length, 1);
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
    assert.equal(body.template, body.subject === "Set your Fundlane password" ? "getting_started" : "business_information_requested");
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

test("slow onboarding backlog leaves useful discovery, receipt repair and old notification work within the common deadline", async t => {
  // Fifteen activations create thirty independently leased intents; no real provider wait.
  for (let index = 0; index < 15; index++) await activate();
  const db = getDatabase(), workspaceId = randomUUID(), userId = randomUUID(), membershipId = randomUUID();
  await db.execute("INSERT INTO workspaces(id,name,timezone,feature_flags,page_visibility,created_at,updated_at) VALUES (?,'Existing notification company','UTC','{\"integrations\":true}','{\"deals\":true,\"integrations\":true}',?,?)", [workspaceId, instant, instant]);
  await db.execute("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES (?,'broker@example.test','Synthetic broker',?,?,?)", [userId, userId, instant, instant]);
  await db.execute("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)", [membershipId, workspaceId, userId, instant, instant]);
  const actor: DealActor = { workspaceId, userId, membershipId, role: "admin", source: "user", managedMembershipIds: [], activeMembershipIds: [membershipId], correlationId: "comms-fairness" };
  const input = { kind: "document" as const, audience: "broker" as const, channel: "email" as const, recipientUserId: userId, scheduledFor: instant, approvedAt: instant, payload: { title: "Existing business notification", message: "Review the existing requested documents." } };
  const queued = await enqueueNotification(actor, { ...input, eventKey: "old-due-notification" });
  const accepted = await enqueueNotification(actor, { ...input, eventKey: "old-due-receipt" });
  await db.execute("UPDATE mca_notifications SET state='sending',attempts=1,claim_token='prior-synthetic-attempt',lease_until=? WHERE id=?", [end, accepted.id]);
  assert.equal(await recordNotificationOutcome(workspaceId, accepted.id, "prior-synthetic-attempt", { state: "accepted", providerMessageId: "prior-provider-id" }, instant), true);
  const startedAt = Date.now(), overallDeadline = startedAt + 230_000;
  const advance = (ms: number) => t.mock.timers.setTime(Date.now() + ms);
  const onboardingKeys: string[] = [], oldNotificationKeys: string[] = [];
  const budgets: { discovery?: number; receipt?: number; send: number[]; receiptDeadline?: number } = { send: [] };
  const originalQuery = pg.Client.prototype.query;
  t.mock.method(pg.Client.prototype, "query", (async function(this: pg.Client, ...args: unknown[]) {
    const query = args[0], text = typeof query === "string" ? query : query && typeof query === "object" && "text" in query ? String(query.text) : "";
    const result = await Reflect.apply(originalQuery, this, args);
    if (text.includes("SELECT * FROM mca_document_notification_discovery")) {
      budgets.discovery = overallDeadline - Date.now();
      advance(15_000); // Charge the actual discovery entry its worst-case budget.
    }
    if (text.includes("SELECT * FROM mca_notifications WHERE state IN ('queued','retry')")) budgets.send.push(overallDeadline - Date.now());
    return result;
  }) as typeof originalQuery);
  setNotificationReceiptLookupForTests(async (row, context) => {
    assert.equal(row.id, accepted.id);
    assert.equal(row.provider_message_id, "prior-provider-id");
    budgets.receipt = context.deadlineMs - Date.now(); budgets.receiptDeadline = context.deadlineMs;
    advance(15_000);
    return { state: "delivered", providerMessageId: "prior-provider-id" };
  });
  t.after(() => { setNotificationReceiptLookupForTests(); delete process.env.MCA_NOTIFICATION_RUNTIME; });
  globalThis.fetch = async (_url, init) => {
    const key = new Headers(init?.headers).get("idempotency-key")!, body = JSON.parse(String(init?.body));
    advance(15_000);
    if (body.subject === "Existing business notification") {
      oldNotificationKeys.push(key);
      return Response.json({ emailId: "old-notification-accepted" });
    }
    onboardingKeys.push(key);
    throw new Error("Synthetic slow unknown provider acceptance");
  };
  process.env.MCA_NOTIFICATION_RUNTIME = "enabled";
  const result = await runScheduledCommsJobs(instant);
  const held = await emails();
  t.diagnostic(JSON.stringify({ result, budgets, elapsedMs: Date.now() - startedAt, onboardingQueued: held.filter(mail => mail.state === "queued").length, onboardingHeld: held.filter(mail => mail.state === "uncertain").length }));
  assert.equal(result.notifications?.accepted, 1, "existing business mail must progress despite onboarding backlog");
  assert.deepEqual(result.onboardingEmails, { attempted: 9, accepted: 0, uncertain: 9, suppressed: 0 });
  assert.equal(budgets.discovery, 95_000);
  assert.equal(budgets.receipt, 80_000, "receipt repair retains its actual 60-second entry threshold after discovery");
  assert.equal(budgets.receiptDeadline, overallDeadline, "the shared 230-second deadline is unchanged");
  // The last empty claim also observes the remaining budget after the useful send.
  assert.deepEqual(budgets.send, [65_000, 50_000]);
  assert.equal(Date.now() - startedAt, 180_000);
  assert.equal((await getNotification(actor, queued.id)).state, "accepted");
  assert.equal((await getNotification(actor, queued.id)).attempts, 1);
  assert.equal((await getNotification(actor, accepted.id)).state, "delivered");
  assert.equal((await getNotification(actor, accepted.id)).attempts, 1);
  assert.deepEqual(oldNotificationKeys, [`notification:${queued.id}`]);
  assert.equal(held.filter(mail => mail.state === "uncertain" && mail.attempts === 1 && !mail.claim_token && !mail.lease_until).length, 9);
  assert.equal(held.filter(mail => mail.state === "queued" && mail.attempts === 0 && !mail.claim_token && !mail.lease_until).length, 21);
  assert.equal(new Set(onboardingKeys).size, 9);
  assert.equal((await db.queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_notification_receipts WHERE notification_id=? AND state='delivered' AND evidence='verified_provider_lookup'", [accepted.id]))?.count, 1);
  // With mail dispatch disabled the same owner still runs old notifications and never replays held mail.
  delete process.env.MCA_ONBOARDING_EMAIL_ENABLED;
  const followup = await enqueueNotification(actor, { ...input, eventKey: "old-mail-with-onboarding-disabled" });
  const next = await runScheduledCommsJobs(new Date().toISOString());
  assert.equal(next.onboardingEmails, undefined);
  assert.equal(next.notifications?.accepted, 1);
  assert.equal((await getNotification(actor, followup.id)).state, "accepted");
  assert.equal(onboardingKeys.length, 9);
  await db.execute("DELETE FROM mca_notification_receipts WHERE workspace_id=?", [workspaceId]);
  await db.execute("DELETE FROM mca_notifications WHERE workspace_id=?", [workspaceId]);
  await db.execute("DELETE FROM memberships WHERE workspace_id=?", [workspaceId]);
  await db.execute("DELETE FROM workspaces WHERE id=?", [workspaceId]);
  await db.execute("DELETE FROM users WHERE id=?", [userId]);
  delete process.env.MCA_NOTIFICATION_RUNTIME;
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

for (const state of ["canceled", "paused", "unpaid", "incomplete", "incomplete_expired"] as const) test(`${state} enrollment lifecycle suppresses first send without CRM mutations`, async () => {
  const { row } = await activate();
  await updateBilling(row.id, state);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "must-not-send" }); };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(calls, 0);
  assert.equal(counts.suppressed, 2);
  assert.ok((await emails(row.id)).every(mail => mail.state === "suppressed" && mail.attempts === 0));
  assert.equal((await findEnrollment(row.id))?.workspaceId, null);
  assert.equal((await findEnrollment(row.id))?.recoveryState, "none");
});

test("ordinary cancellation between attempts suppresses frozen retries without changing accepted history", async t => {
  const { row } = await activate();
  globalThis.fetch = async (_url, init) => JSON.parse(String(init?.body)).subject === "Set your Fundlane password" ? Response.json({ emailId: "already-accepted" }) : Response.json({}, { status: 429 });
  await runOnboardingEmails({ clock: instant });
  const frozen = await emails(row.id);
  t.mock.timers.setTime(Date.parse("2030-01-01T12:15:00.000Z"));
  await updateBilling(row.id, "canceled");
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "must-not-retry" }); };
  assert.equal((await runOnboardingEmails({ clock: "2030-01-01T12:15:00.000Z" })).suppressed, 1);
  assert.equal(calls, 0);
  const final = await emails(row.id);
  assert.deepEqual(final.map(mail => mail.state), ["suppressed", "accepted"]);
  assert.deepEqual(final.map(mail => mail.content_cipher), frozen.map(mail => mail.content_cipher));
  assert.equal(final[1].provider_message_id, "already-accepted");
  assert.equal((await emails(row.id)).length, 2);
});

for (const [label, details, allowed] of [
  ["no grace", {}, false],
  ["live grace", { graceEndsAt: "2030-01-01T12:30:00.000Z" }, true],
  ["expired grace", { graceEndsAt: "2030-01-01T11:59:59.000Z" }, false],
  ["verified processing extension", { graceEndsAt: "2030-01-01T11:59:59.000Z", processingExtensionUntil: "2030-01-01T12:30:00.000Z" }, true],
] as const) test(`past_due with ${label} follows the existing entitlement policy`, async () => {
  const { row } = await activate();
  await updateBilling(row.id, "past_due", details);
  let calls = 0;
  globalThis.fetch = async (_url, init) => { calls++; return Response.json({ emailId: `policy-${new Headers(init?.headers).get("idempotency-key")}` }); };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(calls, allowed ? 2 : 0);
  assert.equal(counts.accepted, allowed ? 2 : 0);
  assert.equal(counts.suppressed, allowed ? 0 : 2);
});

test("delayed paid conversion can receive setup guidance without active-trial or future-conversion promises", async t => {
  const { row } = await activate();
  t.mock.timers.setTime(Date.parse("2030-01-16T12:00:00.000Z"));
  await updateBilling(row.id, "active", { periodEnd: "2030-02-15T12:00:00.000Z" });
  const copy: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    copy.push(body.text);
    return Response.json({ emailId: `converted-${new Headers(init?.headers).get("idempotency-key")}` });
  };
  assert.equal((await runOnboardingEmails({ clock: "2030-01-16T12:00:00.000Z" })).accepted, 2);
  const welcome = copy.find(text => text.includes("Welcome to Fundlane"))!;
  assert.match(welcome, /Original trial end: 2030-01-15T12:00:00.000Z/);
  assert.doesNotMatch(welcome, /trial is active|cancel before|automatic paid subscription begins/i);
});

test("stale trialing evidence cannot extend the original trial boundary", async t => {
  const { row } = await activate();
  t.mock.timers.setTime(Date.parse(end));
  await updateBilling(row.id, "trialing", { periodEnd: "2030-02-15T12:00:00.000Z" });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "stale-trial" }); };
  assert.equal((await runOnboardingEmails({ clock: end })).suppressed, 2);
  assert.equal(calls, 0);
});

test("frozen retry crossing paid conversion retains truthful original content", async t => {
  const { row } = await activate();
  t.mock.timers.setTime(Date.parse("2030-01-15T11:50:00.000Z"));
  const bodies: string[] = [];
  globalThis.fetch = async (_url, init) => { bodies.push(String(init?.body)); return Response.json({}, { status: 429 }); };
  await runOnboardingEmails({ clock: "2030-01-15T11:50:00.000Z" });
  const frozen = await emails(row.id);
  t.mock.timers.setTime(Date.parse("2030-01-15T12:05:00.000Z"));
  await updateBilling(row.id, "active", { periodEnd: "2030-02-15T12:00:00.000Z" });
  globalThis.fetch = async (_url, init) => { bodies.push(String(init?.body)); return Response.json({ emailId: `after-conversion-${new Headers(init?.headers).get("idempotency-key")}` }); };
  assert.equal((await runOnboardingEmails({ clock: "2030-01-15T12:05:00.000Z" })).accepted, 2);
  assert.deepEqual(bodies.slice(0, 2).sort(), bodies.slice(2, 4).sort());
  assert.doesNotMatch(bodies.join(" "), /trial is active|cancel before|automatic paid subscription begins/i);
  assert.deepEqual((await emails(row.id)).map(mail => mail.content_cipher), frozen.map(mail => mail.content_cipher));
});

test("valid trial scheduled for period-end cancellation remains eligible until original end", async () => {
  Object.assign(process.env, enrollmentTestEnv, { MCA_APP_ORIGIN: "https://app.example.test", MCA_ONBOARDING_EMAIL_ENABLED: "true" });
  const f = stripeFixture(), checkout = await startEnrollmentCheckout({ resumeSecret: resumeSecret() }, f.client);
  f.complete();
  await reconcileEnrollment(checkout.enrollmentId, f.client);
  f.state.subscription.cancel_at_period_end = true;
  await reconcileEnrollment(checkout.enrollmentId, f.client);
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(counts.accepted, 2);
  assert.equal((await findEnrollment(checkout.enrollmentId))?.billingState, "trialing");
  assert.equal((await findEnrollment(checkout.enrollmentId))?.trialEndsAt, end);
});

test("current company projection supersedes stale enrollment trial status", async () => {
  const { row } = await activate(), workspaceId = randomUUID(), evidence = (await readVerifiedEnrollmentBilling(row.id))!;
  await withTransaction(async db => {
    await db.execute("INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,'Synthetic canceled company','{}','{}',?,?)", [workspaceId, instant, instant]);
    await db.execute("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,state_kind,updated_at) VALUES (?,0,'customer',?)", [workspaceId, instant]);
    await persistEntitlement(workspaceId, { ...evidence.entitlement, status: "canceled", periodEnd: end }, "stripe_api", db);
    await db.execute("UPDATE mca_enrollments SET workspace_id=?,revision=revision+1 WHERE id=?", [workspaceId, row.id]);
  });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "stale-company-status" }); };
  assert.equal((await runOnboardingEmails({ clock: instant })).suppressed, 2);
  assert.equal(calls, 0);
});

for (const corruption of ["malformed", "wrong_aad"] as const) test(`${corruption} frozen snapshot is held independently without provider I/O or fabricated receipt`, async () => {
  const { row } = await activate(), broken = (await emails(row.id))[0], configuration = onboardingEmailConfiguration();
  const privateValue = "synthetic-private-snapshot-detail";
  const contentCipher = corruption === "malformed" ? encryptSensitive(JSON.stringify({ subject: privateValue }), scope(broken)) : encryptSensitive(JSON.stringify({ subject: privateValue, text: privateValue, html: privateValue }), "foreign-restored-scope");
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET recipient_cipher=?,content_cipher=?,provider_config_cipher=?,provider=?,provider_account_id=?,frozen_at=? WHERE id=?", [encryptSensitive("owner@example.test", scope(broken)), contentCipher, encryptSensitive(JSON.stringify(configuration), scope(broken)), configuration.provider, onboardingEmailProviderIdentity(configuration), instant, broken.id]);
  const sent: string[] = [];
  globalThis.fetch = async (_url, init) => { sent.push(String(init?.body)); return Response.json({ emailId: "independent-valid-intent" }); };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(counts.attempted, 1);
  assert.equal(counts.accepted, 1);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent.join(" "), new RegExp(privateValue));
  const final = await emails(row.id);
  assert.deepEqual(final.map(mail => mail.state), ["failed", "accepted"]);
  assert.equal(final[0].attempts, 0);
  assert.equal(final[0].error_code, "onboarding_email_snapshot_unreadable");
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts WHERE email_id=?", [broken.id]))?.count, 0);
  assert.equal((await runOnboardingEmails({ clock: end })).attempted, 0);
});

test("billing cancellation after freezing is rechecked immediately before provider I/O", async t => {
  await activate();
  const original = pg.Client.prototype.query;
  let changed = false, calls = 0;
  t.mock.method(pg.Client.prototype, "query", (async function(this: pg.Client, ...args: unknown[]) {
    const input = args[0], text = typeof input === "string" ? input : input && typeof input === "object" && "text" in input ? String(input.text) : "";
    const result = await Reflect.apply(original, this, args);
    if (!changed && text.includes("UPDATE mca_onboarding_service_emails SET recipient_cipher=")) {
      changed = true;
      await fixture.query("UPDATE mca_enrollments SET billing_state='canceled',revision=revision+1 WHERE id=$1", [result.rows[0].enrollment_id]);
    }
    return result;
  }) as typeof original);
  globalThis.fetch = async () => { calls++; return Response.json({ emailId: "canceled-during-freeze" }); };
  const counts = await runOnboardingEmails({ clock: instant });
  assert.equal(changed, true);
  assert.equal(calls, 0);
  assert.equal(counts.attempted, 0);
  assert.equal(counts.suppressed, 2);
});
