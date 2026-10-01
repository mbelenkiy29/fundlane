import "./helpers/business-auth";
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import { AppError } from "../src/lib/mca/errors"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { TwilioSmsTransport } from "../src/lib/mca/sms/twilio"
import {
  createSmsAccount,
  deliverClosingSms,
  getSmsComposerContext,
  previewDirectSms,
  recordSmsConsent,
  resolveSmsRoute,
} from "../src/lib/mca/sms/service"
import { GET as messagesGet, POST as messagesPost } from "../src/app/api/mca/sms/messages/route"
import { GET as conversationsGet, POST as conversationsPost } from "../src/app/api/mca/sms/conversations/route"
import { smsRecipientHash } from "../src/lib/mca/sms/managed"
import { smsComposerGate } from "../src/components/mca/sms/composer-panel"

let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const priorEnv = {
  provider: process.env.MCA_SMS_PROVIDER,
  accounts: process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON,
  baseUrl: process.env.MCA_SMS_PUBLIC_BASE_URL,
  encryption: process.env.MCA_DATA_ENCRYPTION_KEY,
}
const now = "2026-09-08T16:00:00.000Z"
const phone = "+12125550123"
const sender = "+12125550999"
const twilio = {
  accountSid: `AC${"a".repeat(32)}`,
  apiKeySid: `SK${"b".repeat(32)}`,
  apiKeySecret: "synthetic-api-secret",
  authToken: "synthetic-auth-token",
  messageSid: `SM${"c".repeat(32)}`,
}
const ids = {
  workspace: "ws-m6-sms",
  adminUser: "user-m6-admin",
  admin: "member-m6-admin",
  repUser: "user-m6-rep",
  rep: "member-m6-rep",
  otherUser: "user-m6-other",
  other: "member-m6-other",
  deal: "deal-m6-sms",
  dealEmpty: "deal-m6-empty",
}
const admin: DealActor = { workspaceId: ids.workspace, userId: ids.adminUser, membershipId: ids.admin, role: "admin", managedMembershipIds: [], activeMembershipIds: [ids.admin, ids.rep, ids.other], source: "user", correlationId: "m6-admin" }
const rep: DealActor = { workspaceId: ids.workspace, userId: ids.repUser, membershipId: ids.rep, role: "rep", managedMembershipIds: [], activeMembershipIds: [ids.admin, ids.rep, ids.other], source: "user", correlationId: "m6-rep" }

function payloadHash(body: string): string { return createHash("sha256").update(body).digest("hex") }

function request(path: string, init: RequestInit & { cookie: string }): Request {
  return new Request(`https://app.example.test${path}`, {
    ...init,
    headers: { origin: "https://app.example.test", cookie: `mca_session=${init.cookie}`, ...(init.headers ?? {}) },
  })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() as { error?: { code?: string; message?: string }; messages?: unknown[]; recipient?: string | null; accounts?: unknown[]; consent?: { state?: string }; provider?: string; canSend?: boolean; block?: { code?: string }; state?: string; messageId?: string; errorCode?: string } }
}

