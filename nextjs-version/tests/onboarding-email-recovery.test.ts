import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { authDatabase, activatedEnrollment, browserCookies, liveIdentity, provider, resetAuthProvider } from "./helpers/onboarding-auth"
import { getDatabase, nowIso } from "../src/lib/mca/db"
import { encryptSensitive } from "../src/lib/mca/crypto"
import { linkSupabaseUser } from "../src/lib/mca/supabase-auth"
import { findEnrollment, verifyEnrollmentResume, readEnrollmentContact } from "../src/lib/mca/onboarding/store"
import { onboardingEmailConfiguration, onboardingEmailProviderIdentity } from "../src/lib/mca/onboarding/email-transport"
import { onboardingEmailEncryptionScope } from "../src/lib/mca/onboarding/email-intents"
import type { SuperAdminActor } from "../src/lib/mca/platform-auth"
import { resumeSecret, stripeFixture } from "./helpers/onboarding-billing"

let close: () => Promise<void>
before(async () => { close = await authDatabase("email_recovery") })
after(async () => { await close?.() })
beforeEach(() => {
  resetAuthProvider()
  Object.assign(process.env, { MCA_USESEND_API_KEY: "synthetic-key", MCA_USESEND_FROM: "Fundlane <service@example.test>", MCA_SYSTEM_EMAIL_REPLY_TO: "Replies <reply@example.test>" })
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_SYSTEM_EMAIL_PROVIDER
  process.env.MCA_ONBOARDING_RUNTIME_ENABLED = "true"
})
function request(body?: object, origin: string | null = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/platform/onboarding/test", { method: body ? "POST" : "GET", headers: { ...(origin ? { origin } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function operator(): Promise<SuperAdminActor> {
  const identity = await liveIdentity(`operator-${randomUUID()}@example.test`)
  process.env.MCA_SUPER_ADMIN_EMAILS = identity.email
  const userId = await linkSupabaseUser(identity)
  await getDatabase().execute("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,'synthetic','Synthetic operator')", [userId, nowIso()])
  await getDatabase().execute("INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)", [identity.sessionId, userId, nowIso()])
  return { userId, supabaseUserId: identity.user.id, sessionId: identity.sessionId, email: identity.email }
}
function asOperator(actor: SuperAdminActor) {
  provider.current = { user: provider.users.get(actor.supabaseUserId)!, email: actor.email, sessionId: actor.sessionId }
}
async function mails(id: string) {
  return (await getDatabase().query<{ id: string; state: string; generation: number; purpose: string; provider: string; provider_account_id: string; provider_message_id: string | null; claim_token: string | null; attempts: number; recipient_cipher: string; content_cipher: string; provider_config_cipher: string }>("SELECT * FROM mca_onboarding_service_emails WHERE enrollment_id=? ORDER BY generation,purpose", [id])).rows
}
async function freeze(id: string, state = "uncertain", messageId: string | null = null) {
  const mail = (await mails(id)).at(-1)!, configuration = onboardingEmailConfiguration(), scope = onboardingEmailEncryptionScope(id, mail.generation)
  const row = (await findEnrollment(id))!
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET state=?,attempts=1,recipient_cipher=?,content_cipher=?,provider_config_cipher=?,provider=?,provider_account_id=?,provider_message_id=?,frozen_at=? WHERE id=?", [state, encryptSensitive("synthetic@example.test", scope), encryptSensitive(JSON.stringify({ subject: "Synthetic service", text: "Synthetic text", html: "<p>Synthetic text</p>" }), scope), encryptSensitive(JSON.stringify(configuration), scope), configuration.provider, onboardingEmailProviderIdentity(configuration), messageId, nowIso(), mail.id])
  return { ...mail, provider: configuration.provider, provider_account_id: onboardingEmailProviderIdentity(configuration), revision: row.revision }
}
async function command(id: string, body: object, origin: string | null = "http://localhost:3000") {
  const { POST } = await import("../src/app/api/platform/onboarding/[id]/route")
  return POST(request(body, origin), { params: Promise.resolve({ id }) })
}
function evidence(mail: Awaited<ReturnType<typeof freeze>>, extra: object = {}) {
  return { action: "record_email_evidence", emailId: mail.id, provider: mail.provider, providerConfigurationId: mail.provider_account_id, outcome: "accepted" as const, providerMessageId: `provider-${mail.id}`, evidence: `support:event-${randomUUID()}`, expectedRevision: mail.revision, reason: "Reviewed controlled provider receipt evidence", ...extra }
}
async function expiredEnrollment() {
  const f = stripeFixture(), secret = resumeSecret()
  const { startEnrollmentCheckout } = await import("../src/lib/mca/onboarding/checkout"), { reconcileEnrollment } = await import("../src/lib/mca/onboarding/reconcile")
  const started = await startEnrollmentCheckout({ resumeSecret: secret }, f.client), end = Math.floor(Date.now() / 1000) - 1
  Object.assign(f.state.subscription, { trial_start: end - 1209600, trial_end: end })
  Object.assign(f.state.subscription.items.data[0], { current_period_start: end - 1209600, current_period_end: end })
  const complete = f.complete(), row = await reconcileEnrollment(started.enrollmentId, f.client), identity = await liveIdentity(complete.customer_details!.email!)
  return { ...f, row, identity, secret, id: row.id }
}
async function corrected(expiredTrial = false) {
  const f = await (expiredTrial ? expiredEnrollment() : activatedEnrollment()), actor = await operator(), email = `corrected-${randomUUID()}@example.test`
  const recovery = await import("../src/lib/mca/onboarding/recovery"), auth = await import("../src/lib/mca/onboarding/auth")
  const common = { enrollmentId: f.id, reason: "Reviewed independently controlled purchase evidence", purchaseEvidence: "support:purchase-12345" }
  await recovery.authorizeEnrollmentContactVerification(actor, { ...common, correctedEmail: email, expectedRevision: (await findEnrollment(f.id))!.revision }, request({}), f.client)
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email })
  const target = await liveIdentity(email), challengeId = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await auth.verifyEnrollmentAuthentication({ challengeId, email, token: "123456" })
  asOperator(actor)
  await getDatabase().execute("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?", [nowIso(), actor.sessionId])
  await recovery.recoverEnrollmentContact(actor, { ...common, verifiedProviderUserId: target.user.id, expectedRevision: (await findEnrollment(f.id))!.revision }, request({}), f.client)
  return { ...f, actor, target, challengeId, common, approved: (await findEnrollment(f.id))! }
}
async function freshStepUp(actor: SuperAdminActor) {
  asOperator(actor)
  await getDatabase().execute("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?", [nowIso(), actor.sessionId])
}
function reissue(f: Awaited<ReturnType<typeof corrected>>, extra: object = {}) {
  return { action: "reissue_emails", purchaseEvidence: f.common.purchaseEvidence, reason: "Reviewed separately authorized generation repair", expectedRevision: f.approved.revision, ...extra }
}
async function auditFailure(action: string, callback: () => Promise<void>) {
  await getDatabase().execute(`CREATE FUNCTION test_email_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${action}' THEN RAISE EXCEPTION 'synthetic email audit failure'; END IF; RETURN NEW; END $$`)
  await getDatabase().execute("CREATE TRIGGER test_email_audit_fail BEFORE INSERT ON platform_admin_audit FOR EACH ROW EXECUTE FUNCTION test_email_audit_fail()")
  try { await callback() } finally {
    await getDatabase().execute("DROP TRIGGER test_email_audit_fail ON platform_admin_audit")
    await getDatabase().execute("DROP FUNCTION test_email_audit_fail()")
  }
}
async function receiptCount(emailId: string) {
  return (await getDatabase().queryOne<{ count: number }>("SELECT count(*)::int count FROM mca_onboarding_service_email_receipts WHERE email_id=?", [emailId]))!.count
}
async function restoredAcceptance(id: string) {
  const mail = await freeze(id, "failed"), messageId = `restored-message-${mail.id}`, receiptId = randomUUID()
  await getDatabase().execute("INSERT INTO mca_onboarding_service_email_receipts(id,enrollment_id,email_id,provider,provider_account_id,event_key,state,provider_message_id,evidence_type,occurred_at,observed_at) VALUES(?,?,?,?,?,?,'accepted',?,'operator_review',?,?)", [receiptId, id, mail.id, mail.provider, mail.provider_account_id, `restored-proof-${receiptId}`, messageId, nowIso(), nowIso()])
  return { mail, messageId, receiptId }
}

