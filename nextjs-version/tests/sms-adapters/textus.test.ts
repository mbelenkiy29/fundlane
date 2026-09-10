import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { AppError } from "../../src/lib/mca/errors"
import type { SmsAccount, SmsAdapterSendInput, SmsAdapterStatus } from "../../src/lib/mca/sms/contracts"
import {
  EXPIRED_TEXTUS_API_KEY,
  TEXTUS_CAPABILITIES,
  TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
  TEXTUS_FIXTURE_ACCOUNT_EMAIL,
  TEXTUS_FIXTURE_API_KEY,
  TEXTUS_FIXTURE_BODY,
  TEXTUS_FIXTURE_CREDENTIALS,
  TEXTUS_FIXTURE_DELIVERY_ID,
  TEXTUS_FIXTURE_INBOUND_FROM,
  TEXTUS_FIXTURE_INBOUND_MESSAGE_ID,
  TEXTUS_FIXTURE_MESSAGE_ID,
  TEXTUS_FIXTURE_REJECTED_RECIPIENT,
  TEXTUS_FIXTURE_SENDER,
  TEXTUS_FIXTURE_TIMEOUT_RECIPIENT,
  TEXTUS_FIXTURE_TRANSPORT,
  TEXTUS_FIXTURE_WEBHOOK_SECRET,
  TEXTUS_JSONLD,
  TEXTUS_SLUG,
  createTextusSmsAdapter,
  createTextusSmsTransport,
  mapSendBody,
  resetTextusAdapterState,
  textusFixtureFetch,
  textusFixtureMessageId,
  textusInboundFixture,
  textusMessagesUrl,
  textusOptInFixture,
  textusOptOutFixture,
  textusResultContainsSecret,
  textusSmsAdapter,
  textusStatusCallbackFixture,
  validateTextusSignature,
} from "../../src/lib/mca/sms/adapters/textus"

const now = "2026-09-08T12:00:00.000Z"

function account(overrides: Partial<SmsAccount> = {}): SmsAccount {
  return {
    id: "sms-account-textus",
    workspaceId: "ws-textus",
    provider: "textus",
    label: "TextUs fixture",
    senderKind: "phone_number",
    senderMasked: "•••0999",
    credentialRef: "TEXTUS",
    state: "active",
    isDefault: true,
    memberIds: ["member-textus"],
    providerConfigured: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account: account(),
    senderKind: "phone_number",
    senderIdentity: TEXTUS_FIXTURE_SENDER,
    recipient: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
    body: TEXTUS_FIXTURE_BODY,
    statusCallbackUrl: "https://sms.example.test/api/mca/sms/webhooks/textus/sms-account-textus/status?messageId=msg-textus-1",
    correlationId: "corr-textus-1",
    credentials: { ...TEXTUS_FIXTURE_CREDENTIALS },
    ...overrides,
  }
}

beforeEach(() => {
  resetTextusAdapterState()
})

test("MIC-188: required-field rejection covers account email and API key", () => {
  const empty = textusSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.accountEmail, "Enter the TextUs account email.")
  assert.equal(empty.fields.apiKey, "Enter the TextUs API key.")
  assert.equal("provider" in empty.fields, false)
  assert.equal("sendingNumber" in empty.fields, false)

  const invalidEmail = textusSmsAdapter.validate({ accountEmail: "not-an-email", apiKey: TEXTUS_FIXTURE_API_KEY })
  assert.equal(invalidEmail.ok, false)
  if (invalidEmail.ok) throw new Error("expected email error")
  assert.equal(invalidEmail.fields.accountEmail, "Enter a valid TextUs account email.")

  const emptyWebhook = textusSmsAdapter.validate({
    ...TEXTUS_FIXTURE_CREDENTIALS,
    webhookSecret: "   ",
  })
  assert.equal(emptyWebhook.ok, false)
  if (emptyWebhook.ok) throw new Error("expected webhook secret error")
  assert.equal(emptyWebhook.fields.webhookSecret, "Enter the TextUs webhook secret used to validate callbacks.")

  const alias = textusSmsAdapter.validate({ email: TEXTUS_FIXTURE_ACCOUNT_EMAIL, token: TEXTUS_FIXTURE_API_KEY })
  assert.deepEqual(alias, { ok: true })
  assert.deepEqual(textusSmsAdapter.validate(TEXTUS_FIXTURE_CREDENTIALS), { ok: true })
})

