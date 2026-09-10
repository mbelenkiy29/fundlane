import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import { TEXTUS_JSONLD, textusMessagesUrl, unconfiguredResult } from "./mapping"

export const TEXTUS_FIXTURE_TRANSPORT = "fixture://textus/messages"

export const TEXTUS_FIXTURE_ACCOUNT_EMAIL = "textus.operator@example.test"
export const TEXTUS_FIXTURE_API_KEY = "synthetic-textus-api-key-never-leak"
export const TEXTUS_FIXTURE_WEBHOOK_SECRET = "synthetic-textus-webhook-secret"
export const EXPIRED_TEXTUS_API_KEY = "expired-textus-api-key"

export const TEXTUS_FIXTURE_SENDER = "+12125550999"
export const TEXTUS_FIXTURE_ACCEPTED_RECIPIENT = "+12125550123"
export const TEXTUS_FIXTURE_REJECTED_RECIPIENT = "+15550000999"
export const TEXTUS_FIXTURE_TIMEOUT_RECIPIENT = "+15550000998"
export const TEXTUS_FIXTURE_BODY = "Exact synthetic TextUs preview"
export const TEXTUS_FIXTURE_MESSAGE_ID = "/messages/QNDkpL"
export const TEXTUS_FIXTURE_DELIVERY_ID = "/integrations/LmKXZl/deliveries/6ZKqx04"
export const TEXTUS_FIXTURE_INBOUND_MESSAGE_ID = "/messages/6Nvq9L"
export const TEXTUS_FIXTURE_INBOUND_FROM = "+13035551234"
export const TEXTUS_FIXTURE_ACCOUNT_PHONE = "+13035551000"

export const TEXTUS_FIXTURE_CREDENTIALS = {
  accountEmail: TEXTUS_FIXTURE_ACCOUNT_EMAIL,
  apiKey: TEXTUS_FIXTURE_API_KEY,
  sendingNumber: TEXTUS_FIXTURE_SENDER,
}

export const TEXTUS_FIXTURE_SCENARIOS = ["accepted", "rejected-number", "timeout", "unconfigured"] as const
export type TextusFixtureScenario = (typeof TEXTUS_FIXTURE_SCENARIOS)[number]

const timedOutRecipients = new Set<string>()
let sendCallCount = 0

export function resetTextusFixtures(): void {
  timedOutRecipients.clear()
  sendCallCount = 0
}

export function textusFixtureSendCallCount(): number {
  return sendCallCount
}

export function isTextusFixtureApiKey(apiKey: string): boolean {
  return apiKey === TEXTUS_FIXTURE_API_KEY
}

export function textusFixtureMessageId(correlationId: string): string {
  const hex = createHash("sha256").update(`textus:${correlationId}`).digest("hex").slice(0, 10)
  return `/messages/${hex}`
}

export function resolveTextusSendScenario(input: { credentials: Record<string, string>; recipient: string }): TextusFixtureScenario {
  const accountEmail = input.credentials.accountEmail?.trim() || input.credentials.email?.trim() || ""
  const apiKey = input.credentials.apiKey?.trim() || input.credentials.apiToken?.trim() || input.credentials.token?.trim() || ""
  if (!accountEmail || !apiKey) return "unconfigured"
  if (input.recipient === TEXTUS_FIXTURE_REJECTED_RECIPIENT) return "rejected-number"
  if (input.recipient === TEXTUS_FIXTURE_TIMEOUT_RECIPIENT) return "timeout"
  return "accepted"
}

export function textusFixtureSendResult(scenario: TextusFixtureScenario, correlationId: string): SmsDeliveryResult {
  if (scenario === "unconfigured") return unconfiguredResult()
  if (scenario === "rejected-number") {
    return { state: "failed", errorCode: "textus_invalid_number", errorMessage: "TextUs rejected the message. Review the account, sender, recipient, and consent in the provider console." }
  }
  if (scenario === "timeout") {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "TextUs did not confirm whether it accepted the message. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId: textusFixtureMessageId(correlationId), providerStatus: "queued" }
}

/** Public-docs Message send envelope. https://apidocs.next.textus.com/docs/messages/send_without_account/ */
export function fixtureAcceptedSendResponse(messageId: string): unknown {
  return {
    "@type": "Message",
    id: messageId,
    "@context": "/contexts/Message.jsonld",
    direction: "out",
    body: TEXTUS_FIXTURE_BODY,
    deliveryState: "queued",
    status: "queued",
    conversation: "/conversations/kY1QwY",
    channel: "sms",
  }
}

export function fixtureRejectedSendResponse(): unknown {
  return { "@type": "hydra:Error", "hydra:title": "Unprocessable Entity", code: "invalid_number" }
}

/** Public-docs message.delivered webhook. https://apidocs.next.textus.com/overview/webhooks/webhooks-overview/ */
export function textusStatusCallbackFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@context": "/contexts/WebhookDelivery.jsonld",
    "@type": "WebhookDelivery",
    action: "message.delivered",
    id: TEXTUS_FIXTURE_DELIVERY_ID,
    timestamp: "2023-11-17T13:59:04.568354-05:00",
    webHook: "/integrations/LmKXZl",
    conversation: {
      "@type": "Conversation",
      id: "/conversations/OO86d7o",
      phoneNumber: TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
      accountPhoneNumber: TEXTUS_FIXTURE_SENDER,
    },
    message: {
      "@type": "Message",
      id: TEXTUS_FIXTURE_MESSAGE_ID,
      deliveryState: "delivered",
      status: "delivered",
      direction: "out",
      body: TEXTUS_FIXTURE_BODY,
    },
    ...overrides,
  }
}