test("protected read exposes sanitized email age, receipt distinction and configuration identity without mutating", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id)
  const { GET } = await import("../src/app/api/platform/onboarding/[id]/route")
  const response = await GET(request(), { params: Promise.resolve({ id: f.id }) }), body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "private, no-store")
  assert.equal(body.emails.length, 2)
  const detail = body.emails.find((item: { id: string }) => item.id === mail.id)
  assert.equal(detail.state, "uncertain")
  assert.equal(detail.providerConfigurationId, mail.provider_account_id)
  assert.equal(detail.providerIdentityVerified, false)
  assert.equal(detail.canRecordEvidence, true)
  assert.ok(Number.isFinite(detail.ageSeconds) && detail.ageSeconds >= 0)
  assert.deepEqual(detail.receipts, [])
  assert.equal(body.availableActions.includes("record_email_evidence"), true)
  assert.doesNotMatch(JSON.stringify(body), /synthetic@example|synthetic-key|cipher|resumeSecret|token_hash/)
  assert.equal((await mails(f.id)).at(-1)!.state, "uncertain")
  assert.equal((await findEnrollment(f.id))!.revision, mail.revision)
  asOperator(actor)
})

test("real operator can inspect SQL diagnostics with runtime and encryption unavailable while every mutation remains disabled", async () => {
  const f = await corrected(), mail = await freeze(f.id)
  process.env.MCA_ONBOARDING_RUNTIME_ENABLED = "false"
  const key = process.env.MCA_DATA_ENCRYPTION_KEY
  delete process.env.MCA_DATA_ENCRYPTION_KEY
  try {
    const { GET } = await import("../src/app/api/platform/onboarding/[id]/route")
    const response = await GET(request(), { params: Promise.resolve({ id: f.id }) }), body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.deepEqual(body.runtime, { runtimeEnabled: false, creationEnabled: false, emailDispatchEnabled: false })
    assert.equal(body.emails.length, 4)
    assert.deepEqual(body.availableActions, [])
    assert.ok(body.emails.every((item: { canRecordEvidence: boolean }) => !item.canRecordEvidence))
    assert.equal((await command(f.id, evidence(mail))).status, 503)
    assert.equal((await findEnrollment(f.id))!.revision, mail.revision)
    provider.current = null
    assert.equal((await GET(request(), { params: Promise.resolve({ id: f.id }) })).status, 401)
  } finally { process.env.MCA_DATA_ENCRYPTION_KEY = key }
})

