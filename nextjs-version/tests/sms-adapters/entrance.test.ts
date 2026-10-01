import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import type { SmsAccount, SmsAdapterSendInput } from "../../src/lib/mca/sms/contracts"
import {
  ENTRANCE_CAPABILITIES,
  ENTRANCE_FIXTURE_TRANSPORT,
  ENTRANCE_SLUG,
  EXPIRED_ENTRANCE_SECRET,
  FIXTURE_BODY,
  FIXTURE_CHANNEL_ID,
  FIXTURE_INBOUND_FROM,
  FIXTURE_INBOUND_MESSAGE_ID,
  FIXTURE_RECIPIENT,
  FIXTURE_REJECTED_NUMBER,
  FIXTURE_SENDER,
  FIXTURE_TIMEOUT_NUMBER,
  FIXTURE_WORKSPACE_ID,
  SYNTHETIC_API_SECRET,
  SYNTHETIC_LOGIN_EMAIL,
  createEntranceSmsAdapter,
  entranceFixtureFetch,
  entranceFixtureSendCallCount,
  entranceLoginUrl,
  entranceMessagesUrl,
  entranceSmsAdapter,
  fixtureInboundPayload,
  listEntranceFixtureExternalIds,
  peekEntranceFixture,
  resetEntranceFixtures,
} from "../../src/lib/mca/sms/adapters/entrance"

const now = "2026-09-08T12:00:00.000Z"

const account: SmsAccount = {
  id: "acc-entrance-1",
  workspaceId: "ws-entrance",
  provider: "entrance",
  label: "Entrance Direct",
  senderKind: "phone_number",
  senderMasked: "•••0999",
  credentialRef: "ENTRANCE",
  state: "active",
  isDefault: true,
  memberIds: ["member-entrance"],
  providerConfigured: true,
  createdAt: now,
  updatedAt: now,
}

function credentials(overrides: Record<string, string> = {}) {
  return { loginEmail: SYNTHETIC_LOGIN_EMAIL, apiSecret: SYNTHETIC_API_SECRET, ...overrides }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account,
    idempotencyKey: "sms-row-entrance",
    senderKind: "phone_number",
    senderIdentity: String(FIXTURE_CHANNEL_ID),
    recipient: FIXTURE_RECIPIENT,
    body: FIXTURE_BODY,
    statusCallbackUrl: "https://sms.example.test/callback",
    correlationId: "corr-entrance-1",
    credentials: credentials(),
    ...overrides,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(SYNTHETIC_API_SECRET), false)
  assert.equal(text.includes(EXPIRED_ENTRANCE_SECRET), false)
}

beforeEach(() => {
  resetEntranceFixtures()
})

test("MIC-185: required-field rejection for login email and API secret", () => {
  const empty = entranceSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.loginEmail, "Enter the Entrance customer login email.")
  assert.equal(empty.fields.apiSecret, "Enter the Entrance API secret or password.")

  const invalidEmail = entranceSmsAdapter.validate({ loginEmail: "not-an-email", apiSecret: SYNTHETIC_API_SECRET })
  assert.equal(invalidEmail.ok, false)
  if (invalidEmail.ok) throw new Error("expected email error")
  assert.equal(invalidEmail.fields.loginEmail, "Enter a valid Entrance customer login email.")

  const alias = entranceSmsAdapter.validate({ email: SYNTHETIC_LOGIN_EMAIL, password: SYNTHETIC_API_SECRET })
  assert.equal(alias.ok, true)
  assert.deepEqual(entranceSmsAdapter.validate(credentials()), { ok: true })
})

test("MIC-185: capability flags match the implemented adapter", async () => {
  assert.equal(entranceSmsAdapter.slug, ENTRANCE_SLUG)
  assert.deepEqual(entranceSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: false,
    inbound: true,
    optOut: true,
  })
  assert.deepEqual(ENTRANCE_CAPABILITIES, entranceSmsAdapter.capabilities)
  assert.equal(entranceSmsAdapter.parseStatus, undefined)
  assert.equal(typeof entranceSmsAdapter.parseInbound, "function")
  assert.equal(ENTRANCE_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  assert.deepEqual(await entranceSmsAdapter.testConnection(account), { ok: true })
  assert.deepEqual(await entranceSmsAdapter.testConnection({ ...account, providerConfigured: false }), { ok: false, code: "entrance_unconfigured" })
})

test("MIC-185: accepted send follows the public login and messages contract", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = []
  const adapter = createEntranceSmsAdapter({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url: String(input), method: String(init?.method), headers, body })
      return entranceFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(typeof result.externalId, "string")
  assert.ok(result.externalId)
  assert.equal(result.providerStatus, "queued")
  assertNoSecrets(result)

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, entranceLoginUrl())
  assert.equal(requests[0].method, "POST")
  assert.deepEqual(requests[0].body, { email: SYNTHETIC_LOGIN_EMAIL, password: SYNTHETIC_API_SECRET })
  assert.equal(requests[0].headers.get("authorization"), null)
  assert.equal(requests[1].url, entranceMessagesUrl(FIXTURE_WORKSPACE_ID))
  assert.equal(requests[1].method, "POST")
  assert.match(requests[1].headers.get("authorization") ?? "", /^Bearer /)
  assert.deepEqual(requests[1].body, { channel_id: FIXTURE_CHANNEL_ID, message: FIXTURE_BODY, number: FIXTURE_RECIPIENT })
  assert.equal(JSON.stringify(requests[1].body).includes(SYNTHETIC_API_SECRET), false)

  const replay = await adapter.send(sendInput())
  assert.equal(replay.state, "accepted")
  assert.equal(replay.externalId, result.externalId)
  assert.equal(requests.length, 2)
  assert.deepEqual(listEntranceFixtureExternalIds(), [result.externalId])
  assert.equal(peekEntranceFixture("corr-entrance-1")?.sendCalls, 1)
  assert.equal(entranceFixtureSendCallCount(), 1)
})

