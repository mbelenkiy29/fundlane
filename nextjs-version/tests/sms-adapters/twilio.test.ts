import test from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { AppError } from "../../src/lib/mca/errors"
import type { SmsAccount, SmsAdapterSendInput, SmsAdapterStatus } from "../../src/lib/mca/sms/contracts"
import {
  createTwilioSmsAdapter,
  createTwilioSmsTransport,
  TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
  TWILIO_FIXTURE_ACCOUNT_SID,
  TWILIO_FIXTURE_API_KEY_SECRET,
  TWILIO_FIXTURE_API_KEY_SID,
  TWILIO_FIXTURE_AUTH_TOKEN,
  TWILIO_FIXTURE_CREDENTIALS,
  TWILIO_FIXTURE_MESSAGE_SID,
  TWILIO_FIXTURE_MESSAGING_SERVICE_SID,
  TWILIO_FIXTURE_REJECTED_RECIPIENT,
  TWILIO_FIXTURE_SENDER,
  TWILIO_FIXTURE_TIMEOUT_RECIPIENT,
  TWILIO_FIXTURE_TRANSPORT,
  TWILIO_OFFICIAL_SIGNATURE_FIXTURE,
  TWILIO_SLUG,
  twilioFixtureMessageSid,
  twilioInboundFixture,
  twilioMessageForm,
  twilioMessagesUrl,
  twilioResultContainsSecret,
  twilioSmsAdapter,
  twilioStatusCallbackFixture,
  validateTwilioFormSignature,
} from "../../src/lib/mca/sms/adapters/twilio"

const now = "2026-09-08T12:00:00.000Z"
const livePathSid = `AC${"e".repeat(32)}`

function account(overrides: Partial<SmsAccount> = {}): SmsAccount {
  return {
    id: "sms-account-twilio",
    workspaceId: "ws-twilio",
    provider: "twilio",
    label: "Twilio fixture",
    senderKind: "phone_number",
    senderMasked: "•••0999",
    credentialRef: "DEFAULT",
    state: "active",
    isDefault: true,
    memberIds: ["member-twilio"],
    providerConfigured: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account: account(),
    idempotencyKey: "sms-row-twilio",
    senderKind: "phone_number",
    senderIdentity: TWILIO_FIXTURE_SENDER,
    recipient: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    body: "Exact synthetic Twilio preview",
    statusCallbackUrl: "https://sms.example.test/api/mca/sms/webhooks/twilio/sms-account-twilio/status?messageId=msg-twilio-1",
    correlationId: "corr-twilio-1",
    credentials: { ...TWILIO_FIXTURE_CREDENTIALS },
    ...overrides,
  }
}

test("required-field rejection covers API credentials, sending number, and Messaging Service SID", () => {
  const empty = twilioSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.accountSid, "Enter a Twilio Account SID.")
  assert.equal(empty.fields.apiKeySid, "Enter a Twilio API key SID.")
  assert.equal(empty.fields.apiKeySecret, "Enter the Twilio API key secret.")
  assert.equal(empty.fields.sendingNumber, "Enter a sending number in E.164 format.")
  assert.equal(empty.fields.messagingServiceSid, "Enter a Twilio Messaging Service SID.")
  assert.equal("provider" in empty.fields, false)

  const phoneOnly = twilioSmsAdapter.validate({
    accountSid: TWILIO_FIXTURE_ACCOUNT_SID,
    apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
    apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
    sendingNumber: TWILIO_FIXTURE_SENDER,
  })
  assert.deepEqual(phoneOnly, { ok: true })

  const messagingOnly = twilioSmsAdapter.validate({
    accountSid: TWILIO_FIXTURE_ACCOUNT_SID,
    apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
    apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
    messagingServiceSid: TWILIO_FIXTURE_MESSAGING_SERVICE_SID,
  })
  assert.deepEqual(messagingOnly, { ok: true })

  const invalidPhone = twilioSmsAdapter.validate({
    ...TWILIO_FIXTURE_CREDENTIALS,
    sendingNumber: "2125550999",
  })
  assert.equal(invalidPhone.ok, false)
  if (invalidPhone.ok) throw new Error("expected sending number error")
  assert.equal(invalidPhone.fields.sendingNumber, "Enter a sending number in E.164 format.")
})

