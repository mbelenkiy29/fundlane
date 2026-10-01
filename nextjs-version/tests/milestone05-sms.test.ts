import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { TwilioSmsTransport } from "../src/lib/mca/sms/twilio"
import { createTwilioSmsTransport, validateTwilioFormSignature } from "../src/lib/mca/sms/twilio"
import { createSmsAccount, deliverClosingSms, getSmsConsent, processTwilioOptOut, processTwilioStatus, recordSmsConsent, resolveSmsRoute, updateSmsAccount } from "../src/lib/mca/sms/service"
import { POST as createAccountRoute } from "../src/app/api/mca/sms/accounts/route"
import { POST as inboundRoute } from "../src/app/api/mca/sms/webhooks/twilio/[accountId]/inbound/route"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const priorEnv = {
  provider: process.env.MCA_SMS_PROVIDER,
  accounts: process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON,
  baseUrl: process.env.MCA_SMS_PUBLIC_BASE_URL,
  encryption: process.env.MCA_DATA_ENCRYPTION_KEY,
}
const now = "2026-09-08T12:00:00.000Z"
const phone = "+12125550123", sender = "+12125550999"
const twilio = {
  accountSid: `AC${"a".repeat(32)}`,
  apiKeySid: `SK${"b".repeat(32)}`,
  apiKeySecret: "synthetic-api-secret",
  authToken: "synthetic-auth-token",
  messageSid: `SM${"c".repeat(32)}`,
}
const ids = {
  workspaceA: "ws-sms-a", workspaceB: "ws-sms-b",
  adminUserA: "user-sms-admin-a", adminA: "member-sms-admin-a",
  repUserA: "user-sms-rep-a", repA: "member-sms-rep-a",
  otherUserA: "user-sms-other-a", otherA: "member-sms-other-a",
  adminUserB: "user-sms-admin-b", adminB: "member-sms-admin-b",
  dealA: "deal-sms-a", dealB: "deal-sms-b",
}
const adminA: DealActor = { workspaceId: ids.workspaceA, userId: ids.adminUserA, membershipId: ids.adminA, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.adminA, ids.repA, ids.otherA], source: "user", correlationId: "sms-admin-a" }
const repA: DealActor = { workspaceId: ids.workspaceA, userId: ids.repUserA, membershipId: ids.repA, role: "rep", managedMembershipIds: [], activeMembershipIds: [ids.adminA, ids.repA, ids.otherA], source: "user", correlationId: "sms-rep-a" }
const otherA: DealActor = { ...repA, userId: ids.otherUserA, membershipId: ids.otherA, correlationId: "sms-other-a" }
const adminB: DealActor = { workspaceId: ids.workspaceB, userId: ids.adminUserB, membershipId: ids.adminB, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.adminB], source: "user", correlationId: "sms-admin-b" }

function sign(url: string, params: URLSearchParams, token: string): string {
  const grouped = new Map<string, string[]>()
  params.forEach((value, key) => grouped.set(key, [...(grouped.get(key) ?? []), value]))
  const source = [...grouped.keys()].sort().reduce((current, key) => [...new Set(grouped.get(key) ?? [])].sort().reduce((value, item) => `${value}${key}${item}`, current), url)
  return createHmac("sha1", token).update(source).digest("base64")
}

function payloadHash(body: string): string { return createHash("sha256").update(body).digest("hex") }