async function seed() {
  const database = getDatabase()
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  const pages = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES
    (?,?,'America/New_York',10,?,?,?,?,?)`).run(ids.workspace, "M6 SMS Workspace", flags, pages, actions, now, now)
  await database.prepare(`INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES
    (?,?,?,'M6-A1',?,?),(?,?,?,'M6-A2',?,?),(?,?,?,'M6-A3',?,?)`).run(
    ids.adminUser, "m6-admin@example.test", "M6 Admin", now, now,
    ids.repUser, "m6-rep@example.test", "M6 Rep", now, now,
    ids.otherUser, "m6-other@example.test", "M6 Other", now, now,
  )
  await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES
    (?,?,?,'admin','active',?,?),(?,?,?,'rep','active',?,?),(?,?,?,'rep','active',?,?)`).run(
    ids.admin, ids.workspace, ids.adminUser, now, now,
    ids.rep, ids.workspace, ids.repUser, now, now,
    ids.other, ids.workspace, ids.otherUser, now, now,
  )
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES
    ('session-m6-admin',?,?,?,'2027-09-08T00:00:00.000Z',?,?),
    ('session-m6-rep',?,?,?,'2027-09-08T00:00:00.000Z',?,?),
    ('session-m6-other',?,?,?,'2027-09-08T00:00:00.000Z',?,?)`).run(
    ids.adminUser, ids.admin, hashOpaqueToken("m6-admin-session"), now, now,
    ids.repUser, ids.rep, hashOpaqueToken("m6-rep-session"), now, now,
    ids.otherUser, ids.other, hashOpaqueToken("m6-other-session"), now, now,
  )
  await database.prepare(`INSERT INTO deals (id,workspace_id,display_id,legal_name,contact_phone_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES
    (?,?,?,'Synthetic Composer Merchant',?,'offer',1,'submission_ready','[]','{}',1,?,?),
    (?,?,?,'No Mobile Merchant',NULL,'offer',1,'submission_ready','[]','{}',1,?,?)`).run(
    ids.deal, ids.workspace, "MCA-M6-A", encryptSensitive(phone, ids.workspace), now, now,
    ids.dealEmpty, ids.workspace, "MCA-M6-EMPTY", now, now,
  )
  await database.prepare(`INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id) VALUES
    ('m6-assign-rep',?,?,?,'originator',1,?,?),('m6-assign-other',?,?,?,'closer',1,?,?),
    ('m6-assign-empty-rep',?,?,?,'originator',1,?,?)`).run(
    ids.workspace, ids.deal, ids.rep, now, ids.adminUser,
    ids.workspace, ids.deal, ids.other, now, ids.adminUser,
    ids.workspace, ids.dealEmpty, ids.rep, now, ids.adminUser,
  )
}

before(async () => {
  fixture = await createPostgresTestDatabase("milestone06_sms_composer")
  Object.assign(process.env, fixture.env())
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_SMS_PROVIDER = "twilio"
  process.env.MCA_SMS_PUBLIC_BASE_URL = "https://sms.example.test"
  process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON = JSON.stringify({ [ids.workspace]: { DEFAULT: { ...twilio, allowedSenders: [sender] } } })
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

test("composer gate covers loading, empty, validation, blocked, and ready states", () => {
  const account = { id: "acc-1", label: "Merchant SMS", provider: "twilio" as const, senderMasked: "•••0999", providerConfigured: true, isDefault: true, state: "active" as const }
  assert.equal(smsComposerGate({ loading: true, recipient: null, accounts: [], selectedAccountId: "", consent: "loading", body: "", previewed: false }).phase, "loading")
  assert.equal(smsComposerGate({ loading: false, recipient: null, accounts: [account], selectedAccountId: account.id, consent: "opted_in", body: "Hi", previewed: true }).phase, "empty")
  assert.equal(smsComposerGate({ loading: false, recipient: phone, accounts: [], selectedAccountId: "", consent: "opted_in", body: "Hi", previewed: true }).phase, "empty")
  assert.equal(smsComposerGate({ loading: false, recipient: phone, accounts: [account], selectedAccountId: account.id, consent: "opted_in", body: "", previewed: false }).phase, "validation")
  assert.equal(smsComposerGate({ loading: false, recipient: phone, accounts: [account], selectedAccountId: account.id, consent: "opted_out", body: "Hi", previewed: false }).phase, "blocked")
  assert.equal(smsComposerGate({ loading: false, recipient: phone, accounts: [account], selectedAccountId: account.id, consent: "unknown", body: "Hi", previewed: false }).phase, "blocked")
  assert.equal(smsComposerGate({ loading: false, recipient: phone, accounts: [{ ...account, providerConfigured: false }], selectedAccountId: account.id, consent: "opted_in", body: "Hi", previewed: false }).phase, "blocked")
  const needsPreview = smsComposerGate({ loading: false, recipient: phone, accounts: [account], selectedAccountId: account.id, consent: "opted_in", body: "Hi", previewed: false })
  assert.equal(needsPreview.phase, "validation")
  assert.equal(needsPreview.sendEnabled, false)
  const ready = smsComposerGate({ loading: false, recipient: phone, accounts: [account], selectedAccountId: account.id, consent: "opted_in", body: "Hi", previewed: true })
  assert.equal(ready.phase, "ready")
  assert.equal(ready.sendEnabled, true)
})

test("empty composer context has no recipient or assigned account until both exist", async () => {
  const empty = await getSmsComposerContext(rep, ids.dealEmpty)
  assert.equal(empty.recipient, null)
  assert.deepEqual(empty.accounts, [])
  assert.equal(empty.consent.state, "unknown")
  const beforeAccounts = await getSmsComposerContext(rep, ids.deal)
  assert.equal(beforeAccounts.recipient, phone)
  assert.equal(beforeAccounts.accounts.length, 0)
})

let assignedId = ""
let adminOnlyId = ""
test("rep cannot send or preview through an unassigned account, and opt-out plus recipient mismatch block outreach", async () => {
  const assigned = await createSmsAccount(admin, { label: "Assigned Twilio", senderKind: "phone_number", senderIdentity: sender, credentialRef: "DEFAULT", memberIds: [ids.admin, ids.rep], isDefault: true })
  assignedId = assigned.id
  assert.equal(assigned.provider, "twilio")
  assert.equal(assigned.providerConfigured, true)
  const adminOnly = await createSmsAccount(admin, { label: "Admin Only Twilio", senderKind: "phone_number", senderIdentity: sender, credentialRef: "DEFAULT", memberIds: [ids.admin], isDefault: false })
  adminOnlyId = adminOnly.id
  await recordSmsConsent(admin, { dealId: ids.deal, recipient: phone, state: "opted_in", evidence: "Merchant signed synthetic composer consent", effectiveAt: now, idempotencyKey: "m6-consent-in" })

  const unassigned = await deliverClosingSms(rep, { dealId: ids.deal, recipient: phone, body: "Should not send", senderAccountId: adminOnlyId, idempotencyKey: "m6-unassigned", correlationId: "corr-unassigned", payloadHash: payloadHash("Should not send"), deliveryMode: "never_attempted" }, { send: async () => { throw new Error("must not send") } }).then(() => null, (error) => error)
  assert.equal(unassigned instanceof AppError, true)
  assert.equal((unassigned as AppError).status, 403)
  assert.equal((unassigned as AppError).code, "sms_account_not_assigned")

  const previewDenied = await previewDirectSms(rep, { dealId: ids.deal, recipient: phone, body: "Preview unassigned", senderAccountId: adminOnlyId }).then(() => null, (error) => error)
  assert.equal((previewDenied as AppError).code, "sms_account_not_assigned")

  await recordSmsConsent(admin, { dealId: ids.deal, recipient: phone, state: "opted_out", evidence: "Merchant sent STOP in synthetic composer fixture", effectiveAt: "2026-09-08T17:00:00.000Z", idempotencyKey: "m6-consent-out" })
  const optedOut = await deliverClosingSms(rep, { dealId: ids.deal, recipient: phone, body: "Blocked outreach", senderAccountId: assignedId, idempotencyKey: "m6-opt-out", correlationId: "corr-opt-out", payloadHash: payloadHash("Blocked outreach"), deliveryMode: "never_attempted" }, { send: async () => { throw new Error("must not send") } }).then(() => null, (error) => error)
  assert.equal((optedOut as AppError).code, "sms_recipient_opted_out")
  const previewOptOut = await previewDirectSms(rep, { dealId: ids.deal, recipient: phone, body: "Blocked outreach", senderAccountId: assignedId })
  assert.equal(previewOptOut.canSend, false)
  assert.equal(previewOptOut.block?.code, "sms_recipient_opted_out")

  await recordSmsConsent(admin, { dealId: ids.deal, recipient: phone, state: "opted_in", evidence: "Merchant sent START in synthetic composer fixture", effectiveAt: "2026-09-08T18:00:00.000Z", idempotencyKey: "m6-consent-in-again" })
  const mismatch = await deliverClosingSms(rep, { dealId: ids.deal, recipient: "+12125550000", body: "Wrong number", senderAccountId: assignedId, idempotencyKey: "m6-mismatch", correlationId: "corr-mismatch", payloadHash: payloadHash("Wrong number"), deliveryMode: "never_attempted" }).then(() => null, (error) => error)
  assert.equal((mismatch as AppError).code, "recipient_deal_mismatch")
})

test("message provider is persisted from the account row and outbound send uses the adapter registry", async () => {
  const entranceId = "acc-m6-entrance"
  await getDatabase().prepare(`INSERT INTO mca_sms_accounts
    (id,workspace_id,provider,label,sender_kind,sender_identity_cipher,credential_ref,state,is_default,created_by_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`).run(entranceId, ids.workspace, "entrance", "Entrance Direct", "phone_number", encryptSensitive(sender, ids.workspace), "ENTRANCE", "active", ids.adminUser, now, now)
  await getDatabase().prepare("INSERT INTO mca_sms_account_members (workspace_id,account_id,membership_id,assigned_at,assigned_by_user_id) VALUES (?,?,?,?,?)").run(ids.workspace, entranceId, ids.rep, now, ids.adminUser)
  const route = await resolveSmsRoute(rep, { dealId: ids.deal, senderAccountId: entranceId })
  assert.equal(route.provider, "entrance")
  assert.equal(route.providerConfigured, false)
  const result = await deliverClosingSms(rep, { dealId: ids.deal, recipient: phone, body: "Adapter registry fixture", senderAccountId: entranceId, idempotencyKey: "m6-entrance", correlationId: "corr-entrance", payloadHash: payloadHash("Adapter registry fixture"), deliveryMode: "never_attempted" })
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "entrance_unconfigured")
  const stored = await fixture.query("SELECT provider,state,error_code FROM mca_sms_messages WHERE workspace_id=$1 AND idempotency_key=$2", [ids.workspace, "m6-entrance"])
  assert.deepEqual((stored.rows as unknown as Array<{ provider: string; state: string; error_code: string }>)[0], { provider: "entrance", state: "failed", error_code: "entrance_unconfigured" })
})

test("preview, accepted send, and retries preserve message identity without leaking secrets", async () => {
  let calls = 0
  const transport: TwilioSmsTransport = { send: async () => { calls += 1; return { state: "accepted", externalId: twilio.messageSid, providerStatus: "queued" } } }
  const body = "Exact synthetic composer preview"
  const preview = await previewDirectSms(rep, { dealId: ids.deal, recipient: phone, body, senderAccountId: assignedId })
  assert.equal(preview.canSend, true)
  assert.equal(preview.provider, "twilio")
  assert.equal(preview.body, body)
  assert.equal(JSON.stringify(preview).includes(twilio.apiKeySecret), false)
  assert.equal(JSON.stringify(preview).includes(twilio.authToken), false)

  const input = { dealId: ids.deal, recipient: phone, body, senderAccountId: assignedId, idempotencyKey: "m6-send", correlationId: "corr-send", payloadHash: payloadHash(body), deliveryMode: "never_attempted" as const }
  const first = await deliverClosingSms(rep, input, transport)
  const replay = await deliverClosingSms(rep, input, transport)
  assert.equal(first.state, "accepted")
  assert.equal(first.messageId, replay.messageId)
  assert.equal(first.externalId, twilio.messageSid)
  assert.equal(calls, 1)
  const context = await getSmsComposerContext(rep, ids.deal)
  assert.equal(context.messages.some((item) => item.id === first.messageId && item.body === body && item.provider === "twilio"), true)
  assert.equal(JSON.stringify(context).includes(twilio.apiKeySecret), false)
  assert.equal(JSON.stringify(context).includes(twilio.authToken), false)
  const serializedEnv = JSON.stringify(process.env.MCA_SMS_TWILIO_ACCOUNTS_JSON)
  assert.equal(JSON.stringify(context).includes(serializedEnv), false)
})

test("composer HTTP permissions match the UI and keep integrations-page access off the deal route", async () => {
  const missing = await json(await messagesGet(request("/api/mca/sms/messages", { cookie: "m6-rep-session" })))
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error?.code, "validation_failed")

  await getDatabase().prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: false }), ids.workspace)
  const loaded = await json(await messagesGet(request(`/api/mca/sms/messages?dealId=${ids.deal}`, { cookie: "m6-rep-session" })))
  assert.equal(loaded.status, 200)
  assert.equal(loaded.body.recipient, phone)
  assert.equal(Array.isArray(loaded.body.accounts), true)
  assert.equal(loaded.body.consent?.state, "opted_in")
  assert.equal(JSON.stringify(loaded.body).includes(twilio.apiKeySecret), false)

  const preview = await json(await messagesPost(request("/api/mca/sms/messages", {
    method: "POST",
    cookie: "m6-rep-session",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dealId: ids.deal, recipient: phone, body: "HTTP preview", senderAccountId: assignedId, idempotencyKey: "m6-http-preview", preview: true }),
  })))
  assert.equal(preview.status, 200)
  assert.equal(preview.body.canSend, true)
  assert.equal(preview.body.provider, "twilio")

  const unassigned = await json(await messagesPost(request("/api/mca/sms/messages", {
    method: "POST",
    cookie: "m6-rep-session",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dealId: ids.deal, recipient: phone, body: "HTTP unassigned", senderAccountId: adminOnlyId, idempotencyKey: "m6-http-unassigned" }),
  })))
  assert.equal(unassigned.status, 403)
  assert.equal(unassigned.body.error?.code, "sms_account_not_assigned")

  const otherSend = await json(await messagesPost(request("/api/mca/sms/messages", {
    method: "POST",
    cookie: "m6-other-session",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dealId: ids.deal, recipient: phone, body: "HTTP other unassigned", senderAccountId: assignedId, idempotencyKey: "m6-http-other" }),
  })))
  assert.equal(otherSend.status, 403)
  assert.equal(otherSend.body.error?.code, "sms_account_not_assigned")

  await getDatabase().prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(JSON.stringify({ dashboard: true, deals: false, users: true, reports: true, payments: true, workspace: true, integrations: true }), ids.workspace)
  const dealsDisabled = await json(await messagesGet(request(`/api/mca/sms/messages?dealId=${ids.deal}`, { cookie: "m6-rep-session" })))
  assert.equal(dealsDisabled.status, 403)
  assert.equal(dealsDisabled.body.error?.code, "page_disabled")
  await getDatabase().prepare("UPDATE workspaces SET page_visibility=? WHERE id=?").run(JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true }), ids.workspace)
})

test("composer panel source includes loading, empty, validation, success, and failure copy", () => {
  const source = readFileSync(new URL("../src/components/mca/sms/composer-panel.tsx", import.meta.url), "utf8")
  assert.match(source, /Loading SMS composer/)
  assert.match(source, /Save a merchant mobile number/)
  assert.match(source, /No text account is available/)
  assert.match(source, /Enter the exact text the merchant will receive/)
  assert.match(source, /Preview the exact message before sending/)
  assert.match(source, /role="alert"/)
  assert.match(source, /role="status"/)
  assert.match(source, /Text accepted/)
  assert.match(source, /idempotencyKey: sendKey.current/)
})

test("shared company inbox follows deal access and binds replies to their thread", async () => {
  const db = getDatabase(), shared = "m6-shared-account", otherDeal = "m6-other-deal", otherPhone = "+12125550888"
  await db.prepare("INSERT INTO mca_sms_accounts (id,workspace_id,provider,label,sender_kind,sender_identity_cipher,credential_ref,state,is_default,shared,created_at,updated_at) VALUES (?,?,'twilio','Shared Company','phone_number',?,'DEFAULT','active',0,1,?,?)").run(shared, ids.workspace, encryptSensitive(sender, ids.workspace), now, now)
  await db.prepare("INSERT INTO deals (id,workspace_id,display_id,legal_name,contact_phone_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES (?,?,?,'Other Merchant',?,'offer',1,'submission_ready','[]','{}',1,?,?)").run(otherDeal, ids.workspace, "MCA-M6-B", encryptSensitive(otherPhone, ids.workspace), now, now)
  await db.prepare("INSERT INTO deal_assignments (id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at,assigned_by_user_id) VALUES ('m6-only-other',?,?,?,'originator',1,?,?)").run(ids.workspace, otherDeal, ids.other, now, ids.adminUser)
  for (const [id, recipient, dealId] of [["m6-thread-a", phone, ids.deal], ["m6-thread-b", otherPhone, otherDeal], ["m6-thread-unmatched", "+12125550777", null]] as const) {
    await db.prepare("INSERT INTO sms_conversations (id,workspace_id,account_id,recipient_hash,recipient_cipher,deal_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, ids.workspace, shared, smsRecipientHash(ids.workspace, recipient), encryptSensitive(recipient, ids.workspace), dealId, now, now)
  }
  const inbox = async (cookie: string, id?: string) => json(await conversationsGet(request(`/api/mca/sms/conversations${id ? `?id=${id}` : ""}`, { cookie })))
  const repList = await inbox("m6-rep-session")
  assert.equal(repList.status, 200)
  assert.deepEqual((repList.body as {conversations:{id:string}[]}).conversations.filter(c => c.id.startsWith("m6-thread")).map(c => c.id), ["m6-thread-a"])
  assert.equal((await inbox("m6-rep-session", "m6-thread-b")).status, 404)
  assert.equal((await inbox("m6-rep-session", "m6-thread-unmatched")).status, 404)
  assert.equal((await inbox("m6-other-session", "m6-thread-b")).status, 200)
  const adminList = await inbox("m6-admin-session")
  assert.equal((adminList.body as {conversations:{id:string}[]}).conversations.filter(c => c.id.startsWith("m6-thread")).length, 3)
  assert.equal((await inbox("m6-admin-session", "m6-thread-b")).status, 200)
  assert.equal((await inbox("m6-admin-session", "m6-thread-unmatched")).status, 200)
  const reply = async (cookie: string, conversationId: string, dealId: string, recipient: string, senderAccountId = shared) => json(await messagesPost(request("/api/mca/sms/messages", {
    method: "POST", cookie, headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, dealId, recipient, senderAccountId, body: "Synthetic preview", idempotencyKey: `m6-${conversationId}`, preview: true }),
  })))
  assert.equal((await reply("m6-rep-session", "m6-thread-b", otherDeal, otherPhone)).status, 404)
  assert.equal((await reply("m6-rep-session", "m6-thread-a", otherDeal, phone)).status, 404)
  assert.equal((await reply("m6-rep-session", "m6-thread-a", ids.deal, phone, assignedId)).status, 404)
  assert.equal((await reply("m6-rep-session", "m6-thread-unmatched", ids.deal, "+12125550777")).status, 404)
  assert.equal((await reply("m6-rep-session", "m6-thread-a", ids.deal, phone)).status, 200)
  assert.equal((await reply("m6-admin-session", "m6-thread-b", otherDeal, otherPhone)).status, 200)
  const readDenied = await json(await conversationsPost(request("/api/mca/sms/conversations", { method: "POST", cookie: "m6-rep-session", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "m6-thread-b" }) })))
  assert.equal(readDenied.status, 404)
})

test("concurrent retries reserve one message and never reject with a database uniqueness failure", async () => {
  await recordSmsConsent(admin, { dealId: ids.deal, recipient: phone, state: "opted_in", evidence: "Synthetic current application consent", idempotencyKey: "m6-concurrent-consent", effectiveAt: "2099-01-01T00:00:00.000Z" })
  const body = "Concurrent application update"
  const input = { dealId: ids.deal, recipient: phone, body, senderAccountId: assignedId,
    idempotencyKey: "m6-concurrent-send", correlationId: "m6-concurrent", payloadHash: payloadHash(body), deliveryMode: "never_attempted" as const }
  let sends = 0
  const transport: TwilioSmsTransport = { send: async () => {
    sends++
    return { state: "accepted", externalId: `SM${"d".repeat(32)}` }
  } }
  const results = await Promise.allSettled([deliverClosingSms(rep, input, transport), deliverClosingSms(rep, input, transport)])
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2)
  const idsReturned = results.flatMap(r => r.status === "fulfilled" ? [r.value.messageId] : [])
  assert.equal(new Set(idsReturned).size, 1)
  assert.equal(sends, 1)
})
