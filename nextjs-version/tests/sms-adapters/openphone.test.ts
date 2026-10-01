import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { AppError } from "../../src/lib/mca/errors"
import type { SmsAccount, SmsAdapterSendInput, SmsAdapterStatus } from "../../src/lib/mca/sms/contracts"
import {
  createOpenPhoneSmsAdapter,
  createOpenPhoneSmsTransport,
  OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
  OPENPHONE_FIXTURE_API_KEY,
  OPENPHONE_FIXTURE_BODY,
  OPENPHONE_FIXTURE_CREDENTIALS,
  OPENPHONE_FIXTURE_EVENT_ID,
  OPENPHONE_FIXTURE_MESSAGE_ID,
  OPENPHONE_FIXTURE_REJECTED_RECIPIENT,
  OPENPHONE_FIXTURE_SENDER,
  OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT,
  OPENPHONE_FIXTURE_TRANSPORT,
  OPENPHONE_FIXTURE_USER,
  OPENPHONE_CAPABILITIES,
  OPENPHONE_SIGNATURE_FIXTURE,
  OPENPHONE_SLUG,
  openphoneFixtureMessageId,
  openphoneInboundFixture,
  openphoneMessagesUrl,
  openphoneResultContainsSecret,
  openphoneSmsAdapter,
  openphoneStatusCallbackFixture,
  validateOpenPhoneSignature,
} from "../../src/lib/mca/sms/adapters/openphone"

const now = "2026-09-08T12:00:00.000Z"
const livePathKey = "live-path-openphone-api-key"

function account(overrides: Partial<SmsAccount> = {}): SmsAccount {
  return {
    id: "sms-account-openphone",
    workspaceId: "ws-openphone",
    provider: "openphone",
    label: "OpenPhone fixture",
    senderKind: "phone_number",
    senderMasked: "•••0999",
    credentialRef: "DEFAULT",
    state: "active",
    isDefault: true,
    memberIds: ["member-openphone"],
    providerConfigured: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account: account(),
    idempotencyKey: "sms-row-openphone",
    senderKind: "phone_number",
    senderIdentity: OPENPHONE_FIXTURE_SENDER,
    recipient: OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
    body: OPENPHONE_FIXTURE_BODY,
    statusCallbackUrl: "https://sms.example.test/api/mca/sms/webhooks/openphone/sms-account-openphone/status?messageId=msg-openphone-1",
    correlationId: "corr-openphone-1",
    credentials: { ...OPENPHONE_FIXTURE_CREDENTIALS },
    ...overrides,
  }
}

test("required-field rejection covers API key, user, and sending number", () => {
  const empty = openphoneSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.apiKey, "Enter the OpenPhone API key.")
  assert.equal(empty.fields.user, "Enter the OpenPhone user id.")
  assert.equal(empty.fields.sendingNumber, "Enter a sending number in E.164 format.")
  assert.equal("provider" in empty.fields, false)

  const invalidUser = openphoneSmsAdapter.validate({
    apiKey: OPENPHONE_FIXTURE_API_KEY,
    user: "not-a-user-id",
    sendingNumber: OPENPHONE_FIXTURE_SENDER,
  })
  assert.equal(invalidUser.ok, false)
  if (invalidUser.ok) throw new Error("expected user error")
  assert.equal(invalidUser.fields.user, "Enter an OpenPhone user id beginning with US.")

  const invalidPhone = openphoneSmsAdapter.validate({
    ...OPENPHONE_FIXTURE_CREDENTIALS,
    sendingNumber: "2125550999",
  })
  assert.equal(invalidPhone.ok, false)
  if (invalidPhone.ok) throw new Error("expected sending number error")
  assert.equal(invalidPhone.fields.sendingNumber, "Enter a sending number in E.164 format.")

  const alias = openphoneSmsAdapter.validate({
    apiKey: OPENPHONE_FIXTURE_API_KEY,
    userId: OPENPHONE_FIXTURE_USER,
    sendingNumber: OPENPHONE_FIXTURE_SENDER,
  })
  assert.deepEqual(alias, { ok: true })
  assert.deepEqual(openphoneSmsAdapter.validate(OPENPHONE_FIXTURE_CREDENTIALS), { ok: true })
})