async function seed() {
  const database = getDatabase()
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES
    (?,?,'America/New_York',10,?,?,?,?,?),(?,?,'America/New_York',10,?,?,?,?,?)`).run(ids.workspaceA, "SMS Workspace A", flags, pages, actions, now, now, ids.workspaceB, "SMS Workspace B", flags, pages, actions, now, now)
  await database.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'SMS-A1',?,?),(?,?,?,'SMS-A2',?,?),(?,?,?,'SMS-A3',?,?),(?,?,?,'SMS-B1',?,?)`).run(
    ids.adminUserA, "sms-admin-a@example.test", "SMS Admin A", now, now,
    ids.repUserA, "sms-rep-a@example.test", "SMS Rep A", now, now,
    ids.otherUserA, "sms-other-a@example.test", "SMS Other A", now, now,
    ids.adminUserB, "sms-admin-b@example.test", "SMS Admin B", now, now,
  )
  await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'admin','active',?,?)`).run(
    ids.adminA, ids.workspaceA, ids.adminUserA, now, now,
    ids.repA, ids.workspaceA, ids.repUserA, now, now,
    ids.otherA, ids.workspaceA, ids.otherUserA, now, now,
    ids.adminB, ids.workspaceB, ids.adminUserB, now, now,
  )
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-sms-other',?,?,?,'2027-09-08T00:00:00.000Z',?,?)`).run(ids.otherUserA, ids.otherA, hashOpaqueToken("sms-other-session"), now, now)
  await database.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,contact_phone_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES
    (?,?,?,'Synthetic SMS Merchant',?,'offer',1,'submission_ready','[]','{}',1,?,?),(?,?,?,'Other Workspace Merchant',?,'offer',1,'submission_ready','[]','{}',1,?,?)`).run(
    ids.dealA, ids.workspaceA, "MCA-SMS-A", encryptSensitive(phone, ids.workspaceA), now, now,
    ids.dealB, ids.workspaceB, "MCA-SMS-B", encryptSensitive(phone, ids.workspaceB), now, now,
  )
  await database.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id) VALUES
    ('sms-assignment-rep',?,?,?,'originator',1,?,?),('sms-assignment-other',?,?,?,'closer',1,?,?)`).run(ids.workspaceA, ids.dealA, ids.repA, now, ids.adminUserA, ids.workspaceA, ids.dealA, ids.otherA, now, ids.adminUserA)
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone05_sms")
  Object.assign(process.env, fixture.env())
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_SMS_PROVIDER = "twilio"
  process.env.MCA_SMS_PUBLIC_BASE_URL = "https://sms.example.test"
  process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [ids.workspaceA]: { DEFAULT: { ...twilio, allowedSenders: [sender] } } })
  await seed()
})

after(async () => {
  await closeDatabaseForTests()
  await fixture.close()
  for (const [key, value] of Object.entries(priorEnv)) {
    const name = key === "provider" ? "MCA_SMS_PROVIDER" : key === "accounts" ? "MCA_SMS_TWILIO_ACCOUNTS_JSON" : key === "baseUrl" ? "MCA_SMS_PUBLIC_BASE_URL" : "MCA_DATA_ENCRYPTION_KEY"
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test("Twilio adapter uses the documented request contract and reports accepted, sanitized failure, and unknown outcomes truthfully", async () => {
  let requestBody = ""
  const accepted = createTwilioSmsTransport({ fetchImpl: async (input, init) => {
    assert.equal(String(input), `https://api.twilio.com/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`)
    assert.equal(init?.method, "POST")
    assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Basic /)
    requestBody = String(init?.body)
    return new Response(JSON.stringify({ sid: twilio.messageSid, status: "queued" }), { status: 201 })
  } })
  const request = { accountSid: twilio.accountSid, apiKeySid: twilio.apiKeySid, apiKeySecret: twilio.apiKeySecret, senderKind: "phone_number" as const, senderIdentity: sender, recipient: phone, body: "Exact synthetic preview", statusCallbackUrl: "https://sms.example.test/callback", correlationId: "corr-1" }
  assert.deepEqual(await accepted.send(request), { state: "accepted", externalId: twilio.messageSid, providerStatus: "queued" })
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), { To: phone, Body: "Exact synthetic preview", StatusCallback: "https://sms.example.test/callback", From: sender })

  const failed = await createTwilioSmsTransport({ fetchImpl: async () => new Response(JSON.stringify({ code: 21614, message: `Bad ${phone}: Exact synthetic preview` }), { status: 400 }) }).send(request)
  assert.equal(failed.state, "failed")
  assert.equal(failed.errorCode, "twilio_21614")
  assert.equal(failed.errorMessage?.includes(phone), false)
  assert.equal(failed.errorMessage?.includes("Exact synthetic preview"), false)
  assert.equal((await createTwilioSmsTransport({ fetchImpl: async () => new Response("upstream down", { status: 503 }) }).send(request)).state, "unknown")
  assert.equal((await createTwilioSmsTransport({ fetchImpl: async () => { throw new TypeError("response lost") } }).send(request)).state, "unknown")
})