test("operator evidence resolves unknown acceptance atomically and records accepted separately from delivered", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id), input = evidence(mail)
  const response = await command(f.id, input)
  assert.equal(response.status, 200, await response.text())
  let row = (await mails(f.id)).at(-1)!
  assert.equal(row.state, "accepted")
  assert.equal(row.provider_message_id, input.providerMessageId)
  assert.equal(row.attempts, 1)
  assert.equal((await findEnrollment(f.id))!.revision, mail.revision + 1)
  const receipts = (await getDatabase().query<{ state: string; evidence_type: string; event_key: string }>("SELECT state,evidence_type,event_key FROM mca_onboarding_service_email_receipts WHERE email_id=?", [mail.id])).rows
  assert.deepEqual(receipts.map(item => [item.state, item.evidence_type]), [["accepted", "operator_review"]])
  assert.ok(!receipts[0].event_key.includes(input.evidence))
  const audit = await getDatabase().queryOne<{ after_json: object }>("SELECT after_json FROM platform_admin_audit WHERE action='enrollment.email_evidence_recorded' AND target_id=?", [f.id])
  assert.ok(audit)
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(input.evidence))
  const delivered = await command(f.id, { ...input, outcome: "delivered", evidence: `support:delivery-${randomUUID()}`, expectedRevision: mail.revision + 1 })
  assert.equal(delivered.status, 200, await delivered.text())
  row = (await mails(f.id)).at(-1)!
  assert.equal(row.state, "delivered")
  asOperator(actor)
})

