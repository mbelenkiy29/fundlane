import "./helpers/business-auth";
import test, { after, before, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { decryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import type { EmailSender, SenderTestSendResult } from "../src/lib/mca/senders/contracts"
import {
  assertSenderUsable,
  completeSenderOAuth,
  createSender,
  expireSender,
  getSender,
  listSenders,
  setSenderDeliveryFetchForTests,
  setSenderOAuthFetchForTests,
  startSenderOAuth,
  testSend,
  updateSender,
} from "../src/lib/mca/senders/service"
import { GET as listGet, POST as listPost } from "../src/app/api/mca/senders/route"
import { GET as senderGet, PATCH as senderPatch } from "../src/app/api/mca/senders/[id]/route"
import { POST as testPost } from "../src/app/api/mca/senders/[id]/test/route"
import { POST as oauthPost } from "../src/app/api/mca/senders/[id]/oauth/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const ids = {
  workspace: "workspace-senders",
  otherWorkspace: "workspace-senders-other",
  adminUser: "sender-admin-user",
  adminMember: "sender-admin-member",
  repUser: "sender-rep-user",
  repMember: "sender-rep-member",
  otherUser: "sender-other-user",
  otherMember: "sender-other-member",
}

const SMTP_PASSWORD = "smtp-live-password-never-leak"
const SENDGRID_KEY = "sg-live-secret-never-leak"
const OAUTH_ACCESS = "google-access-token-never-leak"
const OAUTH_REFRESH = "google-refresh-token-never-leak"

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => ({
  workspaceId,
  userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
  membershipId: workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember,
  role,
  managedMembershipIds: [],
  activeMembershipIds: [],
  source: role ? "user" : "api_key",
  correlationId: `corr-${workspaceId}-${role ?? "key"}`,
})

const smtpInput = (suffix: string, extra: Record<string, unknown> = {}) => ({
  provider: "smtp" as const,
  purpose: "submission" as const,
  fromName: `Broker ${suffix}`,
  fromAddress: `broker-${suffix}@example.test`,
  smtp: { host: "smtp.example.test", port: 587, username: "broker", password: SMTP_PASSWORD },
  ...extra,
})

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Senders Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "senders-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "senders-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "senders-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sender-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sender-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("sender-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("read-key", "read-secret", ["deals:read"], ids.workspace)
}

function cookieRequest(path: string, token: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      cookie: `mca_session=${token}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function bearerRequest(path: string, secret: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer mca_${secret}`,
      origin: "http://localhost",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes(SENDGRID_KEY), false)
  assert.equal(text.includes(OAUTH_ACCESS), false)
  assert.equal(text.includes(OAUTH_REFRESH), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
}

const previousEnv = {
  webhook: process.env.MCA_EMAIL_WEBHOOK_URL,
  googleId: process.env.MCA_GOOGLE_SENDER_CLIENT_ID,
  googleSecret: process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET,
  microsoftId: process.env.MCA_MICROSOFT_SENDER_CLIENT_ID,
  microsoftSecret: process.env.MCA_MICROSOFT_SENDER_CLIENT_SECRET,
  origin: process.env.MCA_APP_ORIGIN,
}

function restoreEnv() {
  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  assign("MCA_EMAIL_WEBHOOK_URL", previousEnv.webhook)
  assign("MCA_GOOGLE_SENDER_CLIENT_ID", previousEnv.googleId)
  assign("MCA_GOOGLE_SENDER_CLIENT_SECRET", previousEnv.googleSecret)
  assign("MCA_MICROSOFT_SENDER_CLIENT_ID", previousEnv.microsoftId)
  assign("MCA_MICROSOFT_SENDER_CLIENT_SECRET", previousEnv.microsoftSecret)
  assign("MCA_APP_ORIGIN", previousEnv.origin)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("senders")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_GOOGLE_SENDER_CLIENT_ID
  delete process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET
  delete process.env.MCA_MICROSOFT_SENDER_CLIENT_ID
  delete process.env.MCA_MICROSOFT_SENDER_CLIENT_SECRET
  delete process.env.MCA_APP_ORIGIN
  await seed()
})