test("MIC-185: rejected-number fails closed without leaking the recipient or body", async () => {
  const adapter = createEntranceSmsAdapter()
  const result = await adapter.send(sendInput({ recipient: FIXTURE_REJECTED_NUMBER, correlationId: "corr-rejected" }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "entrance_invalid_number")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(FIXTURE_REJECTED_NUMBER), false)
  assert.equal(result.errorMessage?.includes(FIXTURE_BODY), false)
  assertNoSecrets(result)

  const replay = await adapter.send(sendInput({ recipient: FIXTURE_REJECTED_NUMBER, correlationId: "corr-rejected" }))
  assert.equal(replay.state, "failed")
  assert.equal(replay.errorCode, result.errorCode)
  assert.equal(peekEntranceFixture("corr-rejected")?.sendCalls, 1)
})

test("MIC-185: timeout and unconfigured credentials do not invent a second external id", async () => {
  const adapter = createEntranceSmsAdapter()
  const missing = await adapter.send(sendInput({ credentials: {}, correlationId: "corr-unconfigured" }))
  assert.equal(missing.state, "failed")
  assert.equal(missing.errorCode, "entrance_unconfigured")
  assert.equal(missing.externalId, undefined)
  assertNoSecrets(missing)

  const expired = await adapter.send(sendInput({ credentials: credentials({ apiSecret: EXPIRED_ENTRANCE_SECRET }), correlationId: "corr-expired" }))
  assert.equal(expired.state, "failed")
  assert.equal(expired.errorCode, "entrance_unauthorized")
  assert.equal(expired.externalId, undefined)
  assertNoSecrets(expired)

  const timedOut = await adapter.send(sendInput({ recipient: FIXTURE_TIMEOUT_NUMBER, correlationId: "corr-timeout", body: "Synthetic timeout preview" }))
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.errorCode, "provider_outcome_unknown")
  assert.equal(timedOut.externalId, undefined)

  const recovered = await adapter.send(sendInput({ recipient: FIXTURE_TIMEOUT_NUMBER, correlationId: "corr-timeout", body: "Synthetic timeout preview" }))
  assert.equal(recovered.state, "accepted")
  assert.ok(recovered.externalId)
  assert.deepEqual(listEntranceFixtureExternalIds(), [recovered.externalId])

  const replay = await adapter.send(sendInput({ recipient: FIXTURE_TIMEOUT_NUMBER, correlationId: "corr-timeout", body: "Synthetic timeout preview" }))
  assert.equal(replay.externalId, recovered.externalId)
  assert.equal(peekEntranceFixture("corr-timeout")?.sendCalls, 2)
})

test("MIC-185: inbound START/STOP map to opt-in/opt-out; delivery status callbacks are undocumented", async () => {
  const start = await entranceSmsAdapter.parseInbound!({}, fixtureInboundPayload("start"))
  assert.equal("ignored" in start, false)
  if ("ignored" in start) throw new Error("expected start opt-in")
  assert.equal(start.kind, "opt_in")
  assert.equal(start.recipient, FIXTURE_INBOUND_FROM)
  assert.equal(start.providerMessageId, FIXTURE_INBOUND_MESSAGE_ID)
  assert.equal(start.body, "start")

  const stop = await entranceSmsAdapter.parseInbound!({}, fixtureInboundPayload("STOP"))
  assert.equal("ignored" in stop, false)
  if ("ignored" in stop) throw new Error("expected stop opt-out")
  assert.equal(stop.kind, "opt_out")
  assert.equal(stop.recipient, FIXTURE_INBOUND_FROM)

  const inbound = await entranceSmsAdapter.parseInbound!({}, fixtureInboundPayload("start2"))
  assert.equal("ignored" in inbound, false)
  if ("ignored" in inbound) throw new Error("expected inbound message")
  assert.equal(inbound.kind, "message")
  assert.equal(inbound.body, "start2")

  const ignored = await entranceSmsAdapter.parseInbound!({}, { data: { payload: { direction: "outbound", text: "queued" } } })
  assert.deepEqual(ignored, { ignored: true })
  assert.equal(entranceSmsAdapter.parseStatus, undefined)
  assert.equal(entranceSmsAdapter.capabilities.statusCallbacks, false)
})

test("MIC-185: phone sender omits undocumented channel_id and keeps secrets out of the send result", async () => {
  let sendBody: Record<string, unknown> = {}
  const adapter = createEntranceSmsAdapter({
    fetchImpl: async (input, init) => {
      if (String(input) === entranceMessagesUrl(FIXTURE_WORKSPACE_ID)) {
        sendBody = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
      }
      return entranceFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput({ senderIdentity: FIXTURE_SENDER, correlationId: "corr-phone" }))
  assert.equal(result.state, "accepted")
  assert.deepEqual(sendBody, { message: FIXTURE_BODY, number: FIXTURE_RECIPIENT })
  assert.equal(Object.prototype.hasOwnProperty.call(sendBody, "channel_id"), false)
  assertNoSecrets(result)
  assertNoSecrets(sendBody)
})
