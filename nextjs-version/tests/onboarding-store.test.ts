import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs";
import { closeDatabaseForTests, getDatabase, withTransaction } from "../src/lib/mca/db";
import { decryptSensitive, encryptSensitive } from "../src/lib/mca/crypto";
import { createEnrollment, findEnrollment, recordEnrollmentActivation, verifyEnrollmentResume } from "../src/lib/mca/onboarding/store";
import { enqueueOnboardingEmailIntents } from "../src/lib/mca/onboarding/email-intents";
import { enrollmentCreationEnabled, enrollmentRuntimeEnabled, onboardingEmailEnabled } from "../src/lib/mca/onboarding/config";
import type { EnrollmentActivation, EnrollmentOffer } from "../src/lib/mca/onboarding/contracts";
import { runtimeTablePrivileges } from "../scripts/database/runtime-grants";
const run = promisify(execFile);

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>;
const originalEnv = { ...process.env };
const offer: EnrollmentOffer = { version: 1, accountId: "acct_synthetic", basePriceId: "price_base", seatPriceId: "price_seats", currency: "usd", baseAmount: 39900, quantity: 1, trialDays: 14, livemode: false, promotionCodes: true, automaticTax: false };
function activation(): EnrollmentActivation {
  const key = randomUUID();
  return { sessionId: `cs_${key}`, customerId: `cus_${key}`, subscriptionId: `sub_${key}`, email: "owner@example.test", businessName: "Synthetic Test Company", trialStartedAt: "2026-10-01T12:00:00.000Z", trialEndsAt: "2026-10-15T12:00:00.000Z", verifiedAt: "2026-10-01T12:05:00.000Z", billingStatus: "trialing", livemode: false };
}
const secret = () => randomUUID() + randomUUID();
before(async () => {
  fixture = await createPostgresTestDatabase("onboarding_store");
  process.env.DATABASE_URL = fixture.databaseUrl;
  process.env.MCA_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64url");
});
after(async () => {
  await closeDatabaseForTests();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  if (fixture) await fixture.close();
});

test("concurrent duplicate resume secrets create one enrollment, hash the secret, and reject foreign bindings", async () => {
  const resumeSecret = secret();
  const rows = await Promise.all(Array.from({ length: 5 }, () => createEnrollment({ resumeSecret, offer })));
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  assert.equal(verifyEnrollmentResume(rows[0], resumeSecret), true);
  assert.equal(verifyEnrollmentResume(rows[0], secret()), false);
  assert.notEqual(rows[0].resumeSecretHash, resumeSecret);
  assert.equal((await findEnrollment(rows[0].id))?.workspaceId, null);
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM workspaces"))?.count, 0);
  await assert.rejects(createEnrollment({ resumeSecret, offer: { ...offer, automaticTax: true } }), { code: "enrollment_conflict" });
  await assert.rejects(createEnrollment({ resumeSecret, offer, initiatingProviderUserId: randomUUID() }), { code: "enrollment_conflict" });
});

test("transaction-only activation retries converge on exactly two encrypted pre-company email intents", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const input = activation();
  await assert.rejects(recordEnrollmentActivation(row.id, input, getDatabase()), /transaction/i);
  await assert.rejects(enqueueOnboardingEmailIntents(row.id, 1, getDatabase()), /transaction/i);
  await Promise.all(Array.from({ length: 4 }, () => withTransaction(db => recordEnrollmentActivation(row.id, input, db))));
  const updated = (await findEnrollment(row.id))!;
  assert.equal(updated.trialStartedAt, input.trialStartedAt);
  assert.equal(updated.trialEndsAt, input.trialEndsAt);
  assert.equal(updated.checkoutState, "complete");
  const emails = (await getDatabase().query<{ purpose: string; workspace_id: null; payload_cipher: string; recipient_hash: string }>("SELECT * FROM mca_onboarding_service_emails WHERE enrollment_id=?", [row.id])).rows;
  assert.deepEqual(emails.map(e => e.purpose).sort(), ["business_information_requested", "getting_started"]);
  assert.ok(emails.every(e => e.workspace_id === null));
  for (const persisted of [updated.contactCipher, updated.providerSnapshotCipher, ...emails.map(e => e.payload_cipher)]) {
    assert.ok(persisted);
    assert.ok(!persisted!.includes(input.email));
    assert.ok(!persisted!.includes(input.businessName));
  }
  assert.equal(JSON.parse(decryptSensitive(updated.contactCipher!, `onboarding:enrollment:${row.id}`)).email, input.email);
  assert.throws(() => decryptSensitive(updated.contactCipher!, `onboarding:enrollment:${randomUUID()}`));
  assert.ok(emails.every(e => !decryptSensitive(e.payload_cipher, `onboarding:email:${row.id}:1`).includes("ein")));
});