beforeEach(async () => {
  await getDatabase().execute("DELETE FROM mca_email_oauth_states")
  await getDatabase().execute("DELETE FROM mca_email_senders")
  setSenderOAuthFetchForTests()
  setSenderDeliveryFetchForTests()
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  delete process.env.MCA_GOOGLE_SENDER_CLIENT_ID
  delete process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET
  delete process.env.MCA_MICROSOFT_SENDER_CLIENT_ID
  delete process.env.MCA_MICROSOFT_SENDER_CLIENT_SECRET
  delete process.env.MCA_APP_ORIGIN
})

after(async () => {
  setSenderOAuthFetchForTests()
  setSenderDeliveryFetchForTests()
  restoreEnv()
  await closeDatabaseForTests()
  await testDatabase.close()
})

test("MIC-121: admin creates SMTP sender, lists it, and test-send previews", async () => {
  const created = await listPost(cookieRequest("/api/mca/senders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify(smtpInput("preview")),
  }))
  assert.equal(created.status, 201)
  const sender = await created.json() as EmailSender
  assert.equal(sender.provider, "smtp")
  assert.equal(sender.purpose, "submission")
  assert.equal(sender.state, "pending")
  assert.equal(sender.hasCredential, true)
  assertNoSecret(sender)

  const listed = await listGet(cookieRequest("/api/mca/senders", "admin-session-token"))
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as { senders: EmailSender[] }
  assert.equal(listBody.senders.some((item) => item.id === sender.id), true)
  assertNoSecret(listBody)

  const preview = await testPost(cookieRequest(`/api/mca/senders/${sender.id}/test`, "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ to: "ops@example.test" }),
  }), params(sender.id))
  assert.equal(preview.status, 200)
  const result = await preview.json() as SenderTestSendResult
  assert.equal(result.delivery, "preview")
  assert.ok(result.correlationId)
  assertNoSecret(result)

  const verified = await senderGet(cookieRequest(`/api/mca/senders/${sender.id}`, "admin-session-token"), params(sender.id))
  assert.equal((await verified.json() as EmailSender).state, "verified")
})

test("MIC-121: unauthorized rep cannot PATCH or test-send by forging a sender id", async () => {
  const sender = await createSender(actor(), smtpInput("forged"))
  const forgedPatch = await senderPatch(cookieRequest(`/api/mca/senders/${sender.id}`, "rep-session-token", {
    method: "PATCH",
    body: JSON.stringify({ fromName: "Stolen" }),
  }), params(sender.id))
  assert.equal(forgedPatch.status, 403)
  assert.equal((await forgedPatch.json() as { error: { code: string } }).error.code, "permission_denied")

  const forgedTest = await testPost(cookieRequest(`/api/mca/senders/${sender.id}/test`, "rep-session-token", {
    method: "POST",
    body: "{}",
  }), params(sender.id))
  assert.equal(forgedTest.status, 403)
  const forgedBody = await forgedTest.json() as { error: { code: string } }
  assert.equal(forgedBody.error.code, "permission_denied")
  assertNoSecret(forgedBody)

  const missing = await testPost(cookieRequest("/api/mca/senders/missing-sender/test", "rep-session-token", {
    method: "POST",
    body: "{}",
  }), params("missing-sender"))
  assert.equal(missing.status, 403)
  assert.equal((await missing.json() as { error: { code: string } }).error.code, "permission_denied")

  await assert.rejects(
    () => assertSenderUsable(actor(ids.workspace, "rep"), sender.id, "submission"),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "permission_denied",
  )
})

