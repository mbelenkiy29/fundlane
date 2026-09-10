import test from "node:test"
import assert from "node:assert/strict"
import type { ClosingTransportRequest, ClosingTransportResult } from "../src/lib/mca/closing/delivery"
import { createMerchantOfferSmsTransport, mapClosingSmsResult } from "../src/lib/mca/closing/offer-sms"
import type { DealActor } from "../src/lib/mca/deals/schema"
import { AppError } from "../src/lib/mca/errors"
import type { SmsDeliveryResult } from "../src/lib/mca/sms/contracts"
import type { TwilioSmsTransport } from "../src/lib/mca/sms/twilio"

const actor: DealActor = {
  workspaceId: "ws-mic-168",
  userId: "user-mic-168",
  membershipId: "member-mic-168",
  role: "admin",
  managedMembershipIds: [],
  activeMembershipIds: ["member-mic-168"],
  source: "user",
  correlationId: "corr-actor-mic-168",
}

const request = (overrides: Partial<ClosingTransportRequest> = {}): ClosingTransportRequest => ({
  kind: "offer_message",
  channel: "sms",
  senderId: "sms-account-1",
  recipient: "+12125550123",
  body: "Hello Mira,\n\nHere is your funding option:\n\n• Northstar Capital · $40,000.00",
  correlationId: "delivery-correlation-168",
  recordId: "preview-168",
  attemptKey: "offer-send-168",
  payloadHash: "a".repeat(64),
  ...overrides,
})

const overrideTransport: TwilioSmsTransport = {
  async send() {
    return { state: "accepted", externalId: `SM${"d".repeat(32)}`, providerStatus: "queued" }
  },
}

function wouldRecordPitch(result: ClosingTransportResult): boolean {
  return result.state === "sent"
}

test("MIC-168 accepted SMS with external id maps to sent", () => {
  const result = mapClosingSmsResult(request(), { state: "accepted", externalId: `SM${"c".repeat(32)}` })
  assert.deepEqual(result, {
    state: "sent",
    correlationId: "delivery-correlation-168",
    externalId: `SM${"c".repeat(32)}`,
  })
  assert.equal(wouldRecordPitch(result), true)
})

test("MIC-168 failed SMS maps to failed and is not sent", () => {
  const result = mapClosingSmsResult(request(), {
    state: "failed",
    errorCode: "sms_provider_rejected",
    errorMessage: "The text message provider rejected the message.",
  })
  assert.deepEqual(result, {
    state: "failed",
    correlationId: "delivery-correlation-168",
    errorCode: "sms_provider_rejected",
    errorMessage: "The text message provider rejected the message.",
  })
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 failed SMS without provider details uses the closing fallback", () => {
  const result = mapClosingSmsResult(request(), { state: "failed" })
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "sms_provider_rejected")
  assert.equal(result.errorMessage, "The text message provider rejected the message.")
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 unknown SMS outcome maps to blocked, not sent", () => {
  const result = mapClosingSmsResult(request(), {
    state: "unknown",
    errorCode: "provider_outcome_unknown",
    errorMessage: "The provider outcome is unknown. Check provider activity before retrying.",
  })
  assert.deepEqual(result, {
    state: "blocked",
    correlationId: "delivery-correlation-168",
    errorCode: "provider_outcome_unknown",
    errorMessage: "The text message provider outcome could not be confirmed. Check provider activity before retrying.",
  })
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 accepted SMS without an external id stays blocked", () => {
  const result = mapClosingSmsResult(request(), { state: "accepted" })
  assert.equal(result.state, "blocked")
  assert.equal(result.errorCode, "provider_outcome_unknown")
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 deliver uses never_attempted, forwards the Twilio override, and maps accepted+id to sent", async () => {
  const calls: Array<{ deliveryMode: string; senderAccountId?: string; transport?: TwilioSmsTransport }> = []
  const closing = createMerchantOfferSmsTransport(actor, "deal-168", overrideTransport, async (_actor, input, transport) => {
    calls.push({ deliveryMode: input.deliveryMode, senderAccountId: input.senderAccountId, transport })
    assert.equal(input.dealId, "deal-168")
    assert.equal(input.recipient, "+12125550123")
    assert.equal(input.body, request().body)
    assert.equal(input.idempotencyKey, "closing:delivery-correlation-168")
    assert.equal(input.correlationId, "delivery-correlation-168")
    assert.equal(input.payloadHash, "a".repeat(64))
    return { state: "accepted", externalId: `SM${"c".repeat(32)}` } satisfies SmsDeliveryResult
  })
  const result = await closing.deliver(request())
  assert.deepEqual(result, {
    state: "sent",
    correlationId: "delivery-correlation-168",
    externalId: `SM${"c".repeat(32)}`,
  })
  assert.equal(wouldRecordPitch(result), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.deliveryMode, "never_attempted")
  assert.equal(calls[0]?.senderAccountId, "sms-account-1")
  assert.equal(calls[0]?.transport, overrideTransport)
})

test("MIC-168 reconcile uses reconcile_only and does not treat unknown as sent", async () => {
  const modes: string[] = []
  const closing = createMerchantOfferSmsTransport(actor, "deal-168", undefined, async (_actor, input) => {
    modes.push(input.deliveryMode)
    return { state: "unknown", errorCode: "provider_outcome_unknown" }
  })
  assert.ok(closing.reconcile)
  const result = await closing.reconcile!(request())
  assert.equal(result.state, "blocked")
  assert.equal(result.errorCode, "provider_outcome_unknown")
  assert.equal(wouldRecordPitch(result), false)
  assert.deepEqual(modes, ["reconcile_only"])
})

test("MIC-168 AppError during deliver maps to failed and is not sent", async () => {
  const closing = createMerchantOfferSmsTransport(actor, "deal-168", undefined, async () => {
    throw new AppError(409, "sms_consent_required", "Record merchant SMS consent before sending.")
  })
  const result = await closing.deliver(request())
  assert.deepEqual(result, {
    state: "failed",
    correlationId: "delivery-correlation-168",
    errorCode: "sms_consent_required",
    errorMessage: "Record merchant SMS consent before sending.",
  })
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 failed adapter result from deliver is not treated as sent", async () => {
  const closing = createMerchantOfferSmsTransport(actor, "deal-168", undefined, async () => ({
    state: "failed",
    errorCode: "twilio_unconfigured",
    errorMessage: "Twilio is not configured for this SMS account.",
  }))
  const result = await closing.deliver(request())
  assert.equal(result.state, "failed")
  assert.equal(result.errorCode, "twilio_unconfigured")
  assert.equal(wouldRecordPitch(result), false)
})

test("MIC-168 unexpected deliver errors are not swallowed as sent or failed", async () => {
  const closing = createMerchantOfferSmsTransport(actor, "deal-168", undefined, async () => {
    throw new Error("synthetic network partition")
  })
  await assert.rejects(() => closing.deliver(request()), (error: Error) => error.message === "synthetic network partition")
})