/** Public-docs message.received webhook. */
export function textusInboundFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@type": "WebhookDelivery",
    "@context": "/contexts/WebhookDelivery.jsonld",
    id: "/integrations/h13Jc5/deliveries/xyz",
    timestamp: "2018-07-24T20:59:32.156Z",
    action: "message.received",
    conversation: {
      "@type": "Conversation",
      id: "/conversations/JYnJBY",
      phoneNumber: TEXTUS_FIXTURE_INBOUND_FROM,
      accountPhoneNumber: TEXTUS_FIXTURE_ACCOUNT_PHONE,
    },
    message: {
      "@type": "Message",
      id: TEXTUS_FIXTURE_INBOUND_MESSAGE_ID,
      direction: "in",
      body: "Hi, let's set a meeting for August 14th at 2 PM.",
      status: "received",
    },
    ...overrides,
  }
}

/** Public-docs contact.opted_out webhook. */
export function textusOptOutFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "@type": "OptOutWebhookDelivery",
    "@context": "/contexts/OptOutWebhookDelivery.jsonld",
    id: "/integrations/KYxmBL/deliveries/f8db6d71-04bd-47cb-9983-d6fd2015ce3b",
    action: "contact.opted_out",
    timestamp: "2021-07-27T18:48:16.878086+00:00",
    optOut: {
      "@type": "OptOut",
      id: "/textus/opt_outs/50711",
      type: "opt-out",
      phoneNumber: TEXTUS_FIXTURE_INBOUND_FROM,
      formattedPhoneNumber: "(303) 555-1234",
      account: "/accounts/textus",
    },
    ...overrides,
  }
}

export function textusOptInFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return textusOptOutFixture({
    action: "contact.opted_in",
    optOut: {
      "@type": "OptOut",
      id: "/textus/opt_outs/50712",
      type: "opt-in",
      phoneNumber: TEXTUS_FIXTURE_INBOUND_FROM,
      formattedPhoneNumber: "(303) 555-1234",
      account: "/accounts/textus",
    },
    ...overrides,
  })
}

export async function textusFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()
  const rawBody = typeof init?.body === "string" ? init.body : ""
  const payload = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}
  const authorization = new Headers(init?.headers).get("authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""

  if (method === "POST" && url === textusMessagesUrl()) {
    sendCallCount += 1
    if (!token || token === EXPIRED_TEXTUS_API_KEY) {
      return new Response(JSON.stringify({ "hydra:title": "Unauthorized", code: "unauthorized" }), { status: 401, headers: { "content-type": TEXTUS_JSONLD } })
    }
    const recipient = typeof payload.to === "string" ? payload.to : ""
    if (recipient === TEXTUS_FIXTURE_TIMEOUT_RECIPIENT && !timedOutRecipients.has(recipient)) {
      timedOutRecipients.add(recipient)
      throw new TypeError("response lost")
    }
    if (recipient === TEXTUS_FIXTURE_REJECTED_RECIPIENT) {
      return new Response(JSON.stringify(fixtureRejectedSendResponse()), { status: 422, headers: { "content-type": TEXTUS_JSONLD } })
    }
    const email = typeof payload.email === "string" ? payload.email : ""
    const body = typeof payload.body === "string" ? payload.body : ""
    const id = textusFixtureMessageId(`${email}:${recipient}:${body}`)
    return new Response(JSON.stringify(fixtureAcceptedSendResponse(id)), { status: 201, headers: { "content-type": TEXTUS_JSONLD } })
  }

  return new Response("not found", { status: 404 })
}
