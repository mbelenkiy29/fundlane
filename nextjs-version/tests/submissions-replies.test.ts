import "./helpers/business-auth";
import { queueWithSyntheticApproval as queueSubmissions } from "./helpers/broker-submission-preview"
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import { closeDatabaseForTests, getDatabase } from "../src/lib/mca/db"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { storeDocument } from "../src/lib/mca/documents/service"
import { setDocumentScannerForTests, type DocumentScanner } from "../src/lib/mca/documents/scanner"
import { setDocumentStorageForTests, type DocumentStorage } from "../src/lib/mca/documents/storage"
import { createFunder } from "../src/lib/mca/funders/directory"
import { createSender } from "../src/lib/mca/senders/service"
import { encryptSenderCredential } from "../src/lib/mca/senders/repository"
import { setEmailProviderFetchForTests } from "../src/lib/mca/email-conversations/providers"
import { parseEmailAttemptRef } from "../src/lib/mca/submissions/email-templates"
import { setSubmissionCompletenessForTests } from "../src/lib/mca/submissions/queue"
import {
  REPLY_INGEST_INTERVAL_MS,
  setReplyMailboxForTests,
  type MailboxMessage,
  type ReplyMailbox,
} from "../src/lib/mca/submissions/replies"
import { GET as repliesGet } from "../src/app/api/mca/submissions/replies/route"
import { POST as repliesRun } from "../src/app/api/mca/submissions/replies/run/route"
import { GET as replyGet, PATCH as replyPatch } from "../src/app/api/mca/submissions/replies/[id]/route"
import { POST as reconcileEmail } from "../src/app/api/mca/submissions/email/reconcile/route"

let testDatabase: Awaited<ReturnType<typeof createPostgresTestDatabase>>

const SMTP_PASSWORD = "smtp-replies-password-never-leak"
const ids = {
  workspace: "workspace-replies",
  otherWorkspace: "workspace-replies-other",
  adminUser: "replies-admin-user",
  adminMember: "replies-admin-member",
  repUser: "replies-rep-user",
  repMember: "replies-rep-member",
  otherUser: "replies-other-user",
  otherMember: "replies-other-member",
}

const actor = (workspaceId = ids.workspace, role: Role | null = "admin"): DealActor => {
  const membershipId = workspaceId === ids.otherWorkspace ? ids.otherMember : role === "rep" ? ids.repMember : ids.adminMember
  return {
    workspaceId,
    userId: workspaceId === ids.otherWorkspace ? ids.otherUser : role === "rep" ? ids.repUser : ids.adminUser,
    membershipId,
    role,
    managedMembershipIds: [],
    activeMembershipIds: workspaceId === ids.otherWorkspace ? [ids.otherMember] : [ids.adminMember, ids.repMember],
    source: role ? "user" : "api_key",
    correlationId: `corr-${workspaceId}-${role ?? "key"}`,
  }
}

const memory = new Map<string, Uint8Array>()
const storage: DocumentStorage = {
  name: "test-memory",
  async putImmutable(key, bytes) {
    if (memory.has(key)) throw new Error("duplicate storage key")
    memory.set(key, new Uint8Array(bytes))
  },
  async get(key) {
    const value = memory.get(key)
    if (!value) throw new Error("missing storage key")
    return new Uint8Array(value)
  },
}
const scanner: DocumentScanner = {
  name: "fixture-clean",
  async scan() {
    return { status: "clean", provider: "fixture-clean", evidence: { engineVerified: true } }
  },
}

const minimalPdf = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"))

let senderId = ""
let alphaFunderId = ""
let betaFunderId = ""
let dealCounter = 0

type MailboxSpy = {
  list: number
  mutations: string[]
  messages: MailboxMessage[]
}

function fixtureMailbox(spy: MailboxSpy): ReplyMailbox {
  return {
    async listMessages() {
      spy.list += 1
      return { messages: spy.messages, nextCursor: spy.messages.at(-1)?.providerMessageId ?? "empty" }
    },
    async markRead(id) { spy.mutations.push(`markRead:${id}`) },
    async markUnread(id) { spy.mutations.push(`markUnread:${id}`) },
    async addLabel(id, label) { spy.mutations.push(`addLabel:${id}:${label}`) },
    async removeLabel(id, label) { spy.mutations.push(`removeLabel:${id}:${label}`) },
    async deleteMessage(id) { spy.mutations.push(`delete:${id}`) },
    async move(id) { spy.mutations.push(`move:${id}`) },
    async archive(id) { spy.mutations.push(`archive:${id}`) },
  }
}