test("explicit reissue requires independently approved contact and a new step-up; correction already created exactly two", async () => {
  const f = await corrected(), before = (await findEnrollment(f.id))!
  assert.equal((await mails(f.id)).filter(mail => mail.generation === 2).length, 2)
  const body = { action: "reissue_emails", ...f.common, expectedRevision: before.revision }
  delete (body as { enrollmentId?: string }).enrollmentId
  const stale = await command(f.id, body)
  assert.equal(stale.status, 403)
  assert.equal((await stale.json()).error.code, "step_up_required")
  await getDatabase().execute("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?", [nowIso(), f.actor.sessionId])
  const response = await command(f.id, body)
  assert.equal(response.status, 200, await response.text())
  const after = (await findEnrollment(f.id))!
  assert.equal(after.emailGeneration, 3)
  assert.equal(after.resumeGeneration, 3)
  assert.notEqual(after.resumeSecretHash, before.resumeSecretHash)
  assert.equal(after.providerSnapshotCipher, before.providerSnapshotCipher)
  assert.equal(after.trialEndsAt, before.trialEndsAt)
  assert.equal(after.claimedProviderUserId, before.claimedProviderUserId)
  assert.equal(after.workspaceId, null)
  assert.equal((await mails(f.id)).filter(mail => mail.generation === 3 && mail.state === "queued").length, 2)
  assert.ok((await mails(f.id)).filter(mail => mail.generation === 2).every(mail => mail.state === "suppressed"))
})

test("evidence rejects anonymous and tenant sessions, caller-constructed actors, API keys and untrusted origins", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id), input = evidence(mail)
  provider.current = null
  assert.equal((await command(f.id, input)).status, 401)
  await liveIdentity(`tenant-${randomUUID()}@example.test`)
  assert.equal((await command(f.id, input)).status, 403)
  asOperator(actor)
  for (const origin of [null, "https://foreign.test"]) assert.equal((await command(f.id, input, origin)).status, 403)
  const { POST } = await import("../src/app/api/platform/onboarding/[id]/route")
  const bearer = request(input); bearer.headers.set("authorization", "Bearer mca_synthetic")
  assert.equal((await POST(bearer, { params: Promise.resolve({ id: f.id }) })).status, 403)
  const { recordOnboardingEmailEvidence } = await import("../src/lib/mca/onboarding/email-recovery")
  const { action: _action, ...fields } = input
  void _action
  await assert.rejects(recordOnboardingEmailEvidence({ ...actor, sessionId: randomUUID() }, { enrollmentId: f.id, ...fields }, request({})), { code: "super_admin_required" })
  assert.equal(await receiptCount(mail.id), 0)
})

for (const mode of ["stale", "future", "foreign", "revoked"] as const) test(`${mode} operator session or step-up cannot apply evidence`, async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id)
  if (mode === "stale" || mode === "future") await getDatabase().execute("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?", [new Date(Date.now() + (mode === "future" ? 3600000 : -3600000)).toISOString(), actor.sessionId])
  if (mode === "foreign") {
    const session = randomUUID()
    await getDatabase().execute("INSERT INTO auth.sessions(id,user_id,not_after) VALUES (?,?,now()+interval '1 hour')", [session, actor.supabaseUserId])
    provider.current = { ...provider.current!, sessionId: session }
  }
  if (mode === "revoked") await getDatabase().execute("INSERT INTO auth_session_revocations(id,revoked_at) VALUES (?,?)", [actor.sessionId, nowIso()])
  const response = await command(f.id, evidence(mail))
  assert.ok([401, 403].includes(response.status))
  assert.equal(await receiptCount(mail.id), 0)
  assert.equal((await mails(f.id)).at(-1)!.state, "uncertain")
})

test("strict evidence JSON, bounded references, mandatory revision and provider ownership fail without writes", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id), input = evidence(mail)
  for (const fields of [{ rawProvider: { private: "sensitive" } }, { evidence: "raw contact@example.test" }, { expectedRevision: 0 }, { providerMessageId: "id\r\nprivate" }]) {
    assert.equal((await command(f.id, { ...input, ...fields })).status, 400)
  }
  const { expectedRevision: _revision, ...missing } = input
  void _revision
  assert.equal((await command(f.id, missing)).status, 400)
  assert.equal((await command(f.id, { ...input, provider: "resend" })).status, 409)
  assert.equal((await command(f.id, { ...input, providerConfigurationId: "foreign-config" })).status, 409)
  assert.equal((await command(f.id, { ...input, expectedRevision: mail.revision + 1 })).status, 409)
  const foreign = await activatedEnrollment(); asOperator(actor)
  assert.equal((await command(foreign.id, input)).status, 409)
  assert.equal(await receiptCount(mail.id), 0)
})

