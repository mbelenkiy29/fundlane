import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import vm from "node:vm"

// Execute the provider implementation, with synthetic credentials, database and
// HTTP boundaries. This needs no npm package and never contacts a provider.
function mailboxFixture(provider = "google", requestMs = 1000, messageCount = 5) {
  let clock = Date.parse("2026-10-02T20:00:00.000Z")
  const started = clock
  const requests = []
  const allIds = Array.from({ length: messageCount }, (_, index) => ["one", "two", "three", "four", "five"][index] ?? `message-${index}`)
  class ClockDate extends Date { static now() { return clock } }
  class AppError extends Error {
    constructor(status, code, message) { super(message); Object.assign(this, { status, code }) }
  }
  const sender = { id: "sender", workspaceId: "synthetic", provider, state: "verified", credentialCipher: "synthetic" }
  const context = vm.createContext({
    Date: ClockDate, Buffer, URL, URLSearchParams, AbortSignal, AppError,
    nowIso: () => new Date(clock).toISOString(),
    getDatabase: () => ({ prepare: () => ({ run: async () => ({ changes: 1 }) }) }),
    senderConversationReady: () => true,
    decryptSenderCredential: () => ({ kind: "oauth", accessToken: "synthetic", expiresAt: "2099-01-01T00:00:00.000Z" }),
    encryptSenderCredential: () => "synthetic",
    refreshSenderCredential: async () => { throw new Error("Unexpected refresh") },
    findSenderById: async () => sender,
    assertCompanyOperational: async () => {},
    assertExecutionActive: () => {}, executionSignal: () => undefined, executionRemainingMs: () => undefined,
  })
  const source = readFileSync(new URL("../src/lib/mca/email-conversations/providers.ts", import.meta.url), "utf8")
    .replace('(await import("../company-access")).assertCompanyOperational', "assertCompanyOperational")
  const js = stripTypeScriptTypes(source, { mode: "transform" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")
  vm.runInContext(js, context, { filename: "email-conversations/providers.ts" })
  const fetcher = async input => {
    const url = new URL(input)
    requests.push(url)
    clock += requestMs
    if (provider === "google") {
      if (url.pathname.endsWith("/messages")) {
        const offset = Number(url.searchParams.get("pageToken") ?? 0)
        const size = Number(url.searchParams.get("maxResults"))
        const ids = allIds.slice(offset, offset + size)
        return Response.json({ messages: ids.map(id => ({ id })), ...(offset + ids.length < allIds.length ? { nextPageToken: String(offset + ids.length) } : {}) })
      }
      return Response.json({ id: url.pathname.split("/").at(-1), threadId: "thread", internalDate: String(started - 5000), payload: { headers: [{ name: "From", value: "funder@example.test" }] } })
    }
    if (url.pathname.includes("/me/messages/")) return Response.json({ id: url.pathname.split("/").at(-1), conversationId: "thread", receivedDateTime: new Date(started - 5000).toISOString() })
    const offset = Number(url.searchParams.get("offset") ?? 0)
    const size = Number(url.searchParams.get("$top"))
    const ids = allIds.slice(offset, offset + size)
    const next = new URL(url); next.searchParams.set("offset", String(offset + ids.length))
    return Response.json({ value: ids.map(id => ({ id, conversationId: "thread", internetMessageId: `<${id}@example.test>`, receivedDateTime: new Date(started - 5000).toISOString() })), ...(offset + ids.length < allIds.length ? { "@odata.nextLink": next.href } : {}) })
  }
  context.setEmailProviderFetchForTests(fetcher)
  const Mailbox = vm.runInContext("Mailbox", context)
  return { mailbox: new Mailbox(sender), context, requests, started, now: () => clock, advance: ms => { clock += ms } }
}

test("Microsoft manual page100 resumes at scheduled limit2 without changing the opaque nextLink or losing messages", async () => {
  const f = mailboxFixture("microsoft", 1, 205)
  await f.mailbox.connect()
  const manual = await f.mailbox.listInboxSince(undefined, { messageLimit: 100, deadlineMs: f.now() + 20_000 })
  assert.equal(manual.messages.length, 100)
  let cursor = manual.nextCursor
  const ids = manual.messages.map(message => message.id)
  for (let pass = 0; pass < 100; pass++) {
    const scheduled = await f.mailbox.listInboxSince(cursor, { messageLimit: 2, deadlineMs: f.now() + 20_000 })
    assert.ok(scheduled.messages.length <= 2)
    ids.push(...scheduled.messages.map(message => message.id))
    cursor = scheduled.nextCursor
    if (scheduled.complete) break
    const pending = JSON.parse(cursor).pending ?? []
    assert.ok(pending.length <= 100)
    assert.ok(pending.every(id => typeof id === "string" && !id.includes("body")))
  }
  assert.equal(ids.length, 205)
  assert.equal(new Set(ids).size, 205)
  assert.equal(cursor, new Date(f.started).toISOString())
  const listRequests = f.requests.filter(url => url.pathname.includes("mailFolders/inbox/messages"))
  assert.equal(listRequests.length, 3)
  assert.ok(listRequests.every(url => url.searchParams.get("$top") === "100"))
})

for (const provider of ["google", "microsoft"]) {
  test(`${provider}: bounded inbox pages resume all messages without advancing past pending work`, async () => {
    const f = mailboxFixture(provider)
    await f.mailbox.connect()
    let cursor
    const ids = []
    for (let pass = 0; pass < 5; pass++) {
      const result = await f.mailbox.listInboxSince(cursor, { messageLimit: 2, deadlineMs: f.now() + 20_000 })
      assert.ok(result.messages.length <= 2, "each slice must honor the requested message cap")
      ids.push(...result.messages.map(message => message.id))
      cursor = result.nextCursor
      if (result.complete) break
      assert.ok(!Number.isFinite(Date.parse(cursor)), "partial work must retain a resumable cursor")
    }
    assert.deepEqual(ids, ["one", "two", "three", "four", "five"])
    assert.equal(cursor, new Date(f.started).toISOString(), "completion advances only to the original scan boundary")
    assert.ok(f.requests.every(url => ["gmail.googleapis.com", "graph.microsoft.com"].includes(url.hostname)))
  })
}

test("an expired inbox budget performs no provider request and retains its cursor", async () => {
  const f = mailboxFixture()
  await f.mailbox.connect()
  const cursor = new Date(f.started - 60_000).toISOString()
  const result = await f.mailbox.listInboxSince(cursor, { messageLimit: 2, deadlineMs: f.now() - 1 })
  assert.equal(f.requests.length, 0)
  assert.equal(result.nextCursor, cursor)
  assert.equal(result.complete, false)
})

test("deadline after a Gmail list retains unfetched IDs for the next slice", async () => {
  const f = mailboxFixture("google", 2000)
  await f.mailbox.connect()
  const partial = await f.mailbox.listInboxSince(undefined, { messageLimit: 2, deadlineMs: f.now() + 2500 })
  assert.equal(partial.messages.length, 0)
  assert.equal(f.requests.length, 1)
  const resumed = await f.mailbox.listInboxSince(partial.nextCursor, { messageLimit: 2, deadlineMs: f.now() + 20_000 })
  assert.deepEqual(Array.from(resumed.messages, message => message.id), ["one", "two"])
  assert.equal(f.requests.filter(url => url.pathname.endsWith("/messages")).length, 1, "resume must reuse the listed IDs")
})

test("mailbox response-body cancellation retains the execution-expired outcome", { timeout: 1000 }, async () => {
  const f = mailboxFixture(), controller = new AbortController()
  f.context.executionSignal = () => controller.signal
  f.context.assertExecutionActive = () => { if (controller.signal.aborted) { const error = new Error("Synthetic expired slice"); error.code = "execution_expired"; throw error } }
  let bodyStarted
  const entered = new Promise(resolve => { bodyStarted = resolve })
  f.context.setEmailProviderFetchForTests(async (_url, init) => ({ ok: true, status: 200, json: () => {
    bodyStarted()
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }))
  } }))
  await f.mailbox.connect()
  const pending = f.mailbox.listInboxSince(undefined, { messageLimit: 2, deadlineMs: f.now() + 20_000 })
  await entered
  const rejected = assert.rejects(pending, error => error.code === "execution_expired")
  controller.abort()
  await rejected
})