test("MIC-188: accepted send returns a stable message identity and does not call a live provider", async () => {
  assert.equal(TEXTUS_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  const result = await textusSmsAdapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(result.providerStatus, "queued")
  assert.equal(result.externalId, textusFixtureMessageId("corr-textus-1"))
  assert.match(result.externalId ?? "", /^\/messages\/[A-Za-z0-9_-]{4,64}$/)
  assert.equal(textusResultContainsSecret(result, TEXTUS_FIXTURE_API_KEY), false)
  assert.equal(textusResultContainsSecret(result, TEXTUS_FIXTURE_WEBHOOK_SECRET), false)
  assert.equal(result.errorMessage?.includes(TEXTUS_FIXTURE_ACCEPTED_RECIPIENT) ?? false, false)

  const replay = await textusSmsAdapter.send(sendInput())
  assert.deepEqual(replay, result)

  const second = await textusSmsAdapter.send(sendInput({ correlationId: "corr-textus-2", body: "Second synthetic preview" }))
  assert.equal(second.state, "accepted")
  assert.notEqual(second.externalId, result.externalId)
})

test("MIC-188: rejected-number is a sanitized TextUs failure", async () => {
  const result = await textusSmsAdapter.send(sendInput({
    recipient: TEXTUS_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-textus-rejected",
    body: `Bad ${TEXTUS_FIXTURE_REJECTED_RECIPIENT}: ${TEXTUS_FIXTURE_BODY}`,
  }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "textus_invalid_number")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(TEXTUS_FIXTURE_REJECTED_RECIPIENT), false)
  assert.equal(result.errorMessage?.includes(TEXTUS_FIXTURE_BODY), false)
  assert.equal(textusResultContainsSecret(result, TEXTUS_FIXTURE_API_KEY), false)

  const replay = await textusSmsAdapter.send(sendInput({
    recipient: TEXTUS_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-textus-rejected",
  }))
  assert.deepEqual(replay, result)
})

test("MIC-188: timeout and unconfigured credential fail closed without inventing an external id", async () => {
  const timeout = await textusSmsAdapter.send(sendInput({
    recipient: TEXTUS_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-textus-timeout",
  }))
  assert.equal(timeout.state, "unknown")
  assert.equal(timeout.errorCode, "provider_outcome_unknown")
  assert.equal(timeout.externalId, undefined)
  const timeoutReplay = await textusSmsAdapter.send(sendInput({
    recipient: TEXTUS_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-textus-timeout",
    body: "Must not create a second TextUs message",
  }))
  assert.deepEqual(timeoutReplay, timeout)
  assert.equal(timeoutReplay.externalId, undefined)

  const unconfigured = await textusSmsAdapter.send(sendInput({
    correlationId: "corr-textus-unconfigured",
    credentials: {},
  }))
  assert.equal(unconfigured.state, "failed")
  assert.equal(unconfigured.errorCode, "textus_unconfigured")
  assert.equal(unconfigured.externalId, undefined)
  const unconfiguredReplay = await textusSmsAdapter.send(sendInput({
    correlationId: "corr-textus-unconfigured",
    credentials: { accountEmail: TEXTUS_FIXTURE_ACCOUNT_EMAIL, apiKey: TEXTUS_FIXTURE_API_KEY },
  }))
  assert.deepEqual(unconfiguredReplay, unconfigured)

  assert.deepEqual(await textusSmsAdapter.testConnection(account()), { ok: true })
  assert.deepEqual(await textusSmsAdapter.testConnection(account({ providerConfigured: false })), { ok: false, code: "textus_unconfigured" })
})

test("MIC-188: retried status callback updates the existing message without a duplicate row", async () => {
  assert.equal(typeof textusSmsAdapter.parseStatus, "function")
  const rows = new Map<string, { providerStatus: string; eventKeys: Set<string> }>()
  function apply(status: SmsAdapterStatus) {
    const current = rows.get(status.providerMessageId) ?? { providerStatus: "queued", eventKeys: new Set<string>() }
    if (current.eventKeys.has(status.eventKey)) return { duplicate: true, row: current }
    current.eventKeys.add(status.eventKey)
    current.providerStatus = status.providerStatus
    rows.set(status.providerMessageId, current)
    return { duplicate: false, row: current }
  }

  const deliveredBody = textusStatusCallbackFixture()
  const first = await textusSmsAdapter.parseStatus!({}, deliveredBody)
  assert.equal(first.providerMessageId, TEXTUS_FIXTURE_MESSAGE_ID)
  assert.equal(first.providerStatus, "delivered")
  assert.equal(first.recipient, TEXTUS_FIXTURE_ACCEPTED_RECIPIENT)
  assert.equal(first.eventKey, TEXTUS_FIXTURE_DELIVERY_ID)
  assert.equal(apply(first).duplicate, false)

  const replay = await textusSmsAdapter.parseStatus!({}, {
    action: "message.delivered",
    id: TEXTUS_FIXTURE_DELIVERY_ID,
    conversation: { phoneNumber: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT, accountPhoneNumber: TEXTUS_FIXTURE_SENDER },
    message: { id: TEXTUS_FIXTURE_MESSAGE_ID, deliveryState: "delivered", status: "delivered" },
  })
  assert.equal(replay.eventKey, first.eventKey)
  assert.equal(apply(replay).duplicate, true)
  assert.equal(rows.size, 1)

  const failed = await textusSmsAdapter.parseStatus!({}, textusStatusCallbackFixture({
    action: "message.failed",
    id: "/integrations/LmKXZl/deliveries/failed-1",
    message: { id: TEXTUS_FIXTURE_MESSAGE_ID, deliveryState: "failed", status: "failed" },
  }))
  assert.notEqual(failed.eventKey, first.eventKey)
  assert.equal(failed.providerMessageId, TEXTUS_FIXTURE_MESSAGE_ID)
  assert.equal(failed.providerStatus, "failed")
  assert.equal(apply(failed).duplicate, false)
  assert.equal(rows.size, 1)
  assert.equal(rows.get(TEXTUS_FIXTURE_MESSAGE_ID)?.eventKeys.size, 2)
  assert.equal(rows.get(TEXTUS_FIXTURE_MESSAGE_ID)?.providerStatus, "failed")

  await assert.rejects(
    () => textusSmsAdapter.parseStatus!({}, textusStatusCallbackFixture({ action: "message.received" })),
    (error: unknown) => error instanceof AppError && error.code === "textus_status_unsupported",
  )
})

test("MIC-188: capability flags match TextUs send, delivery webhooks, inbound, and opt-out", async () => {
  assert.equal(textusSmsAdapter.slug, TEXTUS_SLUG)
  assert.deepEqual(textusSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: true,
    inbound: true,
    optOut: true,
  })
  assert.deepEqual(TEXTUS_CAPABILITIES, textusSmsAdapter.capabilities)
  assert.equal(typeof textusSmsAdapter.parseStatus, "function")
  assert.equal(typeof textusSmsAdapter.parseInbound, "function")

  const inbound = await textusSmsAdapter.parseInbound!({}, textusInboundFixture())
  assert.equal("ignored" in inbound, false)
  if ("ignored" in inbound) throw new Error("expected inbound message")
  assert.equal(inbound.kind, "message")
  assert.equal(inbound.recipient, TEXTUS_FIXTURE_INBOUND_FROM)
  assert.equal(inbound.providerMessageId, TEXTUS_FIXTURE_INBOUND_MESSAGE_ID)

  const stop = await textusSmsAdapter.parseInbound!({}, textusOptOutFixture())
  if ("ignored" in stop) throw new Error("expected contact.opted_out")
  assert.equal(stop.kind, "opt_out")
  assert.equal(stop.recipient, TEXTUS_FIXTURE_INBOUND_FROM)

  const start = await textusSmsAdapter.parseInbound!({}, textusOptInFixture())
  if ("ignored" in start) throw new Error("expected contact.opted_in")
  assert.equal(start.kind, "opt_in")

  const keywordStop = await textusSmsAdapter.parseInbound!({}, textusInboundFixture({
    message: { id: TEXTUS_FIXTURE_INBOUND_MESSAGE_ID, direction: "in", body: "STOP" },
  }))
  if ("ignored" in keywordStop) throw new Error("expected STOP opt-out")
  assert.equal(keywordStop.kind, "opt_out")

  assert.deepEqual(await textusSmsAdapter.parseInbound!({}, textusStatusCallbackFixture()), { ignored: true })
})

