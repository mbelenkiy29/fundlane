import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { SmsAccount, SmsAdapterSendInput } from "../../src/lib/mca/sms/contracts"
import {
  EXPIRED_TEXTTORRENT_SECRET,
  FIXTURE_BODY,
  FIXTURE_CHAT_ID,
  FIXTURE_EXISTING_RECIPIENT,
  FIXTURE_RECIPIENT,
  FIXTURE_REJECTED_NUMBER,
  FIXTURE_SENDER,
  FIXTURE_TIMEOUT_NUMBER,
  SYNTHETIC_API_KEY,
  SYNTHETIC_API_SECRET,
  TEXTTORRENT_CAPABILITIES,
  TEXTTORRENT_FIXTURE_TRANSPORT,
  TEXTTORRENT_SLUG,
  createTextTorrentSmsAdapter,
  createTextTorrentSmsTransport,
  listTextTorrentFixtureExternalIds,
  peekTextTorrentFixture,
  resetTextTorrentFixtures,
  texttorrentCreateChatUrl,
  texttorrentFixtureFetch,
  texttorrentFixtureSendCallCount,
  texttorrentInboxUrl,
  texttorrentResultContainsSecret,
  texttorrentSendUrl,
  texttorrentSmsAdapter,
  toReceiverNumber,
} from "../../src/lib/mca/sms/adapters/texttorrent"

const now = "2026-09-08T12:00:00.000Z"

const account: SmsAccount = {
  id: "acc-texttorrent-1",
  workspaceId: "ws-texttorrent",
  provider: "texttorrent",
  label: "TextTorrent Direct",
  senderKind: "phone_number",
  senderMasked: "•••0999",
  credentialRef: "TEXTTORRENT",
  state: "active",
  isDefault: true,
  memberIds: ["member-texttorrent"],
  providerConfigured: true,
  createdAt: now,
  updatedAt: now,
}

function credentials(overrides: Record<string, string> = {}) {
  return { apiKey: SYNTHETIC_API_KEY, apiSecret: SYNTHETIC_API_SECRET, sendingNumber: FIXTURE_SENDER, ...overrides }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account,
    idempotencyKey: "sms-row-texttorrent",
    senderKind: "phone_number",
    senderIdentity: FIXTURE_SENDER,
    recipient: FIXTURE_RECIPIENT,
    body: FIXTURE_BODY,
    statusCallbackUrl: "https://sms.example.test/callback",
    correlationId: "corr-texttorrent-1",
    credentials: credentials(),
    ...overrides,
  }
}

function assertNoSecrets(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(serialized.includes(SYNTHETIC_API_SECRET), false)
  assert.equal(serialized.includes(EXPIRED_TEXTTORRENT_SECRET), false)
  assert.equal(texttorrentResultContainsSecret(value, SYNTHETIC_API_SECRET), false)
}

beforeEach(() => {
  resetTextTorrentFixtures()
})

test("MIC-187: required-field rejection for API key, secret, and sending number", () => {
  const empty = texttorrentSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.apiKey, "Enter the TextTorrent API key.")
  assert.equal(empty.fields.apiSecret, "Enter the TextTorrent API secret.")
  assert.equal(empty.fields.sendingNumber, "Enter a sending number in E.164 format.")
  assert.equal("provider" in empty.fields, false)

  const invalidPhone = texttorrentSmsAdapter.validate({
    apiKey: SYNTHETIC_API_KEY,
    apiSecret: SYNTHETIC_API_SECRET,
    sendingNumber: "2125550999",
  })
  assert.equal(invalidPhone.ok, false)
  if (invalidPhone.ok) throw new Error("expected sending number error")
  assert.equal(invalidPhone.fields.sendingNumber, "Enter a sending number in E.164 format.")

  const alias = texttorrentSmsAdapter.validate({
    apiSid: SYNTHETIC_API_KEY,
    publicKey: SYNTHETIC_API_SECRET,
    fromNumber: FIXTURE_SENDER,
  })
  assert.equal(alias.ok, true)
  assert.deepEqual(texttorrentSmsAdapter.validate(credentials()), { ok: true })
})