test("Twilio form signature matches the official fixture and sorts duplicate parameters exactly", () => {
  const official = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" })
  assert.equal(validateTwilioFormSignature({ authToken: "12345", signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=", url: "https://example.com/myapp.php?foo=1&bar=2", params: official }), true)
  const duplicate = new URLSearchParams(); duplicate.append("Tag", "zeta"); duplicate.append("a", "last"); duplicate.append("Tag", "alpha"); duplicate.append("Tag", "alpha")
  const url = "https://example.com/webhook", expected = createHmac("sha1", "token").update(`${url}TagalphaTagzetaalast`).digest("base64")
  assert.equal(validateTwilioFormSignature({ authToken: "token", signature: expected, url, params: duplicate }), true)
})

let accountAId = ""
test("assigned routing, consent, stable retries, and workspace-bound credentials fail closed", async () => {
  const accountA = await createSmsAccount(adminA, { label: "Merchant SMS", senderKind: "phone_number", senderIdentity: sender, credentialRef: "DEFAULT", memberIds: [ids.adminA, ids.repA], isDefault: true })
  accountAId = accountA.id
  assert.equal(accountA.providerConfigured, true)
  const configuredEnvironment = process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON!
  process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [ids.workspaceA]: { DEFAULT: { ...twilio, authToken: "", allowedSenders: [sender] } } })
  assert.equal((await resolveSmsRoute(repA, { dealId: ids.dealA })).providerConfigured, false)
  process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = configuredEnvironment
  const configuredBaseUrl = process.env.MCA_SMS_PUBLIC_BASE_URL!
  process.env.MCA_SMS_PUBLIC_BASE_URL = "https://user:secret@sms.example.test/path?unexpected=1"
  assert.equal((await resolveSmsRoute(repA, { dealId: ids.dealA })).providerConfigured, false)
  process.env.MCA_SMS_PUBLIC_BASE_URL = configuredBaseUrl
  assert.equal((await resolveSmsRoute(repA, { dealId: ids.dealA })).accountId, accountA.id)
  await assert.rejects(() => resolveSmsRoute(otherA, { dealId: ids.dealA, senderAccountId: accountA.id }), /unassigned SMS account/)
  await recordSmsConsent(adminA, { dealId: ids.dealA, recipient: phone, state: "opted_in", evidence: "Merchant signed synthetic SMS consent fixture", effectiveAt: now, idempotencyKey: "sms-consent-a" })

  let calls = 0
  const transport: TwilioSmsTransport = { send: async () => { calls += 1; return { state: "accepted", externalId: twilio.messageSid, providerStatus: "queued" } } }
  const input = { dealId: ids.dealA, recipient: phone, body: "Synthetic approved terms", idempotencyKey: "sms-message-a", correlationId: "corr-send-a", payloadHash: payloadHash("Synthetic approved terms"), deliveryMode: "never_attempted" as const }
  const first = await deliverClosingSms(repA, input, transport)
  const replay = await deliverClosingSms(repA, input, transport)
  const reconciled = await deliverClosingSms(repA, { ...input, deliveryMode: "reconcile_only" }, { send: async () => { throw new Error("reconciliation must not send") } })
  assert.equal(first.state, "accepted")
  assert.equal(first.messageId, replay.messageId)
  assert.equal(reconciled.messageId, first.messageId)
  assert.equal(first.externalId, twilio.messageSid)
  assert.equal(calls, 1)
  const absent = await deliverClosingSms(repA, { ...input, idempotencyKey: "sms-reconcile-absent", deliveryMode: "reconcile_only" }, { send: async () => { throw new Error("reconciliation must not send") } })
  assert.deepEqual({ state: absent.state, messageId: absent.messageId, errorCode: absent.errorCode }, { state: "unknown", messageId: undefined, errorCode: "provider_outcome_unknown" })

  const accountB = await createSmsAccount(adminB, { label: "Same guessed reference", senderKind: "phone_number", senderIdentity: sender, credentialRef: "DEFAULT", memberIds: [ids.adminB], isDefault: true })
  assert.equal(accountB.providerConfigured, false)
  await recordSmsConsent(adminB, { dealId: ids.dealB, recipient: phone, state: "opted_in", evidence: "Synthetic consent B", effectiveAt: now, idempotencyKey: "sms-consent-b" })
  let crossWorkspaceCalls = 0
  const crossWorkspace = await deliverClosingSms(adminB, { dealId: ids.dealB, recipient: phone, body: "Must not leave workspace B", idempotencyKey: "sms-message-b", correlationId: "corr-b", payloadHash: payloadHash("Must not leave workspace B"), deliveryMode: "never_attempted" }, { send: async () => { crossWorkspaceCalls += 1; return { state: "accepted", externalId: twilio.messageSid } } })
  assert.equal(crossWorkspace.state, "failed")
  assert.equal(crossWorkspace.errorCode, "twilio_unconfigured")
  assert.equal(crossWorkspaceCalls, 0)
})

test("reassignment and opt-out are rechecked before a message is reserved, and unknown retries never blind-send", async () => {
  await updateSmsAccount(adminA, accountAId, { memberIds: [ids.adminA] })
  await assert.rejects(() => deliverClosingSms(repA, { dealId: ids.dealA, recipient: phone, body: "Blocked after reassignment", senderAccountId: accountAId, idempotencyKey: "sms-after-reassign", correlationId: "corr-reassign", payloadHash: payloadHash("Blocked after reassignment"), deliveryMode: "never_attempted" }, { send: async () => { throw new Error("must not send") } }), /unassigned SMS account/)
  await updateSmsAccount(adminA, accountAId, { memberIds: [ids.adminA, ids.repA] })

  let unknownCalls = 0
  const unknownInput = { dealId: ids.dealA, recipient: phone, body: "Synthetic unknown result", idempotencyKey: "sms-unknown", correlationId: "corr-unknown", payloadHash: payloadHash("Synthetic unknown result"), deliveryMode: "never_attempted" as const }
  const unknownTransport: TwilioSmsTransport = { send: async () => { unknownCalls += 1; return { state: "unknown", errorCode: "provider_outcome_unknown" } } }
  const first = await deliverClosingSms(repA, unknownInput, unknownTransport)
  const replay = await deliverClosingSms(repA, unknownInput, unknownTransport)
  assert.equal(first.state, "unknown")
  assert.equal(replay.messageId, first.messageId)
  assert.equal(unknownCalls, 1)

  await recordSmsConsent(adminA, { dealId: ids.dealA, recipient: phone, state: "opted_out", evidence: "Merchant sent STOP in synthetic fixture", effectiveAt: "2026-09-08T13:00:00.000Z", idempotencyKey: "sms-optout-manual" })
  await assert.rejects(() => deliverClosingSms(repA, { ...unknownInput, body: "Blocked by opt-out", idempotencyKey: "sms-after-stop", payloadHash: payloadHash("Blocked by opt-out") }, unknownTransport), /opted out/)
})

test("signed callbacks verify Twilio identity, preserve monotonic delivered state, dedupe events, and reject unsupported states", async () => {
  await recordSmsConsent(adminA, { dealId: ids.dealA, recipient: phone, state: "opted_in", evidence: "Merchant sent START in synthetic fixture", effectiveAt: "2026-09-08T14:00:00.000Z", idempotencyKey: "sms-optin-again" })
  const secondSid = `SM${"d".repeat(32)}`
  await deliverClosingSms(adminA, { dealId: ids.dealA, recipient: phone, body: "Callback state fixture", senderAccountId: accountAId, idempotencyKey: "sms-callback", correlationId: "corr-callback", payloadHash: payloadHash("Callback state fixture"), deliveryMode: "never_attempted" }, { send: async () => ({ state: "accepted", externalId: secondSid, providerStatus: "queued" }) })
  const message = await fixture.query("SELECT id FROM mca_sms_messages WHERE provider_message_id=$1", [secondSid])
  const localMessageId = (message.rows as unknown as Array<{ id: string }>)[0].id
  const callbackUrl = `https://sms.example.test/api/mca/sms/webhooks/twilio/${accountAId}/status?messageId=${localMessageId}`
  const paramsFor = (status: string, accountSid = twilio.accountSid) => new URLSearchParams({ AccountSid: accountSid, MessageSid: secondSid, MessageStatus: status, To: phone, From: sender })
  const sent = paramsFor("sent")
  await processTwilioStatus(accountAId, sent, sign(callbackUrl, sent, twilio.authToken), callbackUrl)
  const delayedQueued = paramsFor("queued")
  await processTwilioStatus(accountAId, delayedQueued, sign(callbackUrl, delayedQueued, twilio.authToken), callbackUrl)
  const afterDelayed = await fixture.query("SELECT state,provider_status FROM mca_sms_messages WHERE provider_message_id=$1", [secondSid])
  assert.deepEqual((afterDelayed.rows as unknown as Array<{ state: string; provider_status: string }>)[0], { state: "sent", provider_status: "sent" })
  const delivered = paramsFor("delivered"), deliveredSignature = sign(callbackUrl, delivered, twilio.authToken)
  const first = await processTwilioStatus(accountAId, delivered, deliveredSignature, callbackUrl)
  const replay = await processTwilioStatus(accountAId, delivered, deliveredSignature, callbackUrl)
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true)
  await Promise.all([
    processTwilioStatus(accountAId, sent, sign(callbackUrl, sent, twilio.authToken), callbackUrl),
    processTwilioStatus(accountAId, delivered, deliveredSignature, callbackUrl),
  ])
  const row = await fixture.query("SELECT state,provider_status,delivered_at FROM mca_sms_messages WHERE provider_message_id=$1", [secondSid])
  const messageRow = (row.rows as unknown as Array<{ state: string; provider_status: string; delivered_at: string }>)[0]
  assert.deepEqual({ state: messageRow.state, providerStatus: messageRow.provider_status }, { state: "delivered", providerStatus: "delivered" })
  assert.match(messageRow.delivered_at, /^20/)
  const eventCount = await fixture.query("SELECT count(*)::int count FROM mca_sms_status_events WHERE provider_message_id=$1", [secondSid])
  assert.equal((eventCount.rows as unknown as Array<{ count: number }>)[0].count, 3)

  const unknown = paramsFor("read")
  await assert.rejects(() => processTwilioStatus(accountAId, unknown, sign(callbackUrl, unknown, twilio.authToken), callbackUrl), /not supported/)
  const wrongAccount = paramsFor("delivered", `AC${"e".repeat(32)}`)
  await assert.rejects(() => processTwilioStatus(accountAId, wrongAccount, sign(callbackUrl, wrongAccount, twilio.authToken), callbackUrl), /does not match/)
  const wrongMessage = new URLSearchParams({ AccountSid: twilio.accountSid, MessageSid: `SM${"2".repeat(32)}`, MessageStatus: "delivered", To: phone, From: sender })
  await assert.rejects(() => processTwilioStatus(accountAId, wrongMessage, sign(callbackUrl, wrongMessage, twilio.authToken), callbackUrl), /message identity does not match/)
  const wrongRecipient = new URLSearchParams({ AccountSid: twilio.accountSid, MessageSid: secondSid, MessageStatus: "delivered", To: "+12125550000", From: sender })
  await assert.rejects(() => processTwilioStatus(accountAId, wrongRecipient, sign(callbackUrl, wrongRecipient, twilio.authToken), callbackUrl), /recipient does not match/)
})