for (const provider of ["google", "microsoft"]) {
  test(`${provider}: deleted retained IDs retire without pinning later messages; authentication errors remain retryable`, async () => {
    const f = mailboxFixture(provider)
    await f.mailbox.connect()
    const cursor = JSON.stringify({ kind: "fundlane:inbox:v1", provider, since: f.started - 60_000, until: f.started, listed: true, pending: ["gone", "kept"] })
    let calls = 0
    f.context.setEmailProviderFetchForTests(async url => {
      calls++
      if (new URL(url).pathname.includes("/gone")) return new Response("", { status: 404 })
      return Response.json(provider === "google" ? { id: "kept", payload: { headers: [] } } : { id: "kept" })
    })
    const resumed = await f.mailbox.listInboxSince(cursor, { messageLimit: 2, deadlineMs: f.now() + 20_000 })
    assert.equal(calls, 2)
    assert.deepEqual(Array.from(resumed.messages, message => message.id), ["kept"])
    assert.equal(resumed.complete, true)
    assert.equal(resumed.nextCursor, new Date(f.started).toISOString())
    f.context.setEmailProviderFetchForTests(async () => new Response("", { status: 403 }))
    await assert.rejects(f.mailbox.listInboxSince(cursor, { messageLimit: 2, deadlineMs: f.now() + 20_000 }), error => error.status === 403)
    assert.deepEqual(JSON.parse(cursor).pending, ["gone", "kept"])
  })
}
