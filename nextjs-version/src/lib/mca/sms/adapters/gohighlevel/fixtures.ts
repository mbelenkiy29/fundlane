import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import {
  GHL_API_BASE,
  GHL_CONTACTS_DUPLICATE_PATH,
  ghlMessagesUrl,
  ghlUpsertContactUrl,
  unconfiguredGohighlevelResult,
} from "./mapping"

export const GOHIGHLEVEL_FIXTURE_TRANSPORT = "fixture://gohighlevel/conversations/messages"

export const GOHIGHLEVEL_FIXTURE_TOKEN = "pit-ghl-synthetic-never-leak"
export const GOHIGHLEVEL_EXPIRED_TOKEN = "pit-ghl-expired-synthetic"
export const GOHIGHLEVEL_FIXTURE_LOCATION_ID = "GhlFxLocation0000001"
export const GOHIGHLEVEL_FIXTURE_CONTACT_ID = "GhlFxContact00000001"
export const GOHIGHLEVEL_FIXTURE_CONVERSATION_ID = "GhlFxConvo0000000001"
export const GOHIGHLEVEL_FIXTURE_MESSAGE_ID = "GhlFxMessage00000001"
export const GOHIGHLEVEL_FIXTURE_SENDER = "+12125550999"
export const GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT = "+12125550123"
export const GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT = "+12125550000"
export const GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT = "+12125550998"
export const GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT = "+12125550124"
export const GOHIGHLEVEL_FIXTURE_BODY = "Exact synthetic GoHighLevel preview"

export const GOHIGHLEVEL_FIXTURE_CREDENTIALS = {
  privateIntegrationToken: GOHIGHLEVEL_FIXTURE_TOKEN,
  locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
}

export const GOHIGHLEVEL_FIXTURE_SCENARIOS = ["accepted", "rejected-number", "timeout", "unconfigured"] as const
export type GohighlevelFixtureScenario = (typeof GOHIGHLEVEL_FIXTURE_SCENARIOS)[number]

export function isGohighlevelFixtureToken(token: string): boolean {
  return token === GOHIGHLEVEL_FIXTURE_TOKEN
}

export function gohighlevelFixtureMessageId(correlationId: string): string {
  return createHash("sha256").update(`gohighlevel:${correlationId}`).digest("hex").slice(0, 20)
}

export function resolveGohighlevelSendScenario(input: { credentials: Record<string, string>; recipient: string }): GohighlevelFixtureScenario {
  const token = input.credentials.privateIntegrationToken?.trim() || input.credentials.token?.trim() || ""
  const locationId = input.credentials.locationId?.trim() || input.credentials.location?.trim() || ""
  if (!token || !locationId) return "unconfigured"
  if (input.recipient === GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT) return "rejected-number"
  if (input.recipient === GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT) return "timeout"
  return "accepted"
}

export function gohighlevelFixtureSendResult(scenario: GohighlevelFixtureScenario, correlationId: string): SmsDeliveryResult {
  if (scenario === "unconfigured") return unconfiguredGohighlevelResult()
  if (scenario === "rejected-number") {
    return {
      state: "failed",
      errorCode: "gohighlevel_invalid_phone",
      errorMessage: "GoHighLevel rejected the message. Review the account, location, sender, recipient, and consent in the provider console.",
    }
  }
  if (scenario === "timeout") {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "GoHighLevel did not confirm whether it accepted the message. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId: gohighlevelFixtureMessageId(correlationId), providerStatus: "pending" }
}

export function gohighlevelStatusCallbackFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "OutboundMessage",
    locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
    messageId: GOHIGHLEVEL_FIXTURE_MESSAGE_ID,
    contactId: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
    conversationId: GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
    contentType: "text/plain",
    dateAdded: "2026-09-08T12:00:00.000Z",
    direction: "outbound",
    messageType: "SMS",
    source: "api",
    status: "delivered",
    from: GOHIGHLEVEL_FIXTURE_SENDER,
    to: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    messageTypeId: 2,
    messageTypeString: "TYPE_SMS",
    ...overrides,
  }
}