test("accepted send returns a stable AC identity and does not call a live provider", async () => {
  assert.equal(OPENPHONE_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  const result = await openphoneSmsAdapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(result.providerStatus, "queued")
  assert.equal(result.externalId, openphoneFixtureMessageId("corr-openphone-1"))
  assert.match(result.externalId ?? "", /^AC[0-9a-f]+$/)
  assert.equal(openphoneResultContainsSecret(result, OPENPHONE_FIXTURE_API_KEY), false)
  assert.equal(result.errorMessage?.includes(OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT) ?? false, false)

  const replay = await openphoneSmsAdapter.send(sendInput())
  assert.deepEqual(replay, result)

  const second = await openphoneSmsAdapter.send(sendInput({ correlationId: "corr-openphone-2", body: "Second synthetic preview" }))
  assert.equal(second.state, "accepted")
  assert.notEqual(second.externalId, result.externalId)
})

test("rejected-number is a sanitized OpenPhone 400 failure", async () => {
  const result = await openphoneSmsAdapter.send(sendInput({
    recipient: OPENPHONE_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-openphone-rejected",
    body: `Bad ${OPENPHONE_FIXTURE_REJECTED_RECIPIENT}: ${OPENPHONE_FIXTURE_BODY}`,
  }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "openphone_0200400")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(OPENPHONE_FIXTURE_REJECTED_RECIPIENT), false)
  assert.equal(result.errorMessage?.includes(OPENPHONE_FIXTURE_BODY), false)
  assert.equal(openphoneResultContainsSecret(result, OPENPHONE_FIXTURE_API_KEY), false)

  const replay = await openphoneSmsAdapter.send(sendInput({
    recipient: OPENPHONE_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-openphone-rejected",
  }))
  assert.deepEqual(replay, result)
})

test("timeout and unconfigured credential fail closed without inventing an external id", async () => {
  const timeout = await openphoneSmsAdapter.send(sendInput({
    recipient: OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-openphone-timeout",
  }))
  assert.equal(timeout.state, "unknown")
  assert.equal(timeout.errorCode, "provider_outcome_unknown")
  assert.equal(timeout.externalId, undefined)
  const timeoutReplay = await openphoneSmsAdapter.send(sendInput({
    recipient: OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-openphone-timeout",
    body: "A second OpenPhone message",
  }))
  assert.deepEqual(timeoutReplay, timeout)
  assert.equal(timeoutReplay.externalId, undefined)

  const unconfigured = await openphoneSmsAdapter.send(sendInput({
    correlationId: "corr-openphone-unconfigured",
    credentials: {},
  }))
  assert.equal(unconfigured.state, "failed")
  assert.equal(unconfigured.errorCode, "openphone_unconfigured")
  assert.equal(unconfigured.externalId, undefined)
  const unconfiguredReplay = await openphoneSmsAdapter.send(sendInput({
    correlationId: "corr-openphone-unconfigured",
    credentials: { apiKey: OPENPHONE_FIXTURE_API_KEY, user: OPENPHONE_FIXTURE_USER, sendingNumber: OPENPHONE_FIXTURE_SENDER },
  }))
  assert.equal(unconfiguredReplay.state, "accepted")
  assert.ok(unconfiguredReplay.externalId)

  assert.deepEqual(await openphoneSmsAdapter.testConnection(account()), { ok: true })
  assert.deepEqual(await openphoneSmsAdapter.testConnection(account({ providerConfigured: false })), { ok: false, code: "openphone_unconfigured" })
})

test("retried status callback updates the existing message without a duplicate row", async () => {
  assert.equal(typeof openphoneSmsAdapter.parseStatus, "function")
  const rows = new Map<string, { providerStatus: string; eventKeys: Set<string> }>()
  function apply(status: SmsAdapterStatus) {
    const current = rows.get(status.providerMessageId) ?? { providerStatus: "queued", eventKeys: new Set<string>() }
    if (current.eventKeys.has(status.eventKey)) return { duplicate: true, row: current }
    current.eventKeys.add(status.eventKey)
    current.providerStatus = status.providerStatus
    rows.set(status.providerMessageId, current)
    return { duplicate: false, row: current }
  }

  const deliveredBody = openphoneStatusCallbackFixture()
  const first = await openphoneSmsAdapter.parseStatus!({}, deliveredBody)
  assert.equal(first.providerMessageId, OPENPHONE_FIXTURE_MESSAGE_ID)
  assert.equal(first.providerStatus, "delivered")
  assert.equal(first.recipient, OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT)
  assert.equal(apply(first).duplicate, false)

  const replay = await openphoneSmsAdapter.parseStatus!({}, {
    createdAt: "2022-01-23T17:05:56.220Z",
    data: {
      object: {
        body: OPENPHONE_FIXTURE_BODY,
        conversationId: "CNsyntheticconversation1",
        createdAt: "2022-01-23T17:05:45.195Z",
        direction: "outgoing",
        from: OPENPHONE_FIXTURE_SENDER,
        id: OPENPHONE_FIXTURE_MESSAGE_ID,
        object: "message",
        phoneNumberId: "PNsyntheticfrom01",
        status: "delivered",
        to: OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
        userId: OPENPHONE_FIXTURE_USER,
      },
    },
    id: OPENPHONE_FIXTURE_EVENT_ID,
    object: "event",
    type: "message.delivered",
  })
  assert.equal(replay.eventKey, first.eventKey)
  assert.equal(apply(replay).duplicate, true)
  assert.equal(rows.size, 1)

  const later = await openphoneSmsAdapter.parseStatus!({}, openphoneStatusCallbackFixture({
    id: "EVsyntheticdelivered02",
    data: { object: { id: OPENPHONE_FIXTURE_MESSAGE_ID, status: "delivered" } },
  }))
  assert.notEqual(later.eventKey, first.eventKey)
  assert.equal(apply(later).duplicate, false)
  assert.equal(rows.size, 1)
  assert.equal(rows.get(OPENPHONE_FIXTURE_MESSAGE_ID)?.eventKeys.size, 2)

  await assert.rejects(
    () => openphoneSmsAdapter.parseStatus!({}, openphoneStatusCallbackFixture({ type: "message.received" })),
    (error: unknown) => error instanceof AppError && error.code === "openphone_status_unsupported",
  )
})

test("capability flags match OpenPhone send, delivery webhooks, inbound, and STOP/START opt-out", async () => {
  assert.equal(openphoneSmsAdapter.slug, OPENPHONE_SLUG)
  assert.deepEqual(openphoneSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: true,
    inbound: true,
    optOut: true,
  })
  assert.deepEqual(OPENPHONE_CAPABILITIES, openphoneSmsAdapter.capabilities)
  assert.equal(typeof openphoneSmsAdapter.parseStatus, "function")
  assert.equal(typeof openphoneSmsAdapter.parseInbound, "function")

  const stop = await openphoneSmsAdapter.parseInbound!({}, openphoneInboundFixture())
  assert.equal("ignored" in stop, false)
  if ("ignored" in stop) throw new Error("expected STOP opt-out")
  assert.equal(stop.kind, "opt_out")
  assert.equal(stop.recipient, OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT)

  const start = await openphoneSmsAdapter.parseInbound!({}, openphoneInboundFixture({
    data: { object: { body: "START" } },
  }))
  if ("ignored" in start) throw new Error("expected START opt-in")
  assert.equal(start.kind, "opt_in")

  assert.deepEqual(await openphoneSmsAdapter.parseInbound!({}, openphoneInboundFixture({
    data: { object: { body: "HELP" } },
  })), { ignored: true })

  const inbound = await openphoneSmsAdapter.parseInbound!({}, openphoneInboundFixture({
    data: { object: { body: "Need funding terms" } },
  }))
  if ("ignored" in inbound) throw new Error("expected inbound message")
  assert.equal(inbound.kind, "message")
  assert.equal(inbound.body, "Need funding terms")
})