test("a signed callback can bind a pending local message before the create response returns", async () => {
  const earlySid = `SM${"1".repeat(32)}`
  const result = await deliverClosingSms(adminA, { dealId: ids.dealA, recipient: phone, body: "Early callback fixture", senderAccountId: accountAId, idempotencyKey: "sms-early-callback", correlationId: "corr-early", payloadHash: payloadHash("Early callback fixture"), deliveryMode: "never_attempted" }, { send: async (request) => {
    const params = new URLSearchParams({ AccountSid: twilio.accountSid, MessageSid: earlySid, MessageStatus: "delivered", To: phone, From: sender })
    await processTwilioStatus(accountAId, params, sign(request.statusCallbackUrl, params, twilio.authToken), request.statusCallbackUrl)
    return { state: "accepted", externalId: earlySid, providerStatus: "queued" }
  } })
  assert.equal(result.state, "accepted")
  assert.equal(result.externalId, earlySid)
  const stored = await fixture.query("SELECT state,provider_status FROM mca_sms_messages WHERE provider_message_id=$1", [earlySid])
  assert.deepEqual((stored.rows as unknown as Array<{ state: string; provider_status: string }>)[0], { state: "delivered", provider_status: "delivered" })
})

test("signed Advanced Opt-Out STOP appends consent and blocks subsequent sends", async () => {
  const inboundUrl = `https://sms.example.test/api/mca/sms/webhooks/twilio/${accountAId}/inbound`
  const params = new URLSearchParams({ AccountSid: twilio.accountSid, MessageSid: `SM${"f".repeat(32)}`, From: phone, To: sender, OptOutType: "STOP" })
  const result = await processTwilioOptOut(accountAId, params, sign(inboundUrl, params, twilio.authToken), inboundUrl)
  assert.equal(result.updated, 1)
  assert.equal((await getSmsConsent(adminA, ids.dealA, phone)).state, "opted_out")
  await assert.rejects(() => deliverClosingSms(adminA, { dealId: ids.dealA, recipient: phone, body: "Must be blocked", idempotencyKey: "sms-provider-stop", correlationId: "corr-provider-stop", payloadHash: payloadHash("Must be blocked"), deliveryMode: "never_attempted" }), /opted out/)
})