test("a second activation cannot change provider association or restart the trial; direct writes are guarded too", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const input = activation();
  await withTransaction(db => recordEnrollmentActivation(row.id, input, db));
  await assert.rejects(withTransaction(db => recordEnrollmentActivation(row.id, { ...input, trialStartedAt: "2026-10-02T12:00:00.000Z", trialEndsAt: "2026-10-16T12:00:00.000Z" }, db)), /conflict/i);
  await assert.rejects(withTransaction(db => recordEnrollmentActivation(row.id, { ...input, subscriptionId: "sub_foreign" }, db)), /conflict/i);
  await assert.rejects(getDatabase().execute("UPDATE mca_enrollments SET trial_ends_at=?,revision=revision+1 WHERE id=?", ["2026-10-16T12:00:00.000Z", row.id]), /immutable/i);
  assert.equal((await findEnrollment(row.id))?.trialEndsAt, input.trialEndsAt);
});

test("activation validates mode, complete IDs and exactly fourteen provider days", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const input = activation();
  for (const invalid of [{ ...input, livemode: true }, { ...input, sessionId: "" }, { ...input, trialEndsAt: "2026-10-16T12:00:00.000Z" }]) {
    await assert.rejects(withTransaction(db => recordEnrollmentActivation(row.id, invalid, db)));
  }
  assert.equal((await findEnrollment(row.id))?.activatedAt, null);
});

test("provider IDs are unique across enrollments", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const input = activation();
  await withTransaction(db => recordEnrollmentActivation(row.id, input, db));
  for (const reused of ["sessionId", "customerId", "subscriptionId"] as const) {
    const other = await createEnrollment({ resumeSecret: secret(), offer });
    const competing = { ...activation(), [reused]: input[reused] };
    await assert.rejects(withTransaction(db => recordEnrollmentActivation(other.id, competing, db)), /unique/i);
  }
});

test("invalid states, revisions, incomplete claims and stale compare-and-swap fail", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  for (const change of ["checkout_state='invented'", "billing_state='invented'", "claim_state='invented'", "recovery_state='invented'", "revision=0", "revision=revision+2", "claim_state='claimed'"]) {
    await assert.rejects(getDatabase().execute(`UPDATE mca_enrollments SET ${change}${change.startsWith("revision") ? "" : ",revision=revision+1"} WHERE id=?`, [row.id]));
  }
  assert.equal(await getDatabase().execute("UPDATE mca_enrollments SET revision=revision+1 WHERE id=? AND revision=?", [row.id, row.revision]), 1);
  assert.equal(await getDatabase().execute("UPDATE mca_enrollments SET revision=revision+1 WHERE id=? AND revision=?", [row.id, row.revision]), 0);
});

test("rollback after activation or between intents leaves neither activation nor partial mail", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  await assert.rejects(withTransaction(async db => {
    await recordEnrollmentActivation(row.id, activation(), db);
    throw new Error("after activation injected failure");
  }), /injected/);
  assert.equal((await findEnrollment(row.id))?.activatedAt, null);
  await getDatabase().execute(`CREATE FUNCTION reject_getting_started() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.purpose='getting_started' THEN RAISE EXCEPTION 'second intent injected failure'; END IF; RETURN NEW; END $$`);
  await getDatabase().execute("CREATE TRIGGER test_reject_email BEFORE INSERT ON mca_onboarding_service_emails FOR EACH ROW EXECUTE FUNCTION reject_getting_started()");
  try {
    await assert.rejects(withTransaction(db => recordEnrollmentActivation(row.id, activation(), db)), /second intent/);
    assert.equal((await findEnrollment(row.id))?.activatedAt, null);
    assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=?", [row.id]))?.count, 0);
  } finally { await getDatabase().execute("DROP TRIGGER test_reject_email ON mca_onboarding_service_emails"); }
});

async function tenant() {
  const db = getDatabase(); const id = randomUUID(); const userId = randomUUID(); const providerId = randomUUID(); const memberId = randomUUID(); const now = new Date().toISOString();
  await withTransaction(async tx => {
    await tx.execute("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", [userId, `${id}@example.test`, "Synthetic Owner", id, providerId, now, now]);
    await tx.execute("INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) VALUES (?,?,?,?,?,?)", [id, "Synthetic Company", "{}", "{}", now, now]);
    await tx.execute("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)", [memberId, id, userId, now, now]);
    await tx.execute("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)", [id, memberId, now]);
  });
  return { db, id, userId, providerId, now };
}

