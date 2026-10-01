import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { AppError } from "../../src/lib/mca/errors"
import type { SmsAccount, SmsAdapterSendInput, SmsAdapterStatus } from "../../src/lib/mca/sms/contracts"
import {
  GHL_API_VERSION,
  GOHIGHLEVEL_CAPABILITIES,
  GOHIGHLEVEL_EXPIRED_TOKEN,
  GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_BODY,
  GOHIGHLEVEL_FIXTURE_CONTACT_ID,
  GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
  GOHIGHLEVEL_FIXTURE_CREDENTIALS,
  GOHIGHLEVEL_FIXTURE_LOCATION_ID,
  GOHIGHLEVEL_FIXTURE_MESSAGE_ID,
  GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_SENDER,
  GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_TOKEN,
  GOHIGHLEVEL_FIXTURE_TRANSPORT,
  GOHIGHLEVEL_SLUG,
  createGohighlevelSmsAdapter,
  createGohighlevelSmsTransport,
  ghlDuplicateContactUrl,
  ghlMessagesUrl,
  ghlUpsertContactUrl,
  gohighlevelFixtureFetch,
  gohighlevelFixtureMessageId,
  gohighlevelInboundFixture,
  gohighlevelResultContainsSecret,
  gohighlevelSmsAdapter,
  gohighlevelStatusCallbackFixture,
  mapGhlSendBody,
  resetGohighlevelFixtures,
  validateGhlWebhookSignature,
} from "../../src/lib/mca/sms/adapters/gohighlevel"

const now = "2026-09-08T12:00:00.000Z"
const livePathToken = "pit-ghl-live-path-synthetic"