test("extracted transport keeps the documented request contract behind injected fetch", async () => {
  let requestBody = ""
  let authorization = ""
  const adapter = createOpenPhoneSmsAdapter({
    fetchImpl: async (input, init) => {
      assert.equal(String(input), openphoneMessagesUrl())
      assert.equal(init?.method, "POST")
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      requestBody = String(init?.body)
      return new Response(JSON.stringify({
        data: {
          id: OPENPHONE_FIXTURE_MESSAGE_ID,
          status: "queued",
          from: OPENPHONE_FIXTURE_SENDER,
          to: [OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT],
          text: OPENPHONE_FIXTURE_BODY,
          phoneNumberId: "PNsyntheticfrom01",
          conversationId: "CNsyntheticconversation1",
          direction: "outgoing",
          userId: OPENPHONE_FIXTURE_USER,
          createdAt: "2022-01-01T00:00:00Z",
          updatedAt: "2022-01-01T00:00:00Z",
        },
      }), { status: 202 })
    },
  })
  const result = await adapter.send(sendInput({
    correlationId: "corr-openphone-http",
    credentials: {
      apiKey: livePathKey,
      user: OPENPHONE_FIXTURE_USER,
      sendingNumber: OPENPHONE_FIXTURE_SENDER,
    },
  }))
  assert.deepEqual(result, { state: "accepted", externalId: OPENPHONE_FIXTURE_MESSAGE_ID, providerStatus: "queued" })
  assert.equal(authorization, livePathKey)
  assert.equal(authorization.startsWith("Bearer "), false)
  assert.deepEqual(JSON.parse(requestBody), {
    content: OPENPHONE_FIXTURE_BODY,
    from: OPENPHONE_FIXTURE_SENDER,
    to: [OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT],
    userId: OPENPHONE_FIXTURE_USER,
  })
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(requestBody), "statusCallbackUrl"), false)
  assert.equal(openphoneResultContainsSecret(JSON.parse(requestBody), livePathKey), false)

  const timedOut = await createOpenPhoneSmsTransport({
    timeoutMs: 20,
    fetchImpl: (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
    }),
  }).send({
    apiKey: livePathKey,
    user: OPENPHONE_FIXTURE_USER,
    senderIdentity: OPENPHONE_FIXTURE_SENDER,
    recipient: OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
    body: "timeout",
    correlationId: "corr-timeout-http",
  })
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.externalId, undefined)
})

test("OpenPhone webhook signature matches the documented HMAC scheme", () => {
  assert.equal(validateOpenPhoneSignature({
    signingKey: OPENPHONE_SIGNATURE_FIXTURE.signingKey,
    signature: OPENPHONE_SIGNATURE_FIXTURE.header,
    payload: OPENPHONE_SIGNATURE_FIXTURE.payload,
  }), true)

  const expected = createHmac("sha256", Buffer.from(OPENPHONE_SIGNATURE_FIXTURE.signingKey, "base64"))
    .update(`${OPENPHONE_SIGNATURE_FIXTURE.timestamp}.${JSON.stringify(OPENPHONE_SIGNATURE_FIXTURE.payload)}`, "utf8")
    .digest("base64")
  assert.equal(expected, OPENPHONE_SIGNATURE_FIXTURE.signature)

  assert.equal(validateOpenPhoneSignature({
    signingKey: OPENPHONE_SIGNATURE_FIXTURE.signingKey,
    signature: "hmac;1;1639710054089;aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
    payload: OPENPHONE_SIGNATURE_FIXTURE.payload,
  }), false)
})