export function gohighlevelInboundFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "InboundMessage",
    locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
    attachments: [],
    body: "STOP",
    contactId: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
    contentType: "text/plain",
    conversationId: GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
    dateAdded: "2026-09-08T12:00:00.000Z",
    direction: "inbound",
    messageType: "SMS",
    status: "delivered",
    messageId: "GhlFxInbound00000001",
    from: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    to: GOHIGHLEVEL_FIXTURE_SENDER,
    messageTypeId: 2,
    messageTypeString: "TYPE_SMS",
    ...overrides,
  }
}

export function fixtureDuplicateContactResponse(): { contact: { id: string; locationId: string; phone: string } } {
  return {
    contact: {
      id: GOHIGHLEVEL_FIXTURE_CONTACT_ID,
      locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID,
      phone: GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
    },
  }
}

export function fixtureUpsertContactResponse(contactId: string): { new: boolean; contact: { id: string; locationId: string } } {
  return { new: true, contact: { id: contactId, locationId: GOHIGHLEVEL_FIXTURE_LOCATION_ID } }
}

export function fixtureSendResponse(messageId: string): { conversationId: string; messageId: string; msg: string } {
  return {
    conversationId: GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
    messageId,
    msg: "Message queued successfully.",
  }
}

const timedOutRecipients = new Set<string>()

export function resetGohighlevelFixtures(): void {
  timedOutRecipients.clear()
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

function requestPayload(init?: RequestInit): Record<string, unknown> {
  const rawBody = typeof init?.body === "string" ? init.body : ""
  if (!rawBody) return {}
  try {
    return JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return {}
  }
}

function bearerToken(init?: RequestInit): string {
  const authorization = new Headers(init?.headers).get("authorization") ?? ""
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
}

export async function gohighlevelFixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const method = (init?.method ?? "GET").toUpperCase()
  const token = bearerToken(init)
  if (!token || token === GOHIGHLEVEL_EXPIRED_TOKEN) {
    return jsonResponse(401, { statusCode: 401, error: "unauthorized" })
  }

  if (method === "GET" && url.startsWith(`${GHL_API_BASE}${GHL_CONTACTS_DUPLICATE_PATH}`)) {
    const parsed = new URL(url)
    const number = parsed.searchParams.get("number") ?? ""
    if (number === GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT && !timedOutRecipients.has(number)) {
      timedOutRecipients.add(number)
      throw new TypeError("response lost")
    }
    if (number === GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT) return jsonResponse(200, {})
    if (number === GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT || number === GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT || number === GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT) {
      return jsonResponse(200, fixtureDuplicateContactResponse())
    }
    return jsonResponse(200, {})
  }

  if (method === "POST" && url === ghlUpsertContactUrl()) {
    const payload = requestPayload(init)
    const phone = typeof payload.phone === "string" ? payload.phone : ""
    const contactId = createHash("sha256").update(`ghl-contact:${phone}`).digest("hex").slice(0, 20)
    return jsonResponse(200, fixtureUpsertContactResponse(contactId))
  }

  if (method === "POST" && url === ghlMessagesUrl()) {
    const payload = requestPayload(init)
    const toNumber = typeof payload.toNumber === "string" ? payload.toNumber : ""
    if (toNumber === GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT && !timedOutRecipients.has(toNumber)) {
      timedOutRecipients.add(toNumber)
      throw new TypeError("response lost")
    }
    if (toNumber === GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT) {
      return jsonResponse(400, { code: "invalid_phone" })
    }
    const messageId = createHash("sha256").update(`ghl-send:${token}:${toNumber}:${typeof payload.message === "string" ? payload.message : ""}`).digest("hex").slice(0, 20)
    return jsonResponse(200, fixtureSendResponse(messageId))
  }

  return new Response("not found", { status: 404 })
}