function account(overrides: Partial<SmsAccount> = {}): SmsAccount {
  return {
    id: "sms-account-ghl",
    workspaceId: "ws-ghl",
    provider: "gohighlevel",
    label: "GoHighLevel fixture",
    senderKind: "phone_number",
    senderMasked: "•••0999",
    credentialRef: "DEFAULT",
    state: "active",
    isDefault: true,
    memberIds: ["member-ghl"],
    providerConfigured: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function sendInput(overrides: Partial<SmsAdapterSendInput> = {}): SmsAdapterSendInput {
  return {
    account: account(),
    idempotencyKey: "sms-row-gohighlevel",
    senderKind: "phone_number",
    senderIdentity: GOHIGHLEVEL_FIXTURE_SENDER,
    recipient: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    body: GOHIGHLEVEL_FIXTURE_BODY,
    statusCallbackUrl: "https://sms.example.test/api/mca/sms/webhooks/gohighlevel/sms-account-ghl/status?messageId=msg-ghl-1",
    correlationId: "corr-ghl-1",
    credentials: { ...GOHIGHLEVEL_FIXTURE_CREDENTIALS },
    ...overrides,
  }
}

function assertNoSecrets(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  assert.equal(text.includes(GOHIGHLEVEL_FIXTURE_TOKEN), false)
  assert.equal(text.includes(GOHIGHLEVEL_EXPIRED_TOKEN), false)
  assert.equal(text.includes(livePathToken), false)
}

beforeEach(() => {
  resetGohighlevelFixtures()
})

test("required-field rejection covers Private Integration Token and Location ID", () => {
  const empty = gohighlevelSmsAdapter.validate({})
  assert.equal(empty.ok, false)
  if (empty.ok) throw new Error("expected field errors")
  assert.equal(empty.fields.privateIntegrationToken, "Enter the GoHighLevel Private Integration Token.")
  assert.equal(empty.fields.locationId, "Enter the GoHighLevel Location ID.")
  assert.equal("provider" in empty.fields, false)
  assert.equal("sendingNumber" in empty.fields, false)

  const invalidLocation = gohighlevelSmsAdapter.validate({
    privateIntegrationToken: GOHIGHLEVEL_FIXTURE_TOKEN,
    locationId: "??",
  })
  assert.equal(invalidLocation.ok, false)
  if (invalidLocation.ok) throw new Error("expected location error")
  assert.equal(invalidLocation.fields.locationId, "Enter the GoHighLevel Location ID.")

  const alias = gohighlevelSmsAdapter.validate({
    token: GOHIGHLEVEL_FIXTURE_TOKEN,
    location: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
  })
  assert.deepEqual(alias, { ok: true })
  assert.deepEqual(gohighlevelSmsAdapter.validate(GOHIGHLEVEL_FIXTURE_CREDENTIALS), { ok: true })
})

test("accepted send returns a stable message identity and does not call a live provider", async () => {
  assert.equal(GOHIGHLEVEL_FIXTURE_TRANSPORT.startsWith("fixture://"), true)
  const result = await gohighlevelSmsAdapter.send(sendInput())
  assert.equal(result.state, "accepted")
  assert.equal(result.providerStatus, "pending")
  assert.equal(result.externalId, gohighlevelFixtureMessageId("corr-ghl-1"))
  assert.equal(result.externalId?.length, 20)
  assert.equal(gohighlevelResultContainsSecret(result, GOHIGHLEVEL_FIXTURE_TOKEN), false)
  assert.equal(result.errorMessage?.includes(GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT) ?? false, false)

  const replay = await gohighlevelSmsAdapter.send(sendInput())
  assert.deepEqual(replay, result)

  const second = await gohighlevelSmsAdapter.send(sendInput({ correlationId: "corr-ghl-2", body: "Second synthetic preview" }))
  assert.equal(second.state, "accepted")
  assert.notEqual(second.externalId, result.externalId)
})

test("rejected-number is a sanitized GoHighLevel invalid-phone failure", async () => {
  const result = await gohighlevelSmsAdapter.send(sendInput({
    recipient: GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-ghl-rejected",
    body: `Bad ${GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT}: ${GOHIGHLEVEL_FIXTURE_BODY}`,
  }))
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "gohighlevel_invalid_phone")
  assert.equal(result.externalId, undefined)
  assert.equal(result.errorMessage?.includes(GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT), false)
  assert.equal(result.errorMessage?.includes(GOHIGHLEVEL_FIXTURE_BODY), false)
  assertNoSecrets(result)

  const replay = await gohighlevelSmsAdapter.send(sendInput({
    recipient: GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT,
    correlationId: "corr-ghl-rejected",
  }))
  assert.deepEqual(replay, result)
})

test("timeout and unconfigured credential fail closed without inventing an external id", async () => {
  const timeout = await gohighlevelSmsAdapter.send(sendInput({
    recipient: GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-ghl-timeout",
  }))
  assert.equal(timeout.state, "unknown")
  assert.equal(timeout.errorCode, "provider_outcome_unknown")
  assert.equal(timeout.externalId, undefined)
  const timeoutReplay = await gohighlevelSmsAdapter.send(sendInput({
    recipient: GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT,
    correlationId: "corr-ghl-timeout",
    body: "A second GoHighLevel message",
  }))
  assert.deepEqual(timeoutReplay, timeout)
  assert.equal(timeoutReplay.externalId, undefined)

  const unconfigured = await gohighlevelSmsAdapter.send(sendInput({
    correlationId: "corr-ghl-unconfigured",
    credentials: {},
  }))
  assert.equal(unconfigured.state, "failed")
  assert.equal(unconfigured.errorCode, "gohighlevel_unconfigured")
  assert.equal(unconfigured.externalId, undefined)
  const unconfiguredReplay = await gohighlevelSmsAdapter.send(sendInput({
    correlationId: "corr-ghl-unconfigured",
    credentials: { ...GOHIGHLEVEL_FIXTURE_CREDENTIALS },
  }))
  assert.equal(unconfiguredReplay.state, "accepted")
  assert.ok(unconfiguredReplay.externalId)

  assert.deepEqual(await gohighlevelSmsAdapter.testConnection(account()), { ok: true })
  assert.deepEqual(await gohighlevelSmsAdapter.testConnection(account({ providerConfigured: false })), { ok: false, code: "gohighlevel_unconfigured" })
})

test("retried status callback updates the existing message without a duplicate row", async () => {
  assert.equal(typeof gohighlevelSmsAdapter.parseStatus, "function")
  const rows = new Map<string, { providerStatus: string; eventKeys: Set<string> }>()
  function apply(status: SmsAdapterStatus) {
    const current = rows.get(status.providerMessageId) ?? { providerStatus: "pending", eventKeys: new Set<string>() }
    if (current.eventKeys.has(status.eventKey)) return { duplicate: true, row: current }
    current.eventKeys.add(status.eventKey)
    current.providerStatus = status.providerStatus
    rows.set(status.providerMessageId, current)
    return { duplicate: false, row: current }
  }

  const deliveredBody = gohighlevelStatusCallbackFixture()
  const first = await gohighlevelSmsAdapter.parseStatus!({}, deliveredBody)
  assert.equal(first.providerMessageId, GOHIGHLEVEL_FIXTURE_MESSAGE_ID)
  assert.equal(first.providerStatus, "delivered")
  assert.equal(first.recipient, GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT)
  assert.equal(apply(first).duplicate, false)

  const replay = await gohighlevelSmsAdapter.parseStatus!({}, {
    source: "api",
    to: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    from: GOHIGHLEVEL_FIXTURE_SENDER,
    messageId: GOHIGHLEVEL_FIXTURE_MESSAGE_ID,
    locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
    contactId: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
    conversationId: GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
    contentType: "text/plain",
    dateAdded: "2026-09-08T12:00:00.000Z",
    direction: "outbound",
    messageType: "SMS",
    type: "OutboundMessage",
    status: "delivered",
    messageTypeId: 2,
    messageTypeString: "TYPE_SMS",
  })
  assert.equal(replay.eventKey, first.eventKey)
  assert.equal(apply(replay).duplicate, true)
  assert.equal(rows.size, 1)

  const sent = await gohighlevelSmsAdapter.parseStatus!({}, gohighlevelStatusCallbackFixture({ status: "sent" }))
  assert.notEqual(sent.eventKey, first.eventKey)
  assert.equal(apply(sent).duplicate, false)
  assert.equal(rows.size, 1)
  assert.equal(rows.get(GOHIGHLEVEL_FIXTURE_MESSAGE_ID)?.eventKeys.size, 2)
  assert.equal(rows.get(GOHIGHLEVEL_FIXTURE_MESSAGE_ID)?.providerStatus, "sent")

  await assert.rejects(
    () => gohighlevelSmsAdapter.parseStatus!({}, gohighlevelStatusCallbackFixture({ status: "queued" })),
    (error: unknown) => error instanceof AppError && error.code === "gohighlevel_status_unsupported",
  )
})

test("capability flags match GoHighLevel send, OutboundMessage status, inbound SMS, and STOP/START", async () => {
  assert.equal(gohighlevelSmsAdapter.slug, GOHIGHLEVEL_SLUG)
  assert.deepEqual(gohighlevelSmsAdapter.capabilities, {
    send: true,
    statusCallbacks: true,
    inbound: true,
    optOut: true,
  })
  assert.deepEqual(GOHIGHLEVEL_CAPABILITIES, gohighlevelSmsAdapter.capabilities)
  assert.equal(typeof gohighlevelSmsAdapter.parseStatus, "function")
  assert.equal(typeof gohighlevelSmsAdapter.parseInbound, "function")

  const stop = await gohighlevelSmsAdapter.parseInbound!({}, gohighlevelInboundFixture())
  assert.equal("ignored" in stop, false)
  if ("ignored" in stop) throw new Error("expected STOP opt-out")
  assert.equal(stop.kind, "opt_out")
  assert.equal(stop.recipient, GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT)

  const start = await gohighlevelSmsAdapter.parseInbound!({}, gohighlevelInboundFixture({ body: "START" }))
  if ("ignored" in start) throw new Error("expected START opt-in")
  assert.equal(start.kind, "opt_in")

  const inbound = await gohighlevelSmsAdapter.parseInbound!({}, gohighlevelInboundFixture({ body: "start2" }))
  if ("ignored" in inbound) throw new Error("expected inbound message")
  assert.equal(inbound.kind, "message")
  assert.equal(inbound.body, "start2")

  assert.deepEqual(await gohighlevelSmsAdapter.parseInbound!({}, gohighlevelInboundFixture({ type: "OutboundMessage" })), { ignored: true })
  assert.deepEqual(await gohighlevelSmsAdapter.parseInbound!({}, gohighlevelInboundFixture({ messageType: "CALL" })), { ignored: true })
})

test("extracted transport keeps the documented request contract behind injected fetch", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: Record<string, unknown> }> = []
  const adapter = createGohighlevelSmsAdapter({
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers)
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {}
      requests.push({ url: String(input), method: String(init?.method), headers, body })
      return gohighlevelFixtureFetch(input, init)
    },
  })
  const result = await adapter.send(sendInput({
    correlationId: "corr-ghl-http",
    credentials: {
      privateIntegrationToken: livePathToken,
      locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
    },
  }))
  assert.equal(result.state, "accepted")
  assert.ok(result.externalId)
  assert.equal(result.providerStatus, "pending")
  assertNoSecrets(result)

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, ghlDuplicateContactUrl(GOHIGHLEVEL_FIXTURE_LOCATION_ID, GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT))
  assert.equal(requests[0].method, "GET")
  assert.equal(requests[0].headers.get("authorization"), `Bearer ${livePathToken}`)
  assert.equal(requests[0].headers.get("Version"), GHL_API_VERSION)
  assert.equal(requests[1].url, ghlMessagesUrl())
  assert.equal(requests[1].method, "POST")
  assert.deepEqual(requests[1].body, {
    type: "SMS",
    contactId: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
    message: GOHIGHLEVEL_FIXTURE_BODY,
    toNumber: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    fromNumber: GOHIGHLEVEL_FIXTURE_SENDER,
  })
  assert.equal(JSON.stringify(requests[1].body).includes(livePathToken), false)
  assert.equal("statusCallbackUrl" in requests[1].body, false)

  const upsertRequests: string[] = []
  const upsertAdapter = createGohighlevelSmsAdapter({
    fetchImpl: async (input, init) => {
      upsertRequests.push(String(input))
      return gohighlevelFixtureFetch(input, init)
    },
  })
  const created = await upsertAdapter.send(sendInput({
    recipient: GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT,
    correlationId: "corr-ghl-upsert",
    credentials: { privateIntegrationToken: livePathToken, locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID },
  }))
  assert.equal(created.state, "accepted")
  assert.equal(upsertRequests[0], ghlDuplicateContactUrl(GOHIGHLEVEL_FIXTURE_LOCATION_ID, GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT))
  assert.equal(upsertRequests[1], ghlUpsertContactUrl())
  assert.equal(upsertRequests[2], ghlMessagesUrl())

  const messaging = mapGhlSendBody({
    contactId: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
    recipient: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    body: "Messaging Service fixture",
    senderIdentity: "not-a-phone",
  })
  assert.equal(messaging.fromNumber, undefined)
  assert.equal(messaging.type, "SMS")

  const expired = await createGohighlevelSmsAdapter({ fetchImpl: gohighlevelFixtureFetch }).send(sendInput({
    correlationId: "corr-ghl-expired",
    credentials: { privateIntegrationToken: GOHIGHLEVEL_EXPIRED_TOKEN, locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID },
  }))
  assert.equal(expired.state, "failed")
  assert.equal(expired.errorCode, "gohighlevel_unauthorized")
  assert.equal(expired.externalId, undefined)
  assertNoSecrets(expired)

  const timedOut = await createGohighlevelSmsTransport({
    timeoutMs: 20,
    fetchImpl: (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
    }),
  }).send({
    privateIntegrationToken: livePathToken,
    locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
    senderIdentity: GOHIGHLEVEL_FIXTURE_SENDER,
    recipient: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    body: "timeout",
    correlationId: "corr-timeout-http",
  })
  assert.equal(timedOut.state, "unknown")
  assert.equal(timedOut.externalId, undefined)
})

test("GoHighLevel Ed25519 webhook signature verifies with the documented algorithm", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const payload = JSON.stringify(gohighlevelStatusCallbackFixture())
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64")
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  assert.equal(validateGhlWebhookSignature({ payload, signature, publicKeyPem }), true)
  assert.equal(validateGhlWebhookSignature({ payload, signature: "AAAA", publicKeyPem }), false)
  assert.equal(validateGhlWebhookSignature({ payload, signature: null, publicKeyPem }), false)
  assert.equal(validateGhlWebhookSignature({ payload, signature }), false)
})