async function seed() {
  const database = getDatabase()
  const now = new Date().toISOString()
  const visibility = JSON.stringify({ dashboard: true, deals: true, users: true, reports: true, payments: true, workspace: true, integrations: true })
  const actions = JSON.stringify({ createDeal: true, exportDeals: true, inviteUsers: true, manageApiKeys: true, viewPaymentTable: true, viewCompanyFinancials: true })
  const flags = JSON.stringify({ reports: true, payments: true, workspace: true, integrations: true })
  for (const [id, name] of [[ids.workspace, "Replies Test"], [ids.otherWorkspace, "Other Workspace"]] as const) {
    await database.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?, ?, 'America/New_York', 5, ?, ?, ?, ?, ?)`).run(id, name, flags, visibility, actions, now, now)
  }
  for (const [userId, memberId, email, workspaceId, role] of [
    [ids.adminUser, ids.adminMember, "replies-admin@example.test", ids.workspace, "admin"],
    [ids.repUser, ids.repMember, "replies-rep@example.test", ids.workspace, "rep"],
    [ids.otherUser, ids.otherMember, "replies-other@example.test", ids.otherWorkspace, "admin"],
  ] as const) {
    await database.prepare(`INSERT INTO users (id,email,password_hash,name,phone,application_identifier,created_at,updated_at)
      VALUES (?, ?, NULL, ?, NULL, ?, ?, ?)`).run(userId, email, email, `APP-${userId.slice(-6)}`, now, now)
    await database.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,sender_association,created_at,updated_at)
      VALUES (?, ?, ?, ?, NULL, 'active', NULL, ?, ?)`).run(memberId, workspaceId, userId, role, now, now)
  }
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("replies-admin-session", ids.adminUser, ids.adminMember, hashOpaqueToken("admin-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("replies-rep-session", ids.repUser, ids.repMember, hashOpaqueToken("rep-session-token"), now, now)
  await database.prepare(`INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at)
    VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run("replies-other-session", ids.otherUser, ids.otherMember, hashOpaqueToken("other-session-token"), now, now)
  const addKey = async (id: string, secret: string, scopes: string[], workspaceId: string) => {
    await database.prepare(`INSERT INTO api_keys
      (id,workspace_id,name,prefix,secret_hash,scopes,expires_at,last_used_at,revoked_at,rate_limit_per_minute,created_by,created_at)
      VALUES (?, ?, ?, 'mca_test', ?, ?, NULL, NULL, NULL, 60, ?, ?)`).run(id, workspaceId, id, hashOpaqueToken(`mca_${secret}`), JSON.stringify(scopes), ids.adminUser, now)
  }
  await addKey("replies-intake-key", "intake-secret", ["intake:write"], ids.workspace)
  await addKey("replies-read-key", "read-secret", ["deals:read"], ids.workspace)
  await addKey("replies-write-key", "write-secret", ["deals:write"], ids.workspace)
}

before(async () => {
  testDatabase = await createPostgresTestDatabase("submissions_replies")
  Object.assign(process.env, testDatabase.env())
  delete process.env.MCA_DOCUMENT_SCANNER
  delete process.env.MCA_BACKGROUND_JOBS
  delete process.env.VERCEL
  delete process.env.MCA_EMAIL_WEBHOOK_URL
  setDocumentStorageForTests(storage)
  setDocumentScannerForTests(scanner)
  setSubmissionCompletenessForTests(true)
  await seed()
  const sender = await createSender(actor(), {
    provider: "smtp",
    purpose: "submission",
    fromName: "Broker Desk",
    fromAddress: "broker@example.test",
    signature: "Best,\nBroker Desk",
    isDefault: true,
    smtp: { host: "smtp.example.test", port: 587, username: "broker", password: SMTP_PASSWORD },
  })
  senderId = sender.id
  await getDatabase().prepare("UPDATE mca_email_senders SET state='verified',verified_at=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(), sender.workspaceId, sender.id)
  alphaFunderId = (await createFunder(actor(), {
    idempotencyKey: "alpha-replies-funder",
    legalName: "Alpha Capital LLC",
    nickname: "Alpha",
    domains: ["alpha-replies.example.test"],
    routes: [{ kind: "email", label: "Alpha inbox", destination: "submissions@alpha-replies.example.test", documentExceptions: [], active: true }],
  })).funder.id
  betaFunderId = (await createFunder(actor(), {
    idempotencyKey: "beta-replies-funder",
    legalName: "Beta Funding Inc",
    nickname: "Beta",
    domains: ["beta-replies.example.test"],
    routes: [{ kind: "email", label: "Beta inbox", destination: "beta@funders.example.test", documentExceptions: [], active: true }],
  })).funder.id
})

after(async () => {
  setReplyMailboxForTests()
  setEmailProviderFetchForTests()
  setSubmissionCompletenessForTests()
  setDocumentStorageForTests()
  setDocumentScannerForTests()
  await closeDatabaseForTests()
  await testDatabase.close()
})

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

function assertNoSecret(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SMTP_PASSWORD), false)
  assert.equal(text.includes("credentialCipher"), false)
  assert.equal(text.includes("credential_cipher"), false)
  assert.equal(text.includes("body_cipher"), false)
}

async function seedDeal(name: string) {
  dealCounter += 1
  const deal = (await createDeal(actor(), {
    idempotencyKey: `replies-deal-${dealCounter}`,
    legalName: name,
    requestedAmount: 80_000,
    assignments: [
      { membershipId: ids.repMember, kind: "originator", isPrimary: true },
      { membershipId: ids.adminMember, kind: "closer", isPrimary: true },
    ],
  })).deal
  await storeDocument(actor(), {
    dealId: deal.id,
    idempotencyKey: `replies-doc-${dealCounter}`,
    filename: "statement.pdf",
    mimeType: "application/pdf",
    bytes: minimalPdf,
    category: "statement",
    source: "test",
  })
  return deal
}

async function sendTo(dealId: string, funderId: string) {
  const queued = await queueSubmissions({
    actor: actor(),
    dealId,
    funderIds: [funderId],
    confirmationKey: `replies-send-${dealId}-${funderId}`,
  })
  assert.equal(queued.jobs[0]?.state, "sent")
  const attempt = await getDatabase().prepare<{ external_ref: string | null }>(
    "SELECT external_ref FROM mca_submission_attempts WHERE job_id = ?",
  ).get(queued.jobs[0]!.jobId)
  const ref = parseEmailAttemptRef(attempt?.external_ref)
  assert.ok(ref?.messageId)
  return { jobId: queued.jobs[0]!.jobId, ref }
}

type QueueBody = {
  intervalMs: number
  mailbox: { mode: string; liveOAuth: boolean }
  senders: Array<{ senderId: string; optedIn: boolean; health: string }>
  replies: Array<{
    id: string
    providerMessageId: string
    fromAddress: string
    subject?: string
    bodyPreview?: string
    body?: string
    matchedDealId?: string
    matchedJobId?: string
    state: string
    replayed: boolean
    evidence: {
      method: string
      flagsUnchanged: boolean
      fromDomain?: string
      notes: string[]
      subjectHits?: string[]
      candidateDealIds?: string[]
      candidateJobIds?: string[]
    }
  }>
}

type RunBody = {
  intervalMs: number
  mailbox: { flagsUnchanged: boolean; mode: string }
  ingested: Array<{ id: string; providerMessageId: string; state: string; created: boolean; replayed: boolean }>
  createdCount: number
  replayedCount: number
}

test("MIC-149: separate-thread reply is linked with evidence, replay is idempotent, and mailbox flags stay unchanged", async () => {
  assert.equal(REPLY_INGEST_INTERVAL_MS, 15 * 60 * 1000)
  const deal = await seedDeal("Separate Thread Merchant LLC")
  const sent = await sendTo(deal.id, alphaFunderId)
  const spy: MailboxSpy = {
    list: 0,
    mutations: [],
    messages: [{
      providerMessageId: "alpha-separate-1",
      threadId: "gmail-thread-unrelated",
      rfcMessageId: "<reply-separate@alpha-replies.example.test>",
      from: "Underwriting <uw@alpha-replies.example.test>",
      subject: `Offer update for ${deal.displayId}`,
      body: `We can fund Separate Thread Merchant LLC. Ref ${deal.displayId}.`,
    }],
  }
  setReplyMailboxForTests(fixtureMailbox(spy))

  const missingOptIn = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId }),
  }))
  assert.equal(missingOptIn.status, 422)

  const first = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId, enabled: true }),
  }))
  assert.equal(first.status, 200)
  const firstBody = await first.json() as RunBody
  assert.equal(firstBody.intervalMs, REPLY_INGEST_INTERVAL_MS)
  assert.equal(firstBody.mailbox.flagsUnchanged, true)
  assert.equal(firstBody.mailbox.mode, "fixture")
  assert.equal(firstBody.createdCount, 1)
  assert.equal(firstBody.replayedCount, 0)
  assert.equal(firstBody.ingested[0]?.state, "matched")
  assert.equal(firstBody.ingested[0]?.providerMessageId, "alpha-separate-1")
  assertNoSecret(firstBody)
  const replyId = firstBody.ingested[0]!.id

  const queued = await repliesGet(cookieRequest(`/api/mca/submissions/replies?dealId=${deal.id}`, "admin-session-token"))
  assert.equal(queued.status, 200)
  const queueBody = await queued.json() as QueueBody
  assert.equal(queueBody.intervalMs, 900000)
  assert.equal(queueBody.replies.length, 1)
  const reply = queueBody.replies[0]!
  assert.equal(reply.id, replyId)
  assert.equal(reply.state, "matched")
  assert.equal(reply.matchedDealId, deal.id)
  assert.equal(reply.matchedJobId, sent.jobId)
  assert.equal(reply.evidence.method, "domain")
  assert.equal(reply.evidence.flagsUnchanged, true)
  assert.equal(reply.evidence.fromDomain, "alpha-replies.example.test")
  assert.equal(reply.evidence.subjectHits?.includes("displayId"), true)
  assert.equal(reply.evidence.notes.some((note) => /Message-ID|thread id/i.test(note)), true)
  assert.equal(reply.evidence.notes.some((note) => /authorized alias/i.test(note)), true)
  assert.equal(reply.subject?.includes(deal.displayId), true)
  assert.equal(Boolean(reply.body), false)
  assert.match(reply.bodyPreview ?? "", /Separate Thread Merchant/)
  assertNoSecret(queueBody)

  const detail = await replyGet(cookieRequest(`/api/mca/submissions/replies/${replyId}`, "admin-session-token"), {
    params: Promise.resolve({ id: replyId }),
  })
  assert.equal(detail.status, 200)
  const detailBody = await detail.json() as { body?: string; matchedJobId?: string }
  assert.match(detailBody.body ?? "", /We can fund Separate Thread Merchant LLC/)
  assert.equal(detailBody.matchedJobId, sent.jobId)
  assertNoSecret(detailBody)

  const replay = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId }),
  }))
  assert.equal(replay.status, 200)
  const replayBody = await replay.json() as RunBody
  assert.equal(replayBody.createdCount, 0)
  assert.equal(replayBody.replayedCount, 1)
  assert.equal(replayBody.ingested[0]?.id, replyId)
  assert.equal(replayBody.ingested[0]?.replayed, true)
  assert.equal(replayBody.mailbox.flagsUnchanged, true)

  const count = await getDatabase().prepare<{ count: number }>(
    "SELECT count(*)::int AS count FROM mca_funder_replies WHERE workspace_id = ? AND provider_message_id = ?",
  ).get(ids.workspace, "alpha-separate-1")
  assert.equal(count?.count, 1)
  assert.equal(spy.list, 2)
  assert.deepEqual(spy.mutations, [])
  assert.equal(sent.ref.threadId !== spy.messages[0]?.threadId, true)
})

test("flagged Google and Microsoft inbox reads ingest replies without mailbox writes", async () => {
  const priorFlag = process.env.MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED
  const row = await getDatabase().prepare<{ provider: string; credential_cipher: string }>("SELECT provider, credential_cipher FROM mca_email_senders WHERE id = ?").get(senderId)
  assert.ok(row)
  const deal = await seedDeal("OAuth Reply Merchant LLC")
  const sent = await sendTo(deal.id, alphaFunderId)
  const calls: Array<{ url: string; method: string }> = []
  setReplyMailboxForTests()
  process.env.MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED = "true"
  try {
    for (const provider of ["google", "microsoft"] as const) {
      const scope = provider === "google"
        ? "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"
        : "Mail.Read Mail.Send"
      await getDatabase().prepare("UPDATE mca_email_senders SET provider = ?, credential_cipher = ? WHERE id = ?").run(
        provider, encryptSenderCredential(ids.workspace, { kind: "oauth", accessToken: "synthetic-token", refreshToken: "synthetic-refresh", expiresAt: "2099-01-01T00:00:00.000Z", scope, email: "broker@example.test" }), senderId)
      const providerId = `${provider}-reply-fixture`
      setEmailProviderFetchForTests(async (input, init) => {
        const url = String(input)
        calls.push({ url, method: init?.method ?? "GET" })
        if (provider === "google") {
          if (url.includes("format=full")) return Response.json({ id: providerId, threadId: `${provider}-thread`, internalDate: String(Date.now()), payload: { mimeType: "text/plain", headers: [
            { name: "Message-ID", value: `<${providerId}@example.test>` }, { name: "From", value: "uw@alpha-replies.example.test" },
            { name: "Subject", value: `Offer update ${deal.displayId}` }, { name: "In-Reply-To", value: sent.ref.messageId },
          ], body: { data: Buffer.from("Controlled reply").toString("base64url") } } })
          return Response.json({ messages: [{ id: providerId }] })
        }
        return Response.json({ value: [{ id: providerId, conversationId: `${provider}-thread`, internetMessageId: `<${providerId}@example.test>`,
          internetMessageHeaders: [{ name: "In-Reply-To", value: sent.ref.messageId }], from: { emailAddress: { address: "uw@alpha-replies.example.test" } },
          subject: `Offer update ${deal.displayId}`, body: { content: "Controlled reply", contentType: "text" }, receivedDateTime: new Date().toISOString() }] })
      })
      const response = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", { method: "POST", body: JSON.stringify({ senderId, enabled: true }) }))
      assert.equal(response.status, 200)
      const body = await response.json() as RunBody
      assert.equal(body.mailbox.mode, "live")
      assert.equal(body.createdCount, 1)
      assert.equal(body.ingested[0]?.providerMessageId, providerId)
      const replay = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", { method: "POST", body: JSON.stringify({ senderId }) }))
      assert.equal((await replay.json() as RunBody).replayedCount, 1)
    }
    await getDatabase().prepare("UPDATE mca_email_senders SET credential_cipher = ? WHERE id = ?").run(
      encryptSenderCredential(ids.workspace, { kind: "oauth", accessToken: "synthetic-token", refreshToken: "synthetic-refresh", expiresAt: "2099-01-01T00:00:00.000Z", scope: "Mail.Send", email: "broker@example.test" }), senderId)
    const missingRead = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", { method: "POST", body: JSON.stringify({ senderId }) }))
    assert.equal(missingRead.status, 409)
    assert.equal((await missingRead.json() as { error: { code: string } }).error.code, "email_reconnect_required")
    await getDatabase().prepare("UPDATE mca_email_senders SET state = 'expired' WHERE id = ?").run(senderId)
    const expired = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", { method: "POST", body: JSON.stringify({ senderId }) }))
    assert.equal(expired.status, 409)
    assert.equal((await expired.json() as { error: { code: string } }).error.code, "sender_expired")
    assert.equal(calls.every(call => call.method === "GET"), true)
    assert.equal(calls.some(call => call.url.includes("/messages/send") || call.url.includes("sendMail")), false)
  } finally {
    await getDatabase().prepare("UPDATE mca_email_senders SET provider = ?, credential_cipher = ?, state = 'verified' WHERE id = ?").run(row.provider, row.credential_cipher, senderId)
    setEmailProviderFetchForTests()
    if (priorFlag === undefined) delete process.env.MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED
    else process.env.MCA_FUNDER_REPLY_LIVE_INGEST_ENABLED = priorFlag
  }
})

test("email reconciliation endpoint requires a workspace administrator", async () => {
  const prior = process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
  process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = "true"
  try {
    const path = "/api/mca/submissions/email/reconcile"
    const body = JSON.stringify({ jobId: "missing-job", outcome: "accepted", evidence: "fixture receipt" })
    const denied = await reconcileEmail(cookieRequest(path, "rep-session-token", { method: "POST", body }))
    assert.equal(denied.status, 403)
    const scoped = await reconcileEmail(cookieRequest(path, "admin-session-token", { method: "POST", body }))
    assert.equal(scoped.status, 404)
  } finally {
    if (prior === undefined) delete process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED
    else process.env.MCA_FUNDER_UNKNOWN_SEND_GUARD_ENABLED = prior
  }
})

test("MIC-149: ambiguous and unrecognized replies go to pending_review, intake is 403, and secrets stay out of JSON", async () => {
  const first = await seedDeal("Ambiguous One LLC")
  const second = await seedDeal("Ambiguous Two LLC")
  const sentFirst = await sendTo(first.id, alphaFunderId)
  const sentSecond = await sendTo(second.id, alphaFunderId)
  assert.ok(sentFirst.jobId !== sentSecond.jobId)

  const spy: MailboxSpy = {
    list: 0,
    mutations: [],
    messages: [
      {
        providerMessageId: "alpha-ambiguous-1",
        threadId: "thread-generic",
        from: "desk@alpha-replies.example.test",
        subject: "Re: your submission",
        body: "Please advise.",
      },
      {
        providerMessageId: "unknown-1",
        threadId: "thread-unknown",
        from: "noreply@not-a-funder.example.test",
        subject: `Offer for ${first.displayId}`,
        body: "Unrelated mailbox noise.",
      },
    ],
  }
  setReplyMailboxForTests(fixtureMailbox(spy))

  const run = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId, enabled: true }),
  }))
  assert.equal(run.status, 200)
  const runBody = await run.json() as RunBody
  const ambiguous = runBody.ingested.find((item) => item.providerMessageId === "alpha-ambiguous-1")
  const unknown = runBody.ingested.find((item) => item.providerMessageId === "unknown-1")
  assert.equal(ambiguous?.state, "pending_review")
  assert.equal(unknown?.state, "pending_review")
  assert.deepEqual(spy.mutations, [])

  const listed = await repliesGet(cookieRequest(`/api/mca/submissions/replies?dealId=${first.id}`, "admin-session-token"))
  const listedBody = await listed.json() as QueueBody
  const ambiguousRow = listedBody.replies.find((item) => item.providerMessageId === "alpha-ambiguous-1")
  const unknownRow = listedBody.replies.find((item) => item.providerMessageId === "unknown-1")
  assert.ok(ambiguousRow)
  assert.equal(unknownRow, undefined)
  assert.equal(ambiguousRow.evidence.method, "ambiguous")
  assert.equal(ambiguousRow.evidence.candidateDealIds?.includes(first.id), true)
  assert.equal(ambiguousRow.evidence.candidateDealIds?.includes(second.id), true)
  assert.equal(ambiguousRow.matchedDealId, undefined)

  const unknownQueue = await repliesGet(cookieRequest("/api/mca/submissions/replies", "admin-session-token"))
  const unknownBody = await unknownQueue.json() as QueueBody
  const unknownListed = unknownBody.replies.find((item) => item.providerMessageId === "unknown-1")
  assert.equal(unknownListed?.evidence.method, "unrecognized")
  assertNoSecret(unknownBody)

  const linked = await replyPatch(cookieRequest(`/api/mca/submissions/replies/${ambiguous?.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ state: "matched", matchedJobId: sentFirst.jobId, matchedDealId: first.id }),
  }), { params: Promise.resolve({ id: ambiguous!.id }) })
  assert.equal(linked.status, 200)
  const linkedBody = await linked.json() as { id: string; state: string; matchedDealId?: string; matchedJobId?: string; evidence: { method: string } }
  assert.equal(linkedBody.id, ambiguous?.id)
  assert.equal(linkedBody.state, "matched")
  assert.equal(linkedBody.matchedDealId, first.id)
  assert.equal(linkedBody.matchedJobId, sentFirst.jobId)

  const invalid = await replyPatch(cookieRequest(`/api/mca/submissions/replies/${unknown?.id}`, "admin-session-token", {
    method: "PATCH",
    body: JSON.stringify({ state: "matched" }),
  }), { params: Promise.resolve({ id: unknown!.id }) })
  assert.equal(invalid.status, 422)

  const intakeRun = await repliesRun(bearerRequest("/api/mca/submissions/replies/run", "intake-secret", {
    method: "POST",
    body: JSON.stringify({ senderId, enabled: true }),
  }))
  assert.equal(intakeRun.status, 403)

  const intakeGet = await repliesGet(bearerRequest("/api/mca/submissions/replies", "intake-secret"))
  assert.equal(intakeGet.status, 403)

  const readGet = await repliesGet(bearerRequest(`/api/mca/submissions/replies?dealId=${first.id}`, "read-secret"))
  assert.equal(readGet.status, 200)
  assertNoSecret(await readGet.json())

  const readPatch = await replyPatch(bearerRequest(`/api/mca/submissions/replies/${unknown?.id}`, "read-secret", {
    method: "PATCH",
    body: JSON.stringify({ state: "ignored" }),
  }), { params: Promise.resolve({ id: unknown!.id }) })
  assert.equal(readPatch.status, 403)

  const writePatch = await replyPatch(bearerRequest(`/api/mca/submissions/replies/${unknown?.id}`, "write-secret", {
    method: "PATCH",
    body: JSON.stringify({ state: "ignored" }),
  }), { params: Promise.resolve({ id: unknown!.id }) })
  assert.equal(writePatch.status, 200)
  assert.equal((await writePatch.json() as { state: string }).state, "ignored")

  const cross = await repliesGet(cookieRequest(`/api/mca/submissions/replies?dealId=${first.id}`, "other-session-token"))
  assert.equal(cross.status, 404)

  setReplyMailboxForTests()
  const unconfigured = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId }),
  }))
  assert.equal(unconfigured.status, 503)
  assert.equal((await unconfigured.json() as { error: { code: string } }).error.code, "mailbox_oauth_not_configured")

  const badJson = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: "{",
  }))
  assert.equal(badJson.status, 400)

  assert.ok(betaFunderId)
})

