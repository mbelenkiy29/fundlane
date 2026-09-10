import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import { messageIdPattern, unconfiguredOpenPhoneResult } from "./mapping"

export const OPENPHONE_FIXTURE_TRANSPORT = "fixture://openphone/messages"

export const OPENPHONE_FIXTURE_API_KEY = "synthetic-openphone-api-key"
export const OPENPHONE_FIXTURE_USER = "USsyntheticuser1"
export const OPENPHONE_FIXTURE_SENDER = "+12125550999"
export const OPENPHONE_FIXTURE_PHONE_NUMBER_ID = "PNsyntheticfrom01"
export const OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT = "+12125550123"
export const OPENPHONE_FIXTURE_REJECTED_RECIPIENT = "+12125550000"
export const OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT = "+12125550998"
export const OPENPHONE_FIXTURE_MESSAGE_ID = "ACsyntheticmessage0001"
export const OPENPHONE_FIXTURE_EVENT_ID = "EVsyntheticdelivered01"
export const OPENPHONE_FIXTURE_INBOUND_MESSAGE_ID = "ACsyntheticinbound0001"
export const OPENPHONE_FIXTURE_INBOUND_EVENT_ID = "EVsyntheticreceived01"
export const OPENPHONE_FIXTURE_BODY = "Exact synthetic OpenPhone preview"

export const OPENPHONE_FIXTURE_CREDENTIALS = {
  apiKey: OPENPHONE_FIXTURE_API_KEY,
  user: OPENPHONE_FIXTURE_USER,
  sendingNumber: OPENPHONE_FIXTURE_SENDER,
}

export const OPENPHONE_FIXTURE_SCENARIOS = ["accepted", "rejected-number", "timeout", "unconfigured"] as const
export type OpenPhoneFixtureScenario = (typeof OPENPHONE_FIXTURE_SCENARIOS)[number]

/** Documented v1 HMAC scheme: `hmac;1;<unix>;<base64>` over `timestamp + "." + JSON.stringify(body)`. */
export const OPENPHONE_SIGNATURE_FIXTURE = {
  signingKey: "c3ludGhldGljLW9wZW5waG9uZS13ZWJob29rLXNlY3JldA==",
  timestamp: "1639710054089",
  signature: "EO8E8BFAJcteyyUzAqNSUVhlmuzlbKUS8Fhej3UtszA=",
  header: "hmac;1;1639710054089;EO8E8BFAJcteyyUzAqNSUVhlmuzlbKUS8Fhej3UtszA=",
  payload: {
    id: OPENPHONE_FIXTURE_EVENT_ID,
    object: "event",
    type: "message.delivered",
    data: {
      object: {
        id: OPENPHONE_FIXTURE_MESSAGE_ID,
        object: "message",
        status: "delivered",
      },
    },
  },
}

export function isOpenPhoneFixtureApiKey(apiKey: string): boolean {
  return apiKey === OPENPHONE_FIXTURE_API_KEY
}

export function openphoneFixtureMessageId(correlationId: string): string {
  const hex = createHash("sha256").update(`openphone:${correlationId}`).digest("hex").slice(0, 32)
  const id = `AC${hex}`
  return messageIdPattern.test(id) ? id : OPENPHONE_FIXTURE_MESSAGE_ID
}

export function resolveOpenPhoneSendScenario(input: { credentials: Record<string, string>; recipient: string }): OpenPhoneFixtureScenario {
  const apiKey = input.credentials.apiKey?.trim() ?? ""
  const user = input.credentials.user?.trim() ?? input.credentials.userId?.trim() ?? ""
  if (!apiKey || !user) return "unconfigured"
  if (input.recipient === OPENPHONE_FIXTURE_REJECTED_RECIPIENT) return "rejected-number"
  if (input.recipient === OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT) return "timeout"
  return "accepted"
}

export function openphoneFixtureSendResult(scenario: OpenPhoneFixtureScenario, correlationId: string): SmsDeliveryResult {
  if (scenario === "unconfigured") return unconfiguredOpenPhoneResult()
  if (scenario === "rejected-number") {
    return { state: "failed", errorCode: "openphone_0200400", errorMessage: "OpenPhone rejected the message. Review the account, sender, recipient, and consent in the provider console." }
  }
  if (scenario === "timeout") {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "OpenPhone did not confirm whether it accepted the message. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId: openphoneFixtureMessageId(correlationId), providerStatus: "queued" }
}

export function openphoneStatusCallbackFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dataOverrides = asObject(overrides.data)
  const objectOverrides = asObject(dataOverrides.object)
  const eventOverrides = omitData(overrides)
  return {
    id: OPENPHONE_FIXTURE_EVENT_ID,
    object: "event",
    apiVersion: "v2",
    createdAt: "2022-01-23T17:05:56.220Z",
    type: "message.delivered",
    data: {
      object: {
        id: OPENPHONE_FIXTURE_MESSAGE_ID,
        object: "message",
        from: OPENPHONE_FIXTURE_SENDER,
        to: OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
        direction: "outgoing",
        body: OPENPHONE_FIXTURE_BODY,
        status: "delivered",
        createdAt: "2022-01-23T17:05:45.195Z",
        userId: OPENPHONE_FIXTURE_USER,
        phoneNumberId: OPENPHONE_FIXTURE_PHONE_NUMBER_ID,
        conversationId: "CNsyntheticconversation1",
        ...objectOverrides,
      },
    },
    ...eventOverrides,
  }
}

export function openphoneInboundFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const dataOverrides = asObject(overrides.data)
  const objectOverrides = asObject(dataOverrides.object)
  const eventOverrides = omitData(overrides)
  return {
    id: OPENPHONE_FIXTURE_INBOUND_EVENT_ID,
    object: "event",
    apiVersion: "v2",
    createdAt: "2022-01-23T16:55:52.557Z",
    type: "message.received",
    data: {
      object: {
        id: OPENPHONE_FIXTURE_INBOUND_MESSAGE_ID,
        object: "message",
        from: OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
        to: OPENPHONE_FIXTURE_SENDER,
        direction: "incoming",
        body: "STOP",
        status: "received",
        createdAt: "2022-01-23T16:55:52.420Z",
        userId: OPENPHONE_FIXTURE_USER,
        phoneNumberId: OPENPHONE_FIXTURE_PHONE_NUMBER_ID,
        conversationId: "CNsyntheticconversation1",
        ...objectOverrides,
      },
    },
    ...eventOverrides,
  }
}

export function openphoneRejectedSendResponse(): { message: string; code: string; status: number; title: string } {
  return { message: "Invalid parameters", code: "0200400", status: 400, title: "Bad Request" }
}

export function openphoneAcceptedSendResponse(correlationId: string): { data: Record<string, unknown> } {
  return {
    data: {
      id: openphoneFixtureMessageId(correlationId),
      to: [OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT],
      from: OPENPHONE_FIXTURE_SENDER,
      text: OPENPHONE_FIXTURE_BODY,
      phoneNumberId: OPENPHONE_FIXTURE_PHONE_NUMBER_ID,
      conversationId: "CNsyntheticconversation1",
      direction: "outgoing",
      userId: OPENPHONE_FIXTURE_USER,
      status: "queued",
      createdAt: "2022-01-01T00:00:00Z",
      updatedAt: "2022-01-01T00:00:00Z",
    },
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function omitData(value: Record<string, unknown>): Record<string, unknown> {
  const next = { ...value }
  delete next.data
  return next
}