test("MIC-188: extracted transport keeps the documented send-without-account contract behind injected fetch", async () => {
  let requestBody = ""
  let requestUrl = ""
  let requestHeaders: Headers | undefined
  const adapter = createTextusSmsAdapter({
    fetchImpl: async (input, init) => {
      requestUrl = String(input)
      requestHeaders = new Headers(init?.headers)
      requestBody = String(init?.body)
      assert.equal(init?.method, "POST")
      return textusFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput({ correlationId: "corr-textus-http" }))
  assert.equal(result.state, "accepted")
  assert.equal(requestUrl, textusMessagesUrl())
  assert.equal(requestHeaders?.get("accept"), TEXTUS_JSONLD)
  assert.equal(requestHeaders?.get("content-type"), TEXTUS_JSONLD)
  assert.equal(requestHeaders?.get("authorization"), `Bearer ${TEXTUS_FIXTURE_API_KEY}`)
  const posted = JSON.parse(requestBody) as Record<string, unknown>
  assert.deepEqual(posted, {
    email: TEXTUS_FIXTURE_ACCOUNT_EMAIL,
    to: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
    body: TEXTUS_FIXTURE_BODY,
    from: TEXTUS_FIXTURE_SENDER,
  })
  assert.equal(Object.prototype.hasOwnProperty.call(posted, "statusCallbackUrl"), false)
  assert.equal(JSON.stringify(posted).includes(TEXTUS_FIXTURE_API_KEY), false)

  const replay = await adapter.send(sendInput({ correlationId: "corr-textus-http" }))
  assert.deepEqual(replay, result)

  const withoutFrom = mapSendBody({
    accountEmail: TEXTUS_FIXTURE_ACCOUNT_EMAIL,
    senderIdentity: "messaging-account",
    recipient: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
    body: TEXTUS_FIXTURE_BODY,
  })
  assert.deepEqual(withoutFrom, {
    email: TEXTUS_FIXTURE_ACCOUNT_EMAIL,
    to: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
    body: TEXTUS_FIXTURE_BODY,
  })

  const unauthorized = await createTextusSmsAdapter({ fetchImpl: textusFixtureFetch }).send(sendInput({
    correlationId: "corr-textus-expired",
    credentials: { accountEmail: TEXTUS_FIXTURE_ACCOUNT_EMAIL, apiKey: EXPIRED_TEXTUS_API_KEY },
  }))
  assert.equal(unauthorized.state, "failed")
  assert.equal(unauthorized.errorCode, "textus_unauthorized")
  assert.equal(textusResultContainsSecret(unauthorized, EXPIRED_TEXTUS_API_KEY), false)

  const timedOut = await createTextusSmsTransport({
    timeoutMs: 20,
    fetchImpl: (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
    }),
  }).send({
    accountEmail: TEXTUS_FIXTURE_ACCOUNT_EMAIL,
    apiKey: TEXTUS_FIXTURE_API_KEY,
    senderKind: "phone_number",
    senderIdentity: TEXTUS_FIXTURE_SENDER,
    recipient: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
    body: "timeout",
    correlationId: "corr-timeout-http",
  })
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.externalId, undefined)
})

test("MIC-188: webhook signature matches the documented HMAC-SHA256 hex digest", () => {
  const payload = JSON.stringify(textusStatusCallbackFixture())
  const signature = createHmac("sha256", TEXTUS_FIXTURE_WEBHOOK_SECRET).update(payload).digest("hex")
  assert.equal(validateTextusSignature({
    secret: TEXTUS_FIXTURE_WEBHOOK_SECRET,
    signature,
    payload,
  }), true)
  assert.equal(validateTextusSignature({
    secret: TEXTUS_FIXTURE_WEBHOOK_SECRET,
    signature: "deadbeef",
    payload,
  }), false)
  assert.equal(validateTextusSignature({
    secret: TEXTUS_FIXTURE_WEBHOOK_SECRET,
    signature: null,
    payload,
  }), false)
})