test("workspace binding is unique and mail cannot bind a foreign enrollment workspace", async () => {
  const owned = await tenant();
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const other = await createEnrollment({ resumeSecret: secret(), offer });
  await withTransaction(db => recordEnrollmentActivation(row.id, activation(), db));
  await owned.db.execute("UPDATE mca_enrollments SET workspace_id=?,user_id=?,claimed_provider_user_id=?,claim_state='claimed',finalization_state='complete',revision=revision+1 WHERE id=?", [owned.id, owned.userId, owned.providerId, row.id]);
  await assert.rejects(owned.db.execute("UPDATE mca_enrollments SET workspace_id=?,revision=revision+1 WHERE id=?", [owned.id, other.id]), /unique/i);
  const foreign = await tenant();
  await assert.rejects(owned.db.execute("UPDATE mca_onboarding_service_emails SET workspace_id=? WHERE enrollment_id=?", [foreign.id, row.id]), /foreign key/i);
});

test("auth and recovery challenges are expiring, bounded and can precede an Auth identity", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const db = getDatabase(); const now = "2026-10-01T12:00:00.000Z"; const cipher = encryptSensitive("new@example.test", `onboarding:enrollment:${row.id}`);
  const insert = (attempts: number, expires: string) => db.execute("INSERT INTO mca_enrollment_challenges(id,enrollment_id,purpose,token_hash,email_cipher,email_hash,resume_generation,attempts,expires_at,created_at,updated_at) VALUES (?,?, 'contact_recovery', ?,?,?,1,?,?,?,?)", [randomUUID(), row.id, secret(), cipher, secret(), attempts, expires, now, now]);
  assert.equal(await insert(0, "2026-10-01T12:15:00.000Z"), 1);
  await assert.rejects(insert(6, "2026-10-01T12:15:00.000Z"), /check/i);
  await assert.rejects(insert(0, now), /check/i);
  await assert.rejects(insert(0, "2026-10-03T12:00:00.000Z"), /check/i);
});