test("accepted send returns a stable SM identity and does not call a live provider", async () => {
  assert.equal(TWILIO_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  const result = await twilioSmsAdapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(result.providerStatus, "queued")
  assert.equal(result.externalId, twilioFixtureMessageSid("corr-twilio-1"))
  assert.match(result.externalId ?? "", /^(?:SM|MM)[0-9a-fA-F]{32}$/)
  assert.equal(twilioResultContainsSecret(result, TWILIO_FIXTURE_API_KEY_SECRET), false)
  assert.equal(twilioResultContainsSecret(result, TWILIO_FIXTURE_AUTH_TOKEN), false)
  assert.equal(result.errorMessage?.includes(TWILIO_FIXTURE_ACCEPTED_RECIPIENT) ?? false, false)

  const replay = await twilioSmsAdapter.send(sendInput())
  assert.deepEqual(replay, result)

  const second = await twilioSmsAdapter.send(sendInput({ correlationId: "corr-twilio-2", body: "Second synthetic preview" }))
  assert.equal(second.state, "accepted")
  assert.notEqual(second.externalId, result.externalId)
})

test("rejected-number is a sanitized Twilio 21614 failure", async () => {
  const result = await twilioSmsAdapter.send(sendInput({
    recipient: TWILIO_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-twilio-rejected",
    body: `Bad ${TWILIO_FIXTURE_REJECTED_RECIPIENT}: Exact synthetic Twilio preview`,
  }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "twilio_21614")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(TWILIO_FIXTURE_REJECTED_RECIPIENT), false)
  assert.equal(result.errorMessage?.includes("Exact synthetic Twilio preview"), false)
  assert.equal(twilioResultContainsSecret(result, TWILIO_FIXTURE_API_KEY_SECRET), false)

  const replay = await twilioSmsAdapter.send(sendInput({
    recipient: TWILIO_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-twilio-rejected",
  }))
  assert.deepEqual(replay, result)
})

test("timeout and unconfigured credential fail closed without inventing an external id", async () => {
  const timeout = await twilioSmsAdapter.send(sendInput({
    recipient: TWILIO_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-twilio-timeout",
  }))
  assert.equal(timeout.state, "unknown")
  assert.equal(timeout.errorCode, "provider_outcome_unknown")
  assert.equal(timeout.externalId, undefined)
  const timeoutReplay = await twilioSmsAdapter.send(sendInput({
    recipient: TWILIO_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-twilio-timeout",
    body: "A second Twilio message",
  }))
  assert.deepEqual(timeoutReplay, timeout)
  assert.equal(timeoutReplay.externalId, undefined)

  const unconfigured = await twilioSmsAdapter.send(sendInput({
    correlationId: "corr-twilio-unconfigured",
    credentials: {},
  }))
  assert.equal(unconfigured.state, "failed")
  assert.equal(unconfigured.errorCode, "twilio_unconfigured")
  assert.equal(unconfigured.externalId, undefined)
  const unconfiguredReplay = await twilioSmsAdapter.send(sendInput({
    correlationId: "corr-twilio-unconfigured",
    credentials: { accountSid: TWILIO_FIXTURE_ACCOUNT_SID, apiKeySid: TWILIO_FIXTURE_API_KEY_SID, apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET },
  }))
  assert.equal(unconfiguredReplay.state, "accepted")
  assert.ok(unconfiguredReplay.externalId)

  assert.deepEqual(await twilioSmsAdapter.testConnection(account()), { ok: true })
  assert.deepEqual(await twilioSmsAdapter.testConnection(account({ providerConfigured: false })), { ok: false, code: "twilio_unconfigured" })
})

test("retried status callback updates the existing message without a duplicate row", async () => {
  assert.equal(typeof twilioSmsAdapter.parseStatus, "function")
  const rows = new Map<string, { providerStatus: string; eventKeys: Set<string> }>()
  function apply(status: SmsAdapterStatus) {
    const current = rows.get(status.providerMessageId) ?? { providerStatus: "queued", eventKeys: new Set<string>() }
    if (current.eventKeys.has(status.eventKey)) return { duplicate: true, row: current }
    current.eventKeys.add(status.eventKey)
    current.providerStatus = status.providerStatus
    rows.set(status.providerMessageId, current)
    return { duplicate: false, row: current }
  }

  const deliveredBody = twilioStatusCallbackFixture()
  const first = await twilioSmsAdapter.parseStatus!({}, deliveredBody)
  assert.equal(first.providerMessageId, TWILIO_FIXTURE_MESSAGE_SID)
  assert.equal(first.providerStatus, "delivered")
  assert.equal(first.recipient, TWILIO_FIXTURE_ACCEPTED_RECIPIENT)
  assert.equal(apply(first).duplicate, false)

  const replay = await twilioSmsAdapter.parseStatus!({}, {
    From: TWILIO_FIXTURE_SENDER,
    To: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    MessageSid: TWILIO_FIXTURE_MESSAGE_SID,
    AccountSid: TWILIO_FIXTURE_ACCOUNT_SID,
    MessageStatus: "delivered",
  })
  assert.equal(replay.eventKey, first.eventKey)
  assert.equal(apply(replay).duplicate, true)
  assert.equal(rows.size, 1)

  const sent = await twilioSmsAdapter.parseStatus!({}, twilioStatusCallbackFixture({ MessageStatus: "sent" }))
  assert.notEqual(sent.eventKey, first.eventKey)
  assert.equal(apply(sent).duplicate, false)
  assert.equal(rows.size, 1)
  assert.equal(rows.get(TWILIO_FIXTURE_MESSAGE_SID)?.eventKeys.size, 2)
  assert.equal(rows.get(TWILIO_FIXTURE_MESSAGE_SID)?.providerStatus, "sent")

  await assert.rejects(
    () => twilioSmsAdapter.parseStatus!({}, twilioStatusCallbackFixture({ MessageStatus: "read" })),
    (error: unknown) => error instanceof AppError && error.code === "twilio_status_unsupported",
  )
})

test("capability flags match Twilio send, status callbacks, inbound, and Advanced Opt-Out", async () => {
  assert.equal(twilioSmsAdapter.slug, TWILIO_SLUG)
  assert.deepEqual(twilioSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: true,
    inbound: true,
    optOut: true,
  })

  const stop = await twilioSmsAdapter.parseInbound!({}, twilioInboundFixture())
  assert.equal("ignored" in stop, false)
  if ("ignored" in stop) throw new Error("expected STOP opt-out")
  assert.equal(stop.kind, "opt_out")
  assert.equal(stop.recipient, TWILIO_FIXTURE_ACCEPTED_RECIPIENT)

  const start = await twilioSmsAdapter.parseInbound!({}, twilioInboundFixture({ OptOutType: "START" }))
  if ("ignored" in start) throw new Error("expected START opt-in")
  assert.equal(start.kind, "opt_in")

  assert.deepEqual(await twilioSmsAdapter.parseInbound!({}, twilioInboundFixture({ OptOutType: "HELP" })), { ignored: true })
})