test("duplicate operator proof is idempotent; the same proof or message cannot alias another email", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id), input = evidence(mail)
  assert.equal((await command(f.id, input)).status, 200)
  assert.equal((await command(f.id, input)).status, 200)
  assert.equal(await receiptCount(mail.id), 1)
  assert.equal((await findEnrollment(f.id))!.revision, mail.revision + 1)
  assert.equal((await command(f.id, { ...input, outcome: "delivered" })).status, 409)
  const other = await activatedEnrollment(), second = await freeze(other.id); asOperator(actor)
  assert.equal((await command(other.id, { ...evidence(second), evidence: input.evidence })).status, 409)
  assert.equal((await command(other.id, { ...evidence(second), providerMessageId: input.providerMessageId })).status, 409)
  assert.equal(await receiptCount(second.id), 0)
})

test("restored own receipt rejects replacement message despite missing projection", async () => {
  const f = await activatedEnrollment(), restored = await restoredAcceptance(f.id)
  await operator()
  const response = await command(f.id, evidence(restored.mail, { providerMessageId: "replacement-message-M2" }))
  assert.equal(response.status, 409, await response.text())
  const row = (await mails(f.id)).at(-1)!
  assert.equal(row.state, "failed")
  assert.equal(row.provider_message_id, null)
  assert.equal(await receiptCount(row.id), 1)
  assert.equal((await findEnrollment(f.id))!.revision, restored.mail.revision)
})

for (const supplied of [true, false]) test(`restored own receipt resolves original message ${supplied ? "with explicit ID" : "by inference"} without replacing history`, async () => {
  const f = await activatedEnrollment(), restored = await restoredAcceptance(f.id)
  await operator()
  const input = evidence(restored.mail, { outcome: "delivered", providerMessageId: supplied ? restored.messageId : undefined })
  const response = await command(f.id, input)
  assert.equal(response.status, 200, await response.text())
  const row = (await mails(f.id)).at(-1)!
  assert.equal(row.state, "delivered")
  assert.equal(row.provider_message_id, restored.messageId)
  assert.equal(row.attempts, 1)
  assert.equal(await receiptCount(row.id), 2)
  assert.equal((await getDatabase().queryOne<{ provider_message_id: string }>("SELECT provider_message_id FROM mca_onboarding_service_email_receipts WHERE id=?", [restored.receiptId]))!.provider_message_id, restored.messageId)
  assert.equal((await command(f.id, input)).status, 200)
  assert.equal(await receiptCount(row.id), 2)
  assert.equal((await findEnrollment(f.id))!.revision, restored.mail.revision + 1)
})

test("restored receipt ownership rejects cross-email alias when owner projection is missing", async () => {
  const owner = await activatedEnrollment(), restored = await restoredAcceptance(owner.id)
  const foreign = await activatedEnrollment(), mail = await freeze(foreign.id, "failed")
  await operator()
  const response = await command(foreign.id, evidence(mail, { providerMessageId: restored.messageId }))
  assert.equal(response.status, 409, await response.text())
  assert.equal((await mails(foreign.id)).at(-1)!.provider_message_id, null)
  assert.equal((await mails(foreign.id)).at(-1)!.state, "failed")
  assert.equal(await receiptCount(mail.id), 0)
  assert.equal(await receiptCount(restored.mail.id), 1)
})

test("parallel original resolution and foreign claim preserve restored receipt ownership", async () => {
  const owner = await activatedEnrollment(), restored = await restoredAcceptance(owner.id)
  const foreign = await activatedEnrollment(), mail = await freeze(foreign.id, "failed")
  await operator()
  const results = await Promise.all([
    command(foreign.id, evidence(mail, { providerMessageId: restored.messageId })),
    command(owner.id, evidence(restored.mail, { providerMessageId: restored.messageId })),
  ])
  assert.deepEqual(results.map(result => result.status), [409, 200])
  assert.equal((await mails(owner.id)).at(-1)!.provider_message_id, restored.messageId)
  assert.equal((await mails(foreign.id)).at(-1)!.provider_message_id, null)
  assert.equal(await receiptCount(mail.id), 0)
  assert.equal(await receiptCount(restored.mail.id), 2)
})

