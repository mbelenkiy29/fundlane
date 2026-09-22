import "./helpers/business-auth"
import test, { before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import {
  getDatabase,
  closeDatabaseForTests,
  nowIso,
  newId,
} from "../src/lib/mca/db"
import { encryptSensitive, hashOpaqueToken } from "../src/lib/mca/crypto"
import {
  createSender,
  startSenderOAuth,
  completeSenderOAuth,
  updateSender,
  revokeSender,
  setSenderOAuthFetchForTests,
} from "../src/lib/mca/senders/service"
import {
  encryptSenderCredential,
  findSenderById,
  toPublicSender,
} from "../src/lib/mca/senders/repository"
import {
  GOOGLE_SENDER_SCOPES,
  MICROSOFT_SENDER_SCOPES,
} from "../src/lib/mca/senders/oauth"
import {
  emailContext,
  retryEmail,
  queueEmail,
  emailMessages,
  listEmailConversations,
  markEmailRead,
  liveEmailActor,
  type MessageRow,
} from "../src/lib/mca/email-conversations/service"
import {
  runMessagingWorkerOnce,
  associatedReplies,
} from "../src/lib/mca/email-conversations/worker"
import {
  setEmailProviderFetchForTests,
  type RemoteEmail,
  mimeEmail,
} from "../src/lib/mca/email-conversations/providers"
import { POST as sendPost } from "../src/app/api/mca/email/messages/route"
import { GET as contextGet } from "../src/app/api/mca/email/context/route"
import type { DealActor } from "../src/lib/mca/deals/schema"
let fixture: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let rep: DealActor, admin: DealActor, other: DealActor
const ws = "email-workspace",
  to = "merchant@example.test",
  from = "rep@example.test"
let sent: RemoteEmail[] = [],
  inbound: RemoteEmail[] = [],
  calls = 0,
  mode: "ok" | "rate" | "unknown" | "lost" | "denied" = "ok",
  sendingReply = ""
const db = () => getDatabase()
before(async () => {
  fixture = await createPostgresTestDatabase("email_conversations")
  Object.assign(process.env, fixture.env())
  process.env.MCA_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64url")
  process.env.MCA_APP_ORIGIN = "https://app.example.test"
  process.env.MCA_GOOGLE_SENDER_CLIENT_ID = "synthetic"
  process.env.MCA_GOOGLE_SENDER_CLIENT_SECRET = "synthetic"
  process.env.MCA_MICROSOFT_SENDER_CLIENT_ID = "synthetic"
  process.env.MCA_MICROSOFT_SENDER_CLIENT_SECRET = "synthetic"
  const now = nowIso(),
    pages = JSON.stringify({
      dashboard: true,
      deals: true,
      users: true,
      reports: true,
      payments: true,
      workspace: true,
      integrations: true,
    })
  for (const id of [ws, "foreign-workspace"])
    await db()
      .prepare(
        "INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'America/New_York',10,'{}',?,'{}',?,?)"
      )
      .run(id, id, pages, now, now)
  for (const [id, role] of [
    ["admin", "admin"],
    ["rep", "rep"],
    ["other", "rep"],
  ]) {
    await db()
      .prepare(
        "INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,?,?,?,?)"
      )
      .run(id, `${id}@example.test`, id, id, now, now)
    await db()
      .prepare(
        "INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?)"
      )
      .run(id, ws, id, role, now, now)
    await db()
      .prepare(
        "INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,'2099-01-01',?,?)"
      )
      .run(id, id, id, hashOpaqueToken(`email-${id}`), now, now)
  }
  await db()
    .prepare(
      "INSERT INTO deals(id,workspace_id,display_id,legal_name,contact_email_cipher,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES('email-deal',?,'EMAIL-1','Synthetic Merchant',?,'offer',1,'submission_ready','[]','{}',1,?,?)"
    )
    .run(ws, encryptSensitive(to, ws), now, now)
  await db()
    .prepare(
      "INSERT INTO deals(id,workspace_id,display_id,legal_name,status,pipeline_version,draft_state,missing_required_json,field_sources_json,version,created_at,updated_at) VALUES('foreign-deal','foreign-workspace','EMAIL-2','Foreign Merchant','offer',1,'submission_ready','[]','{}',1,?,?)"
    )
    .run(now, now)
  await db()
    .prepare(
      "INSERT INTO deal_assignments(id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES('email-assignment',?,'email-deal','rep','originator',1,?)"
    )
    .run(ws, now)
  rep = await liveEmailActor(ws, "rep")
  admin = await liveEmailActor(ws, "admin")
  other = await liveEmailActor(ws, "other")
})
after(async () => {
  setEmailProviderFetchForTests()
  setSenderOAuthFetchForTests()
  await closeDatabaseForTests()
  await fixture?.close()
})
beforeEach(async () => {
  await db().execute(
    "DELETE FROM mca_email_reads; DELETE FROM mca_email_messages; DELETE FROM mca_email_conversations; DELETE FROM mca_email_worker_leases; DELETE FROM mca_email_oauth_states; DELETE FROM mca_email_sender_members; DELETE FROM mca_email_senders"
  )
  await db()
    .prepare("UPDATE memberships SET status='active' WHERE workspace_id=?")
    .run(ws)
  await db()
    .prepare("UPDATE deals SET contact_email_cipher=? WHERE id='email-deal'")
    .run(encryptSensitive(to, ws))
  await db()
    .prepare(
      "UPDATE deal_assignments SET membership_id='rep' WHERE id='email-assignment'"
    )
    .run()
  sent = []
  inbound = []
  calls = 0
  mode = "ok"
  sendingReply = ""
  setSenderOAuthFetchForTests(async (input) => {
    const url = String(input)
    if (url.includes("token"))
      return Response.json({
        access_token: "refreshed",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: GOOGLE_SENDER_SCOPES.join(" "),
      })
    return Response.json({ email: from, mail: from })
  })
  setEmailProviderFetchForTests(async (input, init) => {
    const url = new URL(String(input))
    if (init?.method === "POST") {
      calls++
      if (mode === "rate")
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "120" },
        })
      if (mode === "denied") return new Response("", { status: 401 })
      if (mode === "unknown") throw new Error("synthetic transport lost")
      const google = url.hostname === "gmail.googleapis.com"
      const raw = google ? JSON.parse(String(init.body)).raw : String(init.body)
      const mime = Buffer.from(raw, google ? "base64url" : "base64").toString()
      const h = (n: string) =>
        mime.match(new RegExp(`^${n}: (.*)$`, "mi"))?.[1].trim() ?? ""
      sendingReply = h("In-Reply-To")
      const m: RemoteEmail = {
        id: `provider-${sent.length}`,
        threadId: "thread-1",
        internetId: h("Message-ID"),
        references: h("References").match(/<[^>]+>/g) ?? [],
        from,
        to: [to],
        body: Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString(),
        occurredAt: nowIso(),
        localId: h("X-Fundlane-Message-Id"),
      }
      sent.push(m)
      if (mode === "lost")
        throw new Error("provider accepted but transport lost")
      return google
        ? Response.json({ id: m.id, threadId: m.threadId })
        : new Response(null, { status: 202 })
    }
    const gmail = (m: RemoteEmail) => ({
      id: m.id,
      threadId: m.threadId,
      internalDate: String(Date.parse(m.occurredAt)),
      payload: {
        mimeType: "text/plain",
        body: { data: Buffer.from(m.body).toString("base64url") },
        headers: [
          { name: "From", value: m.from },
          { name: "To", value: m.to.join(",") },
          { name: "Message-ID", value: m.internetId },
          { name: "References", value: m.references.join(" ") },
          { name: "X-Fundlane-Message-Id", value: m.localId ?? "" },
        ],
      },
    })
    const graph = (m: RemoteEmail) => ({
      id: m.id,
      conversationId: m.threadId,
      internetMessageId: m.internetId,
      internetMessageHeaders: [
        { name: "References", value: m.references.join(" ") },
        { name: "X-Fundlane-Message-Id", value: m.localId ?? "" },
      ],
      from: { emailAddress: { address: m.from } },
      toRecipients: m.to.map((address) => ({ emailAddress: { address } })),
      body: { content: m.body, contentType: "text" },
      receivedDateTime: m.occurredAt,
    })
    if (url.hostname === "gmail.googleapis.com") {
      if (url.pathname.includes("/threads/"))
        return Response.json({ messages: [...sent, ...inbound].map(gmail) })
      const match = sent.find((m) => url.pathname.endsWith(`/${m.id}`))
      if (match) return Response.json(gmail(match))
      return Response.json({
        messages: sent
          .filter((m) =>
            (url.searchParams.get("q") ?? "").includes(m.internetId)
          )
          .map((m) => ({ id: m.id })),
      })
    }
    return Response.json({
      value: (url.pathname.includes("sentitems")
        ? sent
        : [...sent, ...inbound]
      ).map(graph),
    })
  })
})
async function sender(provider: "google" | "microsoft" = "google") {
  const s = await createSender(rep, {
    personal: true,
    provider,
    purpose: "merchant",
    fromName: "Representative",
    fromAddress: from,
    signature: "Regards, Rep",
  })
  const credential = {
    kind: "oauth" as const,
    accessToken: "access",
    refreshToken: "refresh",
    email: from,
    expiresAt: "2099-01-01",
    scope: (provider === "google"
      ? GOOGLE_SENDER_SCOPES
      : MICROSOFT_SENDER_SCOPES
    ).join(" "),
  }
  await db()
    .prepare(
      "UPDATE mca_email_senders SET state='verified',credential_cipher=? WHERE id=?"
    )
    .run(encryptSenderCredential(ws, credential), s.id)
  return s.id
}
const input = (senderId: string, key = newId()) => ({
  dealId: "email-deal",
  senderId,
  recipient: to,
  subject: "Application update",
  body: "Hello merchant",
  idempotencyKey: key,
})
async function due() {
  await db().execute(
    "UPDATE mca_email_conversations SET next_sync_at='2000-01-01'; UPDATE mca_email_messages SET next_attempt_at='2000-01-01'"
  )
}
const request = (path: string, method = "GET", body?: unknown, user = "rep") =>
  new Request(`https://app.example.test${path}`, {
    method,
    headers: {
      origin: "https://app.example.test",
      cookie: `mca_session=email-${user}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

test("personal sender owner can connect; sharing and defaults remain admin-only", async () => {
  const id = await sender()
  assert.equal((await findSenderById(ws, id))?.ownerMembershipId, "rep")
  await assert.rejects(() => updateSender(rep, id, { memberIds: ["other"] }))
  await assert.rejects(() => updateSender(rep, id, { isDefault: true }))
  await assert.rejects(() =>
    createSender(rep, {
      ...{
        personal: true,
        provider: "google",
        purpose: "merchant",
        fromName: "Rep",
        fromAddress: from,
      },
      memberIds: ["other"],
    })
  )
  await updateSender(admin, id, { memberIds: ["other"] })
  await assert.rejects(() => startSenderOAuth(other, id))
  const pending = await startSenderOAuth(rep, id),
    state = new URL(pending.authorizationUrl).searchParams.get("state")!
  await assert.rejects(() =>
    completeSenderOAuth(other, { state, code: "forged" })
  )
  const connected = await completeSenderOAuth(rep, { state, code: "synthetic" })
  assert.equal(connected.conversationReady, true)
  await assert.rejects(() =>
    completeSenderOAuth(rep, { state, code: "replayed" })
  )
})
test("OAuth rejects mismatched connected address and reconnect readiness checks scopes", async () => {
  const id = await sender(),
    pending = await startSenderOAuth(rep, id),
    state = new URL(pending.authorizationUrl).searchParams.get("state")!
  setSenderOAuthFetchForTests(async (url) =>
    String(url).includes("token")
      ? Response.json({
          access_token: "a",
          refresh_token: "r",
          scope: GOOGLE_SENDER_SCOPES.join(" "),
        })
      : Response.json({ email: "different@example.test" })
  )
  await assert.rejects(
    () => completeSenderOAuth(rep, { state, code: "code" }),
    { code: "sender_address_mismatch" }
  )
  await db()
    .prepare("UPDATE mca_email_senders SET credential_cipher=? WHERE id=?")
    .run(
      encryptSenderCredential(ws, {
        kind: "oauth",
        accessToken: "x",
        refreshToken: "r",
        email: from,
        scope: "https://www.googleapis.com/auth/gmail.send",
      }),
      id
    )
  assert.equal(
    toPublicSender((await findSenderById(ws, id))!).conversationReady,
    false
  )
  await assert.rejects(() => queueEmail(rep, input(id)), {
    code: "email_reconnect_required",
  })
})
test("company pause halts queued mail without attempts or a recovery burst", async () => {
  const id = await sender("google"), queued = await queueEmail(rep, input(id))
  await db().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,updated_at) VALUES(?,1,1,?)").run(ws, nowIso())
  try {
    await runMessagingWorkerOnce()
    assert.equal(calls, 0)
    const row = await db().prepare<{ state: string; attempts: number }>("SELECT state,attempts FROM mca_email_messages WHERE conversation_id=?").get(queued.conversationId)
    assert.deepEqual(row, { state: "failed", attempts: 0 })
    await db().prepare("UPDATE company_subscription_state SET manual_paused=0 WHERE workspace_id=?").run(ws)
    await runMessagingWorkerOnce()
    assert.equal(calls, 0)
  } finally { await db().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(ws) }
})

test("offline pause recovery requires reviewed retry and keeps provider idempotency identity", async () => {
  const id = await sender("google"), queued = await queueEmail(rep, input(id))
  const original = await db().prepare("SELECT request_key,internet_message_id FROM mca_email_messages WHERE id=?").get(queued.id)
  await db().prepare("UPDATE mca_email_messages SET created_at=? WHERE id=?").run(new Date(Date.now() - 2000).toISOString(), queued.id)
  await db().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,last_paused_at,updated_at) VALUES(?,1,0,?,?)").run(ws, new Date(Date.now() - 1000).toISOString(), nowIso())
  try {
    await runMessagingWorkerOnce()
    assert.equal(calls, 0)
    assert.equal((await emailMessages(rep, queued.conversationId)).messages[0].state, "failed")
    await retryEmail(rep, queued.id)
    await runMessagingWorkerOnce()
    assert.equal(calls, 1)
    assert.equal((await emailMessages(rep, queued.conversationId)).messages[0].state, "sent")
    assert.deepEqual(await db().prepare("SELECT request_key,internet_message_id FROM mca_email_messages WHERE id=?").get(queued.id), original)
  } finally { await db().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(ws) }
})

for (const provider of ["google", "microsoft"] as const)
  test(`${provider}: sends, threads replies, deduplicates, and isolates unrelated mail`, async () => {
    const id = await sender(provider),
      queued = await queueEmail(rep, input(id))
    await runMessagingWorkerOnce()
    let detail = await emailMessages(rep, queued.conversationId)
    assert.equal(detail.messages[0].state, "sent")
    assert.equal(calls, 1)
    assert.equal(sent[0].body, "Hello merchant\n\nRegards, Rep")
    inbound = [
      {
        id: "reply-1",
        threadId: "thread-1",
        internetId: "<reply1@example.test>",
        references: [sent[0].internetId],
        from: to,
        to: [from],
        body: "Thank you <script>alert(1)</script>",
        occurredAt: nowIso(),
      },
      {
        id: "unrelated",
        threadId: "thread-1",
        internetId: "<private@example.test>",
        references: [],
        from: to,
        to: [from],
        body: "Private old email",
        occurredAt: nowIso(),
      },
    ]
    await due()
    await runMessagingWorkerOnce()
    await due()
    await runMessagingWorkerOnce()
    detail = await emailMessages(rep, queued.conversationId)
    assert.equal(detail.messages.length, 2)
    assert.equal(detail.conversation.unread, 1)
    assert.equal(detail.messages[1].body, "Thank you <script>alert(1)</script>")
    assert.equal(JSON.stringify(detail).includes("Private old email"), false)
    await markEmailRead(rep, queued.conversationId, detail.messages[1].sequence)
    assert.equal(
      (await emailMessages(rep, queued.conversationId)).conversation.unread,
      0
    )
    assert.equal(
      (await emailMessages(admin, queued.conversationId)).conversation.unread,
      1
    )
    await queueEmail(
      rep,
      { body: "Following up", idempotencyKey: newId() },
      queued.conversationId
    )
    await runMessagingWorkerOnce()
    assert.equal(calls, 2)
    assert.equal(sendingReply, "<reply1@example.test>")
    const raw = await db()
      .prepare<{
        body_cipher: string
      }>("SELECT body_cipher FROM mca_email_messages WHERE id=?")
      .get(queued.id)
    assert.ok(raw)
    assert.ok(!raw.body_cipher.includes("Hello merchant"))
  })
test("concurrent duplicate send requests return one durable message", async () => {
  const id = await sender(),
    data = input(id)
  const [a, b] = await Promise.all([
    queueEmail(rep, data),
    queueEmail(rep, data),
  ])
  assert.equal(a.id, b.id)
  await assert.rejects(() => queueEmail(rep, { ...data, body: "different" }), {
    code: "email_idempotency_conflict",
  })
  await Promise.all([runMessagingWorkerOnce(), runMessagingWorkerOnce()])
  assert.equal(calls, 1)
})
test("forged sender, deal, recipient and inactive membership are rejected", async () => {
  const id = await sender(),
    data = input(id),
    q = await queueEmail(rep, data)
  await assert.rejects(() => queueEmail(other, input(id)))
  await assert.rejects(() =>
    queueEmail(rep, { ...input(id), dealId: "foreign-deal" })
  )
  await assert.rejects(
    () => queueEmail(rep, { ...input(id), recipient: "forged@example.test" }),
    { code: "email_recipient_changed" }
  )
  assert.deepEqual((await listEmailConversations(other)).conversations, [])
  await assert.rejects(() => emailMessages(other, q.conversationId))
  await db()
    .prepare("UPDATE memberships SET status='deactivated' WHERE id='rep'")
    .run()
  await assert.rejects(() => emailMessages(rep, q.conversationId), {
    code: "email_member_inactive",
  })
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (
      await db()
        .prepare<MessageRow>("SELECT * FROM mca_email_messages WHERE id=?")
        .get(q.id)
    )?.state,
    "blocked"
  )
})
test("worker rechecks deal assignment and sender revocation before delivery", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  await db().execute(
    "UPDATE deal_assignments SET membership_id='other' WHERE id='email-assignment'"
  )
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  await db().execute(
    "UPDATE deal_assignments SET membership_id='rep' WHERE id='email-assignment'"
  )
  await revokeSender(rep, id)
  await due()
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "blocked"
  )
})
test("rate limits defer jobs and revoked OAuth keeps queued work recoverable", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  mode = "rate"
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "queued"
  )
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  mode = "denied"
  await due()
  await runMessagingWorkerOnce()
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "blocked"
  )
  mode = "ok"
  await db()
    .prepare("UPDATE mca_email_senders SET state='verified' WHERE id=?")
    .run(id)
  await due()
  await runMessagingWorkerOnce()
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "sent"
  )
})
test("unknown and interrupted sends never dispatch twice", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  mode = "unknown"
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "unknown"
  )
  mode = "ok"
  await due()
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  await assert.rejects(
    () =>
      queueEmail(
        rep,
        { body: "Retry", idempotencyKey: newId() },
        q.conversationId
      ),
    { code: "email_delivery_pending" }
  )
  await db()
    .prepare("UPDATE mca_email_messages SET state='sending' WHERE id=?")
    .run(q.id)
  await due()
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "unknown"
  )
})
test("lost acceptance is reconciled from Sent mail without resending", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  mode = "lost"
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "sent"
  )
  await due()
  await runMessagingWorkerOnce()
  assert.equal(calls, 1)
})
test("expiring OAuth is refreshed and encrypted before sending", async () => {
  const id = await sender()
  await db()
    .prepare("UPDATE mca_email_senders SET credential_cipher=? WHERE id=?")
    .run(
      encryptSenderCredential(ws, {
        kind: "oauth",
        accessToken: "old",
        refreshToken: "refresh",
        email: from,
        expiresAt: "2000-01-01",
        scope: GOOGLE_SENDER_SCOPES.join(" "),
      }),
      id
    )
  const q = await queueEmail(rep, input(id))
  await runMessagingWorkerOnce()
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "sent"
  )
  const row = await findSenderById(ws, id)
  assert.ok(row?.credentialCipher)
  assert.ok(!row.credentialCipher.includes("refreshed"))
})
test("a pause during OAuth refresh is rechecked before any message dispatch", async () => {
  const id = await sender(), queued = await queueEmail(rep, input(id))
  await db().prepare("UPDATE mca_email_senders SET credential_cipher=? WHERE id=?").run(encryptSenderCredential(ws, {
    kind: "oauth", accessToken: "old", refreshToken: "refresh", email: from, expiresAt: "2000-01-01", scope: GOOGLE_SENDER_SCOPES.join(" "),
  }), id)
  setSenderOAuthFetchForTests(async () => {
    await db().prepare("INSERT INTO company_subscription_state(workspace_id,legacy_exempt,manual_paused,updated_at) VALUES(?,1,1,?) ON CONFLICT(workspace_id) DO UPDATE SET manual_paused=1").run(ws, nowIso())
    return Response.json({ access_token: "refreshed", refresh_token: "refresh", expires_in: 3600, scope: GOOGLE_SENDER_SCOPES.join(" ") })
  })
  try {
    await runMessagingWorkerOnce()
    assert.equal(calls, 0)
    assert.deepEqual(await db().prepare("SELECT state,attempts FROM mca_email_messages WHERE conversation_id=?").get(queued.conversationId), { state: "failed", attempts: 0 })
  } finally { await db().prepare("DELETE FROM company_subscription_state WHERE workspace_id=?").run(ws) }
})

test("read markers do not consume later replies and message history paginates", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  await runMessagingWorkerOnce()
  const first = (await emailMessages(rep, q.conversationId)).messages[0]
  for (let i = 0; i < 55; i++)
    await db()
      .prepare(
        "INSERT INTO mca_email_messages(id,workspace_id,conversation_id,direction,body_cipher,author_cipher,provider_message_id,internet_message_id,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,'inbound',?,?,?,?,'received',?,?,?)"
      )
      .run(
        newId(),
        ws,
        q.conversationId,
        encryptSensitive(`reply ${i}`, ws),
        encryptSensitive(to, ws),
        `in-${i}`,
        `<in-${i}@example.test>`,
        nowIso(),
        nowIso(),
        nowIso()
      )
  await markEmailRead(rep, q.conversationId, first.sequence)
  const page = await emailMessages(rep, q.conversationId)
  assert.equal(page.messages.length, 50)
  assert.equal(page.conversation.unread, 55)
  assert.ok(page.nextCursor)
  const older = await emailMessages(rep, q.conversationId, page.nextCursor!)
  assert.equal(older.messages.length, 6)
})
test("HTTP rejects malformed input and forged origin and accepts a valid send", async () => {
  const id = await sender()
  assert.equal(
    (await contextGet(request("/api/mca/email/context"))).status,
    400
  )
  assert.equal(
    (
      await sendPost(
        request("/api/mca/email/messages", "POST", {
          ...input(id),
          recipient: "invalid",
        })
      )
    ).status,
    400
  )
  const forged = request("/api/mca/email/messages", "POST", input(id))
  forged.headers.set("origin", "https://attacker.example.test")
  assert.equal((await sendPost(forged)).status, 403)
  assert.equal(
    (await sendPost(request("/api/mca/email/messages", "POST", input(id))))
      .status,
    202
  )
})
test("association follows references, ignores address-only matches and unrelated participants", () => {
  const base = {
    id: "a",
    threadId: "t",
    internetId: "<a@t>",
    references: ["<root@t>"],
    from: to,
    to: [from],
    body: "a",
    occurredAt: nowIso(),
  }
  const rows = associatedReplies(
    [
      { ...base, id: "b", internetId: "<b@t>", references: ["<a@t>"] },
      base,
      { ...base, id: "c", internetId: "<c@t>", references: [] },
      { ...base, id: "d", internetId: "<d@t>", from: "attacker@example.test" },
    ],
    new Set(["<root@t>"]),
    from,
    to
  )
  assert.deepEqual(rows.map((m) => m.id).sort(), ["a", "b"])
  assert.ok(
    mimeEmail(from, {
      id: "id",
      internetId: "<id@test>",
      to,
      subject: "Hello\nBcc: bad",
      body: "test",
    }).includes("Subject: =?UTF-8?B?")
  )
})

test("missing or changed contact email blocks composition and queued delivery", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  await db().execute(
    "UPDATE deals SET contact_email_cipher=NULL WHERE id='email-deal'"
  )
  assert.equal((await emailContext(rep, "email-deal")).recipient, null)
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "blocked"
  )
})

test("transient OAuth refresh failures keep the account ready and defer the send", async () => {
  const id = await sender()
  await db()
    .prepare("UPDATE mca_email_senders SET credential_cipher=? WHERE id=?")
    .run(
      encryptSenderCredential(ws, {
        kind: "oauth",
        accessToken: "old",
        refreshToken: "refresh",
        email: from,
        expiresAt: "2000-01-01",
        scope: GOOGLE_SENDER_SCOPES.join(" "),
      }),
      id
    )
  setSenderOAuthFetchForTests(async () => Response.json({}, { status: 503 }))
  const q = await queueEmail(rep, input(id))
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "queued"
  )
  assert.equal((await findSenderById(ws, id))?.state, "verified")
})
test("explicit failed retry preserves message identity and refuses unknown sends", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  await db()
    .prepare("UPDATE mca_email_messages SET state='failed' WHERE id=?")
    .run(q.id)
  const retried = await retryEmail(rep, q.id)
  assert.equal(retried.id, q.id)
  assert.equal(retried.state, "queued")
  await assert.rejects(() => retryEmail(other, q.id))
  await db()
    .prepare("UPDATE mca_email_messages SET state='unknown' WHERE id=?")
    .run(q.id)
  await assert.rejects(() => retryEmail(rep, q.id), {
    code: "email_delivery_pending",
  })
})
test("an active worker lease is not stolen; expired sending work becomes unknown", async () => {
  const id = await sender(),
    q = await queueEmail(rep, input(id))
  await db()
    .prepare("UPDATE mca_email_messages SET state='sending' WHERE id=?")
    .run(q.id)
  await db()
    .prepare(
      "INSERT INTO mca_email_worker_leases(sender_id,workspace_id,token,expires_at) VALUES(?,?,'active','2099-01-01')"
    )
    .run(id, ws)
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "sending"
  )
  await db()
    .prepare(
      "UPDATE mca_email_worker_leases SET expires_at='2000-01-01' WHERE sender_id=?"
    )
    .run(id)
  await runMessagingWorkerOnce()
  assert.equal(calls, 0)
  assert.equal(
    (await emailMessages(rep, q.conversationId)).messages[0].state,
    "unknown"
  )
})
test("conversation pagination follows recent activity without leaking denied deals", async () => {
  const id = await sender()
  for (let i = 0; i < 28; i++) await queueEmail(rep, input(id))
  const first = await listEmailConversations(rep),
    second = await listEmailConversations(rep, undefined, first.nextCursor!)
  assert.equal(first.conversations.length, 25)
  assert.equal(second.conversations.length, 3)
  assert.equal(
    new Set([...first.conversations, ...second.conversations].map((c) => c.id))
      .size,
    28
  )
  assert.equal((await listEmailConversations(other)).conversations.length, 0)
  await assert.rejects(() => listEmailConversations(rep, undefined, "bad"), {
    code: "email_cursor_invalid",
  })
})