test("MIC-121: admin shares a sender with a rep and the rep can test-send", async () => {
  const sender = await createSender(actor(), smtpInput("shared"))
  const patched = await senderPatch(cookieRequest(`/api/mca/senders/${sender.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ memberIds: [ids.repMember] }),
  }), params(sender.id))
  assert.equal(patched.status, 200)
  const shared = await patched.json() as EmailSender
  assert.deepEqual(shared.memberIds, [ids.repMember])
  assertNoSecret(shared)

  const listed = await listGet(cookieRequest("/api/mca/senders", "rep-session-token"))
  assert.equal((await listed.json() as { senders: EmailSender[] }).senders.some((item) => item.id === sender.id), true)

  const preview = await testPost(cookieRequest(`/api/mca/senders/${sender.id}/test`, "rep-session-token", {
    method: "POST",
    body: "{}",
  }), params(sender.id))
  assert.equal(preview.status, 200)
  assert.equal((await preview.json() as SenderTestSendResult).delivery, "preview")

  const usable = await assertSenderUsable(actor(ids.workspace, "rep"), sender.id, "submission")
  assert.equal(usable.id, sender.id)
  assert.equal(usable.state, "verified")
  assertNoSecret(usable)
})

test("MIC-121: expired sender returns reconnect payload and keeps id and members", async () => {
  const sender = await createSender(actor(), smtpInput("expired", { memberIds: [ids.repMember], isDefault: true }))
  const expired = await expireSender(actor(), sender.id)
  assert.equal(expired.id, sender.id)
  assert.equal(expired.state, "expired")
  assert.equal(expired.hasCredential, true)
  assert.deepEqual(expired.memberIds, [ids.repMember])
  assert.equal(expired.reconnect?.available, true)
  assert.equal(expired.reconnect?.method, "credentials")
  assertNoSecret(expired)

  const got = await senderGet(cookieRequest(`/api/mca/senders/${sender.id}`, "admin-session-token"), params(sender.id))
  assert.equal(got.status, 200)
  const body = await got.json() as EmailSender & { reconnect?: { available: boolean; method: string } }
  assert.equal(body.id, sender.id)
  assert.equal(body.state, "expired")
  assert.deepEqual(body.memberIds, [ids.repMember])
  assert.equal(body.reconnect?.available, true)
  assert.equal(body.isDefault, true)
  assertNoSecret(body)

  const row = await getDatabase().prepare<{ id: string; credential_cipher: string }>(
    "SELECT id, credential_cipher FROM mca_email_senders WHERE id = ?",
  ).get(sender.id)
  assert.ok(row)
  assert.equal(row.credential_cipher.includes(SMTP_PASSWORD), false)
  assert.equal(JSON.parse(decryptSensitive(row.credential_cipher, ids.workspace)).password, SMTP_PASSWORD)

  const members = await getDatabase().prepare<{ count: string }>(
    "SELECT COUNT(*) AS count FROM mca_email_sender_members WHERE sender_id = ?",
  ).get(sender.id)
  assert.equal(Number(members?.count), 1)

  const blocked = await testPost(cookieRequest(`/api/mca/senders/${sender.id}/test`, "rep-session-token", {
    method: "POST",
    body: "{}",
  }), params(sender.id))
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, "sender_expired")

  const reconnected = await updateSender(actor(), sender.id, { smtp: { password: SMTP_PASSWORD } })
  assert.equal(reconnected.id, sender.id)
  assert.equal(reconnected.state, "pending")
  assert.deepEqual(reconnected.memberIds, [ids.repMember])
})

test("MIC-121: intake API key is 403 on POST and deals:read lists metadata without secrets", async () => {
  const created = await createSender(actor(), smtpInput("metadata"))
  const intake = await listPost(bearerRequest("/api/mca/senders", "intake-secret", {
    method: "POST",
    body: JSON.stringify(smtpInput("intake")),
  }))
  assert.equal(intake.status, 403)
  assertNoSecret(await intake.json())

  const readPost = await listPost(bearerRequest("/api/mca/senders", "read-secret", {
    method: "POST",
    body: JSON.stringify(smtpInput("read-write")),
  }))
  assert.equal(readPost.status, 403)

  const listed = await listGet(bearerRequest("/api/mca/senders", "read-secret"))
  assert.equal(listed.status, 200)
  const body = await listed.json() as { senders: EmailSender[] }
  const item = body.senders.find((sender) => sender.id === created.id)
  assert.ok(item)
  assert.equal(item.hasCredential, true)
  assert.equal("credentialCipher" in item, false)
  assertNoSecret(body)
})

test("MIC-121: response JSON has hasCredential and never credentialCipher or password", async () => {
  const httpCreated = await listPost(cookieRequest("/api/mca/senders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      provider: "sendgrid",
      purpose: "merchant",
      fromName: "SendGrid Desk",
      fromAddress: "desk@example.test",
      sendgrid: { apiKey: SENDGRID_KEY },
    }),
  }))
  const sender = await httpCreated.json() as EmailSender
  assert.equal(sender.hasCredential, true)
  assert.equal("password" in sender, false)
  assertNoSecret(sender)

  const row = await getDatabase().prepare<{ credential_cipher: string }>("SELECT credential_cipher FROM mca_email_senders WHERE id = ?").get(sender.id)
  assert.ok(row)
  assert.equal(decryptSensitive(row.credential_cipher, ids.workspace).includes(SENDGRID_KEY), true)
  assert.throws(() => decryptSensitive(row.credential_cipher, ids.otherWorkspace))
})

test("MIC-121: default sender is unique per purpose", async () => {
  const first = await createSender(actor(), smtpInput("default-a", { isDefault: true, purpose: "submission" }))
  const second = await createSender(actor(), smtpInput("default-b", { isDefault: true, purpose: "submission" }))
  const merchant = await createSender(actor(), smtpInput("default-c", { isDefault: true, purpose: "merchant" }))
  assert.equal((await getSender(actor(), first.id)).isDefault, false)
  assert.equal((await getSender(actor(), second.id)).isDefault, true)
  assert.equal((await getSender(actor(), merchant.id)).isDefault, true)

  const patched = await senderPatch(cookieRequest(`/api/mca/senders/${first.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ isDefault: true }),
  }), params(first.id))
  assert.equal((await patched.json() as EmailSender).isDefault, true)
  assert.equal((await getSender(actor(), second.id)).isDefault, false)
  assert.equal((await getSender(actor(), merchant.id)).isDefault, true)
})