test("known message binding and delivered history cannot be replaced, downgraded or reopened for retry", async () => {
  const f = await activatedEnrollment(), mail = await freeze(f.id, "accepted", "known-provider-id")
  await operator()
  assert.equal((await command(f.id, evidence(mail))).status, 409)
  const accepted = evidence(mail, { providerMessageId: "known-provider-id" })
  assert.equal((await command(f.id, { ...accepted, outcome: "delivered" })).status, 200)
  const revision = (await findEnrollment(f.id))!.revision
  assert.equal((await command(f.id, { ...accepted, expectedRevision: revision, evidence: `support:late-accepted-${randomUUID()}` })).status, 200)
  assert.equal((await mails(f.id)).at(-1)!.state, "delivered")
  for (const outcome of ["failed", "suppressed"]) assert.equal((await command(f.id, { ...accepted, outcome, expectedRevision: (await findEnrollment(f.id))!.revision, evidence: `support:negative-${randomUUID()}` })).status, 409)
  assert.equal((await mails(f.id)).at(-1)!.attempts, 1)
  assert.equal(await receiptCount(mail.id), 2)
})

test("live dispatch denies evidence; expired marker resolves under its exact token and cannot accept late completion", async () => {
  const f = await activatedEnrollment(), mail = await freeze(f.id, "sending"), token = randomUUID()
  await operator()
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET claim_token=?,lease_until=? WHERE id=?", [token, new Date(Date.now() + 120000).toISOString(), mail.id])
  const input = evidence(mail)
  assert.equal((await command(f.id, input)).status, 409)
  assert.equal(await receiptCount(mail.id), 0)
  await getDatabase().execute("UPDATE mca_onboarding_service_emails SET lease_until=? WHERE id=?", [new Date(Date.now() - 1000).toISOString(), mail.id])
  assert.equal((await command(f.id, input)).status, 200)
  const { recordOnboardingEmailDispatchOutcome } = await import("../src/lib/mca/onboarding/email-worker")
  assert.equal(await recordOnboardingEmailDispatchOutcome(mail.id, token, { state: "accepted", providerMessageId: "late-unknown" }), false)
  assert.equal((await mails(f.id)).at(-1)!.provider_message_id, input.providerMessageId)
  assert.equal(await receiptCount(mail.id), 1)
})

for (const outcome of ["failed", "suppressed"] as const) test(`${outcome} operator review never creates retry or fabricated acceptance and rolls back with failed audit`, async () => {
  const f = await activatedEnrollment(), mail = await freeze(f.id)
  await operator()
  const { providerMessageId: _message, ...input } = evidence(mail, { outcome })
  void _message
  await auditFailure("enrollment.email_evidence_recorded", async () => { assert.equal((await command(f.id, input)).status, 500) })
  assert.equal((await mails(f.id)).at(-1)!.state, "uncertain")
  assert.equal(await receiptCount(mail.id), 0)
  assert.equal((await findEnrollment(f.id))!.revision, mail.revision)
  assert.equal((await command(f.id, input)).status, 200)
  assert.equal((await mails(f.id)).at(-1)!.state, outcome)
  assert.equal((await mails(f.id)).at(-1)!.provider_message_id, null)
  assert.equal(await receiptCount(mail.id), 1)
  if (outcome === "suppressed") assert.ok(await getDatabase().queryOne("SELECT recipient_hash FROM mca_service_email_suppressions WHERE active=true AND evidence_receipt_id IS NOT NULL"))
})

test("operator grant revoked after lookup cannot create receipt or audit writes", async () => {
  const f = await activatedEnrollment(), actor = await operator(), mail = await freeze(f.id)
  let lookups = 0
  provider.onGetUser = async () => { if (++lookups === 4) await getDatabase().execute("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?", [nowIso(), actor.userId]) }
  try { assert.equal((await command(f.id, evidence(mail))).status, 403) } finally { provider.onGetUser = undefined }
  assert.equal(await receiptCount(mail.id), 0)
  assert.equal((await mails(f.id)).at(-1)!.state, "uncertain")
})