test("extracted transport keeps the documented request contract behind injected fetch", async () => {
  let requestBody = ""
  const adapter = createTwilioSmsAdapter({
    fetchImpl: async (input, init) => {
      assert.equal(String(input), twilioMessagesUrl(livePathSid))
      assert.equal(init?.method, "POST")
      assert.match(new Headers(init?.headers).get("authorization") ?? "", /^Basic /)
      requestBody = String(init?.body)
      return new Response(JSON.stringify({ sid: TWILIO_FIXTURE_MESSAGE_SID, status: "queued" }), { status: 201 })
    },
  })
  const result = await adapter.send(sendInput({
    correlationId: "corr-twilio-http",
    credentials: {
      accountSid: livePathSid,
      apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
      apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
    },
  }))
  assert.deepEqual(result, { state: "accepted", externalId: TWILIO_FIXTURE_MESSAGE_SID, providerStatus: "queued" })
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requestBody)), {
    To: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    Body: "Exact synthetic Twilio preview",
    StatusCallback: sendInput().statusCallbackUrl,
    From: TWILIO_FIXTURE_SENDER,
  })

  const messaging = twilioMessageForm({
    accountSid: livePathSid,
    apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
    apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
    senderKind: "messaging_service",
    senderIdentity: TWILIO_FIXTURE_MESSAGING_SERVICE_SID,
    recipient: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    body: "Messaging Service fixture",
    statusCallbackUrl: "https://sms.example.test/callback",
    correlationId: "corr-mg",
  })
  assert.equal(messaging.get("MessagingServiceSid"), TWILIO_FIXTURE_MESSAGING_SERVICE_SID)
  assert.equal(messaging.get("From"), null)

  const timedOut = await createTwilioSmsTransport({
    timeoutMs: 20,
    fetchImpl: (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
    }),
  }).send({
    accountSid: livePathSid,
    apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
    apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
    senderKind: "phone_number",
    senderIdentity: TWILIO_FIXTURE_SENDER,
    recipient: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    body: "timeout",
    statusCallbackUrl: "https://sms.example.test/callback",
    correlationId: "corr-timeout-http",
  })
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.externalId, undefined)
})

test("two sends with one run correlation call Twilio twice and return distinct SIDs", async () => {
  let calls = 0
  const adapter = createTwilioSmsAdapter({ fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ sid: `SM${String(calls).padStart(32, "0")}`, status: "queued" }), { status: 201 })
  } })
  const input = sendInput({ correlationId: "same-run", credentials: { ...TWILIO_FIXTURE_CREDENTIALS, accountSid: livePathSid } })
  const first = await adapter.send(input)
  const second = await adapter.send({ ...input, body: "Second approved message" })
  assert.equal(calls, 2)
  assert.notEqual(first.externalId, second.externalId)
})

test("Twilio form signature matches the official fixture and sorts duplicate parameters", () => {
  const official = new URLSearchParams(TWILIO_OFFICIAL_SIGNATURE_FIXTURE.params)
  assert.equal(validateTwilioFormSignature({
    authToken: TWILIO_OFFICIAL_SIGNATURE_FIXTURE.authToken,
    signature: TWILIO_OFFICIAL_SIGNATURE_FIXTURE.signature,
    url: TWILIO_OFFICIAL_SIGNATURE_FIXTURE.url,
    params: official,
  }), true)

  const duplicate = new URLSearchParams()
  duplicate.append("Tag", "zeta")
  duplicate.append("a", "last")
  duplicate.append("Tag", "alpha")
  duplicate.append("Tag", "alpha")
  const url = "https://example.com/webhook"
  const expected = createHmac("sha1", "token").update(`${url}TagalphaTagzetaalast`).digest("base64")
  assert.equal(validateTwilioFormSignature({ authToken: "token", signature: expected, url, params: duplicate }), true)
})