test("MIC-187: capability flags match the implemented adapter", async () => {
  assert.equal(texttorrentSmsAdapter.slug, TEXTTORRENT_SLUG)
  assert.deepEqual(texttorrentSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: false,
    inbound: false,
    optOut: false,
  })
  assert.deepEqual(TEXTTORRENT_CAPABILITIES, texttorrentSmsAdapter.capabilities)
  assert.equal(texttorrentSmsAdapter.parseStatus, undefined)
  assert.equal(texttorrentSmsAdapter.parseInbound, undefined)
  assert.equal(TEXTTORRENT_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  assert.deepEqual(await texttorrentSmsAdapter.testConnection(account), { ok: true })
  assert.deepEqual(await texttorrentSmsAdapter.testConnection({ ...account, providerConfigured: false }), { ok: false, code: "texttorrent_unconfigured" })
})

test("MIC-187: accepted send follows the public create-chat and inbox send contract", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; json?: Record<string, unknown>; form?: Record<string, string> }> = []
  const adapter = createTextTorrentSmsAdapter({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      const url = String(input)
      const entry: (typeof requests)[number] = { url, method: String(init?.method), headers }
      if (typeof init?.body === "string") entry.json = JSON.parse(init.body) as Record<string, unknown>
      if (init?.body instanceof FormData) {
        const form: Record<string, string> = {}
        init.body.forEach((value, key) => {
          if (typeof value === "string") form[key] = value
        })
        entry.form = form
      }
      requests.push(entry)
      return texttorrentFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(typeof result.externalId, "string")
  assert.ok(result.externalId)
  assert.equal(result.providerStatus, "sent")
  assertNoSecrets(result)

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, texttorrentCreateChatUrl())
  assert.equal(requests[0].method, "POST")
  assert.equal(requests[0].headers.get("X-API-SID"), SYNTHETIC_API_KEY)
  assert.equal(requests[0].headers.get("X-API-PUBLIC-KEY"), SYNTHETIC_API_SECRET)
  assert.deepEqual(requests[0].json, {
    receiver_number: toReceiverNumber(FIXTURE_RECIPIENT),
    sender_id: FIXTURE_SENDER,
  })
  assert.equal(requests[1].url, texttorrentSendUrl())
  assert.equal(requests[1].method, "POST")
  assert.deepEqual(requests[1].form, {
    message: FIXTURE_BODY,
    chat_id: String(FIXTURE_CHAT_ID),
    from_number: FIXTURE_SENDER,
    to_number: FIXTURE_RECIPIENT,
  })
  assert.equal(JSON.stringify(requests[1].form).includes(SYNTHETIC_API_SECRET), false)

  const replay = await adapter.send(sendInput())
  assert.equal(replay.state, "accepted")
  assert.equal(replay.externalId, result.externalId)
  assert.equal(requests.length, 2)
  assert.deepEqual(listTextTorrentFixtureExternalIds(), [result.externalId])
  assert.equal(peekTextTorrentFixture("corr-texttorrent-1")?.sendCalls, 1)
  assert.equal(texttorrentFixtureSendCallCount(), 1)
})

test("MIC-187: rejected-number fails closed without leaking the recipient or body", async () => {
  const adapter = createTextTorrentSmsAdapter()
  const result = await adapter.send(sendInput({ recipient: FIXTURE_REJECTED_NUMBER, correlationId: "corr-rejected" }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "texttorrent_invalid_number")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(FIXTURE_REJECTED_NUMBER), false)
  assert.equal(result.errorMessage?.includes(FIXTURE_BODY), false)
  assertNoSecrets(result)

  const replay = await adapter.send(sendInput({ recipient: FIXTURE_REJECTED_NUMBER, correlationId: "corr-rejected" }))
  assert.equal(replay.state, "failed")
  assert.equal(replay.errorCode, result.errorCode)
  assert.equal(peekTextTorrentFixture("corr-rejected")?.sendCalls, 1)
})