test("Checkout generation requests retain immutable payload, account, keys and recovery windows", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  const db = getDatabase(); const now = "2026-10-01T12:00:00.000Z";
  for (const generation of [1, 2]) {
    await db.execute("INSERT INTO mca_enrollment_checkout_requests(id,enrollment_id,generation,request_key,request_cipher,payload_hash,provider_account_id,requested_at,idempotency_expires_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [randomUUID(), row.id, generation, `${row.id}:${generation}`, encryptSensitive("synthetic checkout payload", `onboarding:checkout:${row.id}:${generation}`), secret(), offer.accountId, now, "2026-10-02T12:00:00.000Z", now]);
  }
  await assert.rejects(db.execute("UPDATE mca_enrollment_checkout_requests SET request_key='new-key' WHERE enrollment_id=?", [row.id]), /immutable/i);
  await assert.rejects(db.execute("UPDATE mca_enrollment_checkout_requests SET request_cipher='changed' WHERE enrollment_id=?", [row.id]), /immutable/i);
  assert.equal((await db.queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_enrollment_checkout_requests WHERE enrollment_id=?", [row.id]))?.count, 2);
  await assert.rejects(db.execute("INSERT INTO mca_enrollment_checkout_requests(id,enrollment_id,generation,request_key,request_cipher,payload_hash,provider_account_id,requested_at,idempotency_expires_at,updated_at) VALUES (?,?,3,?,?,?,?,?,?,?)", [randomUUID(), row.id, secret(), "cipher", secret(), "acct_foreign", now, "2026-10-02T12:00:00.000Z", now]), /foreign key/i);
});

test("current generation gates reissue while original trial history and frozen email remain immutable", async () => {
  const row = await createEnrollment({ resumeSecret: secret(), offer });
  await withTransaction(db => recordEnrollmentActivation(row.id, activation(), db));
  const initial = (await findEnrollment(row.id))!;
  await withTransaction(async db => {
    await db.execute("UPDATE mca_enrollments SET email_generation=2,resume_generation=2,email_hash='corrected',email_domain_hash='corrected',revision=revision+1 WHERE id=?", [row.id]);
    await enqueueOnboardingEmailIntents(row.id, 2, db);
  });
  await assert.rejects(withTransaction(db => enqueueOnboardingEmailIntents(row.id, 1, db)), { code: "enrollment_email_generation_conflict" });
  assert.equal((await findEnrollment(row.id))?.activationEmailHash, initial.activationEmailHash);
  await assert.rejects(getDatabase().execute("UPDATE mca_enrollments SET activation_email_hash='changed',revision=revision+1 WHERE id=?", [row.id]), /immutable/i);
  assert.equal((await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_emails WHERE enrollment_id=?", [row.id]))?.count, 4);
  const email = (await getDatabase().queryOne<{ id: string }>("SELECT id FROM mca_onboarding_service_emails WHERE enrollment_id=? LIMIT 1", [row.id]))!;
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET frozen_at=?,provider='synthetic',provider_account_id='synthetic',content_cipher='cipher',recipient_cipher='cipher',provider_config_cipher='cipher' WHERE id=?", [new Date().toISOString(), email.id]);
  await assert.rejects(getDatabase().execute("UPDATE mca_onboarding_service_emails SET content_cipher='replacement' WHERE id=?", [email.id]), /immutable/i);
  await assert.rejects(getDatabase().execute("UPDATE mca_onboarding_service_emails SET payload_cipher='replacement' WHERE id=?", [email.id]), /immutable/i);
});

test("receipt evidence cannot associate a foreign enrollment and duplicate provider events converge", async () => {
  const first = await createEnrollment({ resumeSecret: secret(), offer }); const second = await createEnrollment({ resumeSecret: secret(), offer });
  await withTransaction(db => recordEnrollmentActivation(first.id, activation(), db));
  const email = (await getDatabase().queryOne<{ id: string }>("SELECT id FROM mca_onboarding_service_emails WHERE enrollment_id=? LIMIT 1", [first.id]))!;
  const insert = (enrollmentId: string, eventKey: string) => getDatabase().execute("INSERT INTO mca_onboarding_service_email_receipts(id,enrollment_id,email_id,provider,provider_account_id,event_key,state,evidence_type,occurred_at,observed_at) VALUES (?,?,?,'synthetic','synthetic',?,'accepted','verified_webhook',?,?)", [randomUUID(), enrollmentId, email.id, eventKey, new Date().toISOString(), new Date().toISOString()]);
  await assert.rejects(insert(second.id, secret()), /foreign key/i);
  const eventKey = secret(); await insert(first.id, eventKey);
  await assert.rejects(insert(first.id, eventKey), /unique/i);
});

test("versioned business basics encrypt EIN and sender evidence has tenant-bound distinct outcomes", async () => {
  const owned = await tenant(); const foreign = await tenant(); const db = getDatabase();
  const value = JSON.stringify({ version: 1, legalName: "Synthetic Legal Name", ein: "123456789" });
  const cipher = encryptSensitive(value, owned.id);
  await db.execute("INSERT INTO company_basic_profiles(workspace_id,profile_cipher,revision,supplied_at,updated_by_user_id,updated_at) VALUES (?,?,1,?,?,?)", [owned.id, cipher, owned.now, owned.userId, owned.now]);
  const profile = await db.queryOne<{ profile_cipher: string }>("SELECT profile_cipher FROM company_basic_profiles WHERE workspace_id=?", [owned.id]);
  assert.ok(!profile!.profile_cipher.includes("123456789"));
  assert.equal(decryptSensitive(profile!.profile_cipher, owned.id), value);
  assert.throws(() => decryptSensitive(profile!.profile_cipher, foreign.id));
  await assert.rejects(db.execute("UPDATE company_basic_profiles SET revision=0 WHERE workspace_id=?", [owned.id]));
  const senderId = randomUUID();
  await db.execute("INSERT INTO mca_email_senders(id,workspace_id,provider,purpose,from_name,from_address,state,created_at,updated_at) VALUES (?,?,'smtp','submission','Test','owner@example.test','verified',?,?)", [senderId, owned.id, owned.now, owned.now]);
  for (const state of ["preview", "accepted", "received"]) {
    await db.execute("INSERT INTO mca_sender_test_runs(id,workspace_id,sender_id,request_key,sender_fingerprint,recipient_cipher,recipient_hash,recipient_control_confirmed,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,true,?,?,?)", [randomUUID(), owned.id, senderId, randomUUID(), secret(), cipher, secret(), state, owned.now, owned.now]);
  }
  await assert.rejects(db.execute("INSERT INTO mca_sender_test_runs(id,workspace_id,sender_id,request_key,sender_fingerprint,recipient_cipher,recipient_hash,recipient_control_confirmed,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,true,'preview',?,?)", [randomUUID(), foreign.id, senderId, randomUUID(), secret(), cipher, secret(), owned.now, owned.now]), /foreign key/i);
});

test("migration and release registry restrict enrollment tables and append-only receipt privileges", async () => {
  const tables = ["mca_enrollments", "mca_enrollment_checkout_requests", "mca_enrollment_challenges", "mca_onboarding_service_emails", "mca_onboarding_service_email_receipts", "mca_service_email_suppressions", "company_basic_profiles", "mca_sender_test_runs"];
  const persisted = (await getDatabase().query<{ relname: string; relrowsecurity: boolean; public_access: boolean }>("SELECT c.relname,c.relrowsecurity,EXISTS(SELECT FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) public_access FROM pg_class c WHERE c.relname=ANY(?::text[])", [tables])).rows;
  assert.equal(persisted.length, tables.length);
  assert.ok(persisted.every(row => row.relrowsecurity && !row.public_access));
  for (const table of tables) assert.equal(runtimeTablePrivileges(table), table.endsWith("receipts") ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE");
  const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/database/secure-runtime.ts"], { env: fixture.env({ MCA_DB_RUNTIME_PASSWORD: "synthetic_disposable_password_123456789" }) });
  assert.match(stdout, /Application RLS, browser restrictions, and server role configured/);
  const grants = (await getDatabase().query<{ table_name: string; privilege_type: string }>("SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='mca_app' AND table_name=ANY(?::text[])", [tables])).rows;
  assert.equal(grants.length, 3 * tables.length - 1);
  assert.ok(grants.every(row => row.privilege_type !== "DELETE"));
  assert.ok(grants.filter(row => row.table_name.endsWith("receipts")).every(row => ["SELECT", "INSERT"].includes(row.privilege_type)));
  for (const table of tables) {
    const flags = await getDatabase().queryOne<{ browser: boolean; can_delete: boolean }>("SELECT has_table_privilege('authenticated',?, 'SELECT') browser,has_table_privilege('mca_app',?, 'DELETE,TRUNCATE') can_delete", [table, table]);
    assert.deepEqual(flags, { browser: false, can_delete: false });
  }
  await withTransaction(async db => { await db.execute("SET LOCAL ROLE mca_app"); assert.ok(await findEnrollment((await createEnrollment({ resumeSecret: secret(), offer }, db)).id, db)); });
  await assert.rejects(withTransaction(async db => { await db.execute("SET LOCAL ROLE mca_app"); await db.execute("UPDATE mca_onboarding_service_email_receipts SET state='delivered'"); }), { code: "42501" });
});

test("creation and dispatch gates are independent and default off; rollback preserves existing runtime", () => {
  const keys = ["MCA_ONBOARDING_RUNTIME_ENABLED", "MCA_STRIPE_FIRST_ONBOARDING_ENABLED", "MCA_ONBOARDING_EMAIL_ENABLED", "MCA_SIGNUP_MODE", "MCA_STRIPE_BILLING_ENABLED", "MCA_STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_BASE_PRICE_ID", "STRIPE_ADDITIONAL_SEAT_PRICE_ID", "STRIPE_BILLING_WEBHOOK_SECRET"];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(enrollmentRuntimeEnabled(), false); assert.equal(enrollmentCreationEnabled(), false); assert.equal(onboardingEmailEnabled(), false);
    Object.assign(process.env, { MCA_ONBOARDING_RUNTIME_ENABLED: "true", MCA_STRIPE_FIRST_ONBOARDING_ENABLED: "true", MCA_ONBOARDING_EMAIL_ENABLED: "true", MCA_SIGNUP_MODE: "open", MCA_STRIPE_BILLING_ENABLED: "true", MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "sk_test_synthetic", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats", STRIPE_BILLING_WEBHOOK_SECRET: "whsec_synthetic" });
    assert.equal(enrollmentCreationEnabled(), true); assert.equal(onboardingEmailEnabled(), true);
    process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "false";
    assert.equal(enrollmentCreationEnabled(), false); assert.equal(enrollmentRuntimeEnabled(), true); assert.equal(onboardingEmailEnabled(), true);
    process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED = "true"; process.env.MCA_SIGNUP_MODE = "invite_only";
    assert.equal(enrollmentCreationEnabled(), false); assert.equal(onboardingEmailEnabled(), true);
    process.env.MCA_SIGNUP_MODE = "open"; delete process.env.STRIPE_BASE_PRICE_ID;
    assert.equal(enrollmentCreationEnabled(), false);
  } finally { for (const key of keys) if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
});