test("MIC-121: OAuth start without env returns 503 sender_oauth_not_configured and keeps a pending sender", async () => {
  const created = await listPost(cookieRequest("/api/mca/senders", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({
      provider: "google",
      purpose: "fallback",
      fromName: "Gmail Desk",
      fromAddress: "gmail@example.test",
      memberIds: [ids.repMember],
    }),
  }))
  assert.equal(created.status, 201)
  const sender = await created.json() as EmailSender & { reconnect?: { available: boolean; method: string } }
  assert.equal(sender.state, "pending")
  assert.equal(sender.hasCredential, false)
  assert.equal(sender.reconnect?.method, "oauth")
  assertNoSecret(sender)

  const started = await oauthPost(cookieRequest(`/api/mca/senders/${sender.id}/oauth`, "admin-session-token", {
    method: "POST",
    body: "{}",
  }), params(sender.id))
  assert.equal(started.status, 503)
  const errorBody = await started.json() as { error: { code: string } }
  assert.equal(errorBody.error.code, "sender_oauth_not_configured")
  assertNoSecret(errorBody)

  const kept = await getSender(actor(), sender.id)
  assert.equal(kept.id, sender.id)
  assert.equal(kept.state, "pending")
  assert.deepEqual(kept.memberIds, [ids.repMember])
})