test("MIC-187: timeout and unconfigured credentials do not invent a second external id", async () => {
  const adapter = createTextTorrentSmsAdapter()
  const missing = await adapter.send(sendInput({ credentials: {}, correlationId: "corr-unconfigured" }))
  assert.equal(missing.state, "failed")
  assert.equal(missing.errorCode, "texttorrent_unconfigured")
  assert.equal(missing.externalId, undefined)
  assertNoSecrets(missing)

  const unconfiguredReplay = await adapter.send(sendInput({
    correlationId: "corr-unconfigured",
    credentials: credentials(),
  }))
  assert.deepEqual(unconfiguredReplay, missing)

  const expired = await adapter.send(sendInput({ credentials: credentials({ apiSecret: EXPIRED_TEXTTORRENT_SECRET }), correlationId: "corr-expired" }))
  assert.equal(expired.state, "failed")
  assert.equal(expired.errorCode, "texttorrent_unauthorized")
  assert.equal(expired.externalId, undefined)
  assertNoSecrets(expired)

  const timedOut = await adapter.send(sendInput({ recipient: FIXTURE_TIMEOUT_NUMBER, correlationId: "corr-timeout", body: "Synthetic timeout preview" }))
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.errorCode, "provider_outcome_unknown")
  assert.equal(timedOut.externalId, undefined)

  const timeoutReplay = await adapter.send(sendInput({ recipient: FIXTURE_TIMEOUT_NUMBER, correlationId: "corr-timeout", body: "Must not create a second TextTorrent message" }))
  assert.deepEqual(timeoutReplay, timedOut)
  assert.equal(timeoutReplay.externalId, undefined)
  assert.equal(peekTextTorrentFixture("corr-timeout")?.sendCalls, 1)
})

test("MIC-187: retried status callback is skipped because delivery webhooks are undocumented", () => {
  assert.equal(texttorrentSmsAdapter.capabilities.statusCallbacks, false)
  assert.equal(texttorrentSmsAdapter.parseStatus, undefined)
})

test("MIC-187: existing chat looks up inbox then sends without inventing a second identity", async () => {
  const requests: string[] = []
  const adapter = createTextTorrentSmsAdapter({
    fetchImpl: async (input, init) => {
      requests.push(`${String(init?.method)} ${String(input)}`)
      return texttorrentFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput({ recipient: FIXTURE_EXISTING_RECIPIENT, correlationId: "corr-existing" }))
  assert.equal(result.state, "accepted")
  assert.ok(result.externalId)
  assert.equal(requests[0], `POST ${texttorrentCreateChatUrl()}`)
  assert.equal(requests[1], `GET ${texttorrentInboxUrl(FIXTURE_EXISTING_RECIPIENT)}`)
  assert.equal(requests[2], `POST ${texttorrentSendUrl()}`)

  const replay = await adapter.send(sendInput({ recipient: FIXTURE_EXISTING_RECIPIENT, correlationId: "corr-existing" }))
  assert.equal(replay.externalId, result.externalId)
  assert.equal(requests.length, 3)
})

test("MIC-187: extracted transport keeps the documented request contract behind injected fetch", async () => {
  const sendForm: Record<string, string> = {}
  const adapter = createTextTorrentSmsAdapter({
    fetchImpl: async (input, init) => {
      if (String(input) === texttorrentSendUrl() && init?.body instanceof FormData) {
        init.body.forEach((value, key) => {
          if (typeof value === "string") sendForm[key] = value
        })
      }
      return texttorrentFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput({ correlationId: "corr-http" }))
  assert.equal(result.state, "accepted")
  assert.equal(sendForm.chat_id, String(FIXTURE_CHAT_ID))
  assert.equal(sendForm.from_number, FIXTURE_SENDER)
  assert.equal(sendForm.to_number, FIXTURE_RECIPIENT)
  assert.equal(sendForm.message, FIXTURE_BODY)
  assertNoSecrets(result)
  assertNoSecrets(sendForm)

  const timedOut = await createTextTorrentSmsTransport({
    timeoutMs: 20,
    fetchImpl: (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
    }),
  }).send(sendInput({ correlationId: "corr-timeout-http" }))
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.externalId, undefined)
})