test("unique-domain reply with zero subject hits stays pending_review", async () => {
  const gammaFunderId = (await createFunder(actor(), {
    idempotencyKey: "gamma-replies-funder-zero-hit",
    legalName: "Gamma Capital LLC",
    nickname: "Gamma",
    domains: ["gamma-replies.example.test"],
    routes: [{ kind: "email", label: "Gamma inbox", destination: "submissions@gamma-replies.example.test", documentExceptions: [], active: true }],
  })).funder.id
  const deal = await seedDeal("Unique Domain Zero Hit LLC")
  const sent = await sendTo(deal.id, gammaFunderId)
  const spy: MailboxSpy = {
    list: 0,
    mutations: [],
    messages: [{
      providerMessageId: "gamma-unique-domain-zero-hit",
      threadId: "gmail-thread-zero-hit",
      rfcMessageId: "<reply-zero-hit@gamma-replies.example.test>",
      from: "Underwriting <uw@gamma-replies.example.test>",
      subject: "Checking in",
      body: "Any update on the file?",
    }],
  }
  setReplyMailboxForTests(fixtureMailbox(spy))

  const run = await repliesRun(cookieRequest("/api/mca/submissions/replies/run", "admin-session-token", {
    method: "POST",
    body: JSON.stringify({ senderId, enabled: true }),
  }))
  assert.equal(run.status, 200)
  const runBody = await run.json() as RunBody
  const ingested = runBody.ingested.find((item) => item.providerMessageId === "gamma-unique-domain-zero-hit")
  assert.equal(ingested?.state, "pending_review")

  const queued = await repliesGet(cookieRequest(`/api/mca/submissions/replies?dealId=${deal.id}`, "admin-session-token"))
  assert.equal(queued.status, 200)
  const queueBody = await queued.json() as QueueBody
  const reply = queueBody.replies.find((item) => item.providerMessageId === "gamma-unique-domain-zero-hit")
  assert.ok(reply)
  assert.equal(reply.state, "pending_review")
  assert.equal(reply.matchedDealId, undefined)
  assert.equal(reply.matchedJobId, undefined)
  assert.equal(reply.evidence.subjectHits?.length ?? 0, 0)
  assert.equal(reply.evidence.candidateJobIds?.includes(sent.jobId), true)
  assert.equal(reply.evidence.candidateDealIds?.includes(deal.id), true)
  assert.equal(spy.mutations.length, 0)
})