test("MIC-121: OAuth start with env returns a Google URL and reconnect keeps identity", async () => {
  process.env.MCA_GOOGLE_SENDER_CLIENT_ID = "google-client-id"
  process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET = "google-client-secret"
  process.env.MCA_APP_ORIGIN = "http://localhost"
  const sender = await createSender(actor(), {
    provider: "google",
    purpose: "merchant",
    fromName: "Workspace Gmail",
    fromAddress: "gmail@example.test",
    memberIds: [ids.repMember],
  })
  const started = await startSenderOAuth(actor(), sender.id)
  const url = new URL(started.authorizationUrl)
  assert.equal(url.origin, "https://accounts.google.com")
  assert.equal(url.searchParams.get("client_id"), "google-client-id")
  assert.equal(url.searchParams.get("access_type"), "offline")
  assert.match(url.searchParams.get("scope") ?? "", /gmail\.send/)
  assert.equal(started.sender.id, sender.id)
  assert.equal(started.sender.state, "pending")

  setSenderOAuthFetchForTests(async (input) => {
    const target = String(input)
    if (target.includes("oauth2.googleapis.com/token")) {
      return Response.json({
        access_token: OAUTH_ACCESS,
        refresh_token: OAUTH_REFRESH,
        expires_in: 3600,
        scope: "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email",
      })
    }
    if (target.includes("userinfo")) return Response.json({ email: "gmail@example.test" })
    throw new Error(`unexpected oauth fetch ${target}`)
  })
  const connected = await completeSenderOAuth(actor(), {
    state: url.searchParams.get("state") ?? "",
    code: "auth-code",
  })
  assert.equal(connected.id, sender.id)
  assert.equal(connected.state, "verified")
  assert.equal(connected.hasCredential, true)
  assert.deepEqual(connected.memberIds, [ids.repMember])
  assertNoSecret(connected)

  const expired = await expireSender(actor(), sender.id)
  assert.equal(expired.id, sender.id)
  assert.equal(expired.reconnect?.method, "oauth")
  const restarted = await startSenderOAuth(actor(), sender.id)
  assert.equal(restarted.sender.id, sender.id)
  assert.deepEqual(restarted.sender.memberIds, [ids.repMember])
})

test("MIC-121: webhook test-send posts a redacted payload", async () => {
  process.env.MCA_EMAIL_WEBHOOK_URL = "https://mail.example.test/webhook"
  const captured: Array<{ url: string; body: string; authorization: string | null }> = []
  setSenderDeliveryFetchForTests(async (input, init) => {
    captured.push({
      url: String(input),
      body: String(init?.body ?? ""),
      authorization: new Headers(init?.headers).get("authorization"),
    })
    return new Response("ok", { status: 202 })
  })
  const sender = await createSender(actor(), smtpInput("webhook"))
  const result = await testSend(actor(), sender.id, { to: "qa@example.test" })
  assert.equal(result.delivery, "sent")
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, "https://mail.example.test/webhook")
  assert.match(captured[0].body, /sender_test/)
  assert.match(captured[0].body, /qa@example.test/)
  assert.equal(captured[0].body.includes(SMTP_PASSWORD), false)
  assertNoSecret(captured[0].body)
  assert.equal((await getSender(actor(), sender.id)).state, "verified")
})

test("MIC-121: list is isolated across workspaces and purpose mismatch is rejected", async () => {
  const local = await createSender(actor(), smtpInput("tenant"))
  const remote = await createSender(actor(ids.otherWorkspace), smtpInput("tenant"))
  assert.equal((await listSenders(actor())).senders.some((item) => item.id === remote.id), false)
  await assert.rejects(
    () => getSender(actor(), remote.id),
    (error: { status?: number; code?: string }) => error.status === 403 && error.code === "permission_denied",
  )
  await testSend(actor(), local.id)
  await assert.rejects(
    () => assertSenderUsable(actor(), local.id, "merchant"),
    (error: { status?: number; code?: string }) => error.status === 422 && error.code === "sender_purpose_mismatch",
  )
  const usable = await assertSenderUsable(actor(), local.id, "submission")
  assert.equal(usable.id, local.id)
})