test("reissue rollback preserves capabilities and audit; successful reissue rejects old challenges, resume and generation", async () => {
  const f = await corrected(), auth = await import("../src/lib/mca/onboarding/auth"), claim = await import("../src/lib/mca/onboarding/claim")
  provider.current = f.target
  await auth.requestEnrollmentAuthentication({ enrollmentId: f.id, email: f.target.email, generation: 2 })
  const pending = browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0]
  await freshStepUp(f.actor)
  const before = (await findEnrollment(f.id))!
  await auditFailure("enrollment.email_generation_reissued", async () => { assert.equal((await command(f.id, reissue(f))).status, 500) })
  const rolled = (await findEnrollment(f.id))!
  assert.equal(rolled.emailGeneration, 2); assert.equal(rolled.resumeSecretHash, before.resumeSecretHash)
  assert.equal((await mails(f.id)).length, 4)
  assert.equal((await command(f.id, reissue(f))).status, 200)
  const after = (await findEnrollment(f.id))!
  assert.equal(verifyEnrollmentResume(after, f.secret), false)
  assert.equal(readEnrollmentContact(after).email, f.target.email)
  provider.current = f.target
  await assert.rejects(auth.verifyEnrollmentAuthentication({ challengeId: pending, email: f.target.email, token: "123456" }), { code: "enrollment_challenge_invalid" })
  await assert.rejects(claim.readEnrollmentStatus({ enrollmentId: f.id, identity: f.target, generation: 2 }, f.client), { code: "enrollment_link_superseded" })
  asOperator(f.actor)
  assert.equal((await command(f.id, reissue(f))).status, 409)
  assert.equal((await mails(f.id)).filter(mail => mail.generation === 3).length, 2)
})

for (const mode of ["uncertain", "sending", "accepted", "delivered"] as const) test(`${mode} current mail blocks generation reissue without erasing original history`, async () => {
  const f = await corrected(), mail = await freeze(f.id, mode, ["accepted", "delivered"].includes(mode) ? `known-${randomUUID()}` : null)
  if (mode === "sending") await getDatabase().execute("UPDATE mca_onboarding_service_emails SET claim_token=?,lease_until=? WHERE id=?", [randomUUID(), new Date(Date.now() - 1000).toISOString(), mail.id])
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f))).status, 409)
  assert.equal((await findEnrollment(f.id))!.emailGeneration, 2)
  assert.equal((await mails(f.id)).at(-1)!.state, mode)
})

test("current-generation positive receipt history blocks reissue even if a restored row lost its message projection", async () => {
  const f = await corrected(), mail = await freeze(f.id, "failed")
  await getDatabase().execute("INSERT INTO mca_onboarding_service_email_receipts(id,enrollment_id,email_id,provider,provider_account_id,event_key,state,provider_message_id,evidence_type,occurred_at,observed_at) VALUES(?,?,?,?,?,?,'accepted',?,'operator_review',?,?)", [randomUUID(), f.id, mail.id, mail.provider, mail.provider_account_id, `old-${randomUUID()}`, "known-restored-acceptance", nowIso(), nowIso()])
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f))).status, 409)
  assert.equal((await findEnrollment(f.id))!.emailGeneration, 2)
})

test("resolved old uncertainty allows a distinct reissue without replaying the frozen intent", async () => {
  const f = await corrected(), mail = await freeze(f.id), old = (await mails(f.id)).at(-1)!
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f))).status, 409)
  const { providerMessageId: _message, ...negative } = evidence(mail, { outcome: "failed" })
  void _message
  assert.equal((await command(f.id, negative)).status, 200)
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f, { expectedRevision: (await findEnrollment(f.id))!.revision }))).status, 200)
  const frozen = (await mails(f.id)).find(item => item.id === mail.id)!
  assert.equal(frozen.state, "suppressed")
  assert.equal(frozen.attempts, 1)
  assert.equal(frozen.provider_config_cipher, old.provider_config_cipher)
  assert.equal(frozen.content_cipher, old.content_cipher)
  assert.equal((await mails(f.id)).filter(item => item.generation === 3).length, 2)
})