test("signed inbound route returns empty TwiML Response", async () => {
  const url = `https://sms.example.test/api/mca/sms/webhooks/twilio/${accountAId}/inbound`
  const params = new URLSearchParams({ AccountSid: twilio.accountSid, MessageSid: `SM${"e".repeat(32)}`, From: phone, To: sender, Body: "Synthetic reply" })
  const response = await inboundRoute(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sign(url, params, twilio.authToken) }, body: params }), { params: Promise.resolve({ accountId: accountAId }) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/xml; charset=utf-8")
  assert.equal(await response.text(), '<?xml version="1.0" encoding="UTF-8"?><Response/>')
})

test("SMS account mutation API rejects a directly authenticated non-admin session", async () => {
  const response = await createAccountRoute(new Request("https://app.example.test/api/mca/sms/accounts", {
    method: "POST", headers: { "content-type": "application/json", origin: "https://app.example.test", cookie: "mca_session=sms-other-session" },
    body: JSON.stringify({ label: "Forbidden", senderKind: "phone_number", senderIdentity: sender, credentialRef: "DEFAULT", memberIds: [ids.otherA] }),
  }))
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, "sms_admin_required")
})

test("revoking the sole default sender atomically clears default status and disables routing", async () => {
  const revoked = await updateSmsAccount(adminA, accountAId, { state: "revoked" })
  assert.equal(revoked.state, "revoked")
  assert.equal(revoked.isDefault, false)
  const row = await fixture.query("SELECT state,is_default FROM mca_sms_accounts WHERE id=$1", [accountAId])
  assert.deepEqual((row.rows as unknown as Array<{ state: string; is_default: number }>)[0], { state: "revoked", is_default: 0 })
  await assert.rejects(() => resolveSmsRoute(repA, { dealId: ids.dealA }), /No assigned SMS account is available/)
})