test("manual generation preserves accepted historical messages to the former contact exactly", async () => {
  const original = await activatedEnrollment()
  const old = await freeze(original.id, "accepted", `former-contact-${randomUUID()}`)
  const originalMail = (await mails(original.id)).find(mail => mail.id === old.id)!
  // Exercise the same independently reviewed correction against this purchased enrollment.
  const actor = await operator(), email = `new-${randomUUID()}@example.test`, recovery = await import("../src/lib/mca/onboarding/recovery"), auth = await import("../src/lib/mca/onboarding/auth")
  const common = { enrollmentId: original.id, reason: "Reviewed independently controlled purchase evidence", purchaseEvidence: "support:purchase-12345" }
  await recovery.authorizeEnrollmentContactVerification(actor, { ...common, correctedEmail: email, expectedRevision: original.row.revision }, request({}), original.client)
  await auth.requestEnrollmentAuthentication({ enrollmentId: original.id, email })
  const target = await liveIdentity(email)
  await auth.verifyEnrollmentAuthentication({ challengeId: browserCookies.get(auth.enrollmentAuthCookie)!.split(".")[0], email, token: "123456" })
  await freshStepUp(actor)
  await recovery.recoverEnrollmentContact(actor, { ...common, verifiedProviderUserId: target.user.id, expectedRevision: (await findEnrollment(original.id))!.revision }, request({}), original.client)
  await freshStepUp(actor)
  const response = await command(original.id, { action: "reissue_emails", purchaseEvidence: common.purchaseEvidence, reason: common.reason, expectedRevision: (await findEnrollment(original.id))!.revision })
  assert.equal(response.status, 200, await response.text())
  assert.deepEqual((await mails(original.id)).find(mail => mail.id === old.id), originalMail)
})

for (const mode of ["canceled", "paused", "unpaid", "incomplete_expired", "operator_required", "target_revoked", "foreign_company", "wrong_purchase"] as const) test(`${mode} recovery or lifecycle blocks reissue and preserves existing tenants`, async () => {
  const f = await corrected()
  if (["canceled", "paused", "unpaid", "incomplete_expired"].includes(mode)) {
    f.state.subscription.status = mode as "trialing"
    const { reconcileEnrollment } = await import("../src/lib/mca/onboarding/reconcile")
    await reconcileEnrollment(f.id, f.client)
  }
  if (mode === "operator_required") await getDatabase().execute("UPDATE mca_enrollments SET recovery_state='operator_required',revision=revision+1 WHERE id=?", [f.id])
  if (mode === "target_revoked") await getDatabase().execute("INSERT INTO auth_session_revocations(id,revoked_at) VALUES (?,?)", [f.target.sessionId, nowIso()])
  if (mode === "foreign_company") {
    provider.current = f.target
    const user = await linkSupabaseUser(f.target), workspace = randomUUID(), clock = nowIso()
    await getDatabase().execute("INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,'Existing company','UTC',1,'{}','{}','{}',?,?)", [workspace, clock, clock])
    await getDatabase().execute("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)", [randomUUID(), workspace, user, clock, clock])
  }
  const tenantBefore = (await getDatabase().query<{ id: string; name: string }>("SELECT id,name FROM workspaces ORDER BY id")).rows
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f, { expectedRevision: (await findEnrollment(f.id))!.revision, ...(mode === "wrong_purchase" ? { purchaseEvidence: "support:foreign-proof" } : {}) }))).status, 409)
  assert.equal((await findEnrollment(f.id))!.emailGeneration, 2)
  assert.deepEqual((await getDatabase().query<{ id: string; name: string }>("SELECT id,name FROM workspaces ORDER BY id")).rows, tenantBefore)
})

test("original trial boundary caps stale projection during manual reissue", async () => {
  const f = await corrected(true)
  await freshStepUp(f.actor)
  assert.equal((await command(f.id, reissue(f))).status, 409)
  const { GET } = await import("../src/app/api/platform/onboarding/[id]/route")
  const response = await GET(request(), { params: Promise.resolve({ id: f.id }) })
  assert.equal((await response.json()).availableActions.includes("reissue_emails"), false)
})
