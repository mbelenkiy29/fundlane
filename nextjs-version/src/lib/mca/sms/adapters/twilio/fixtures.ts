import "server-only"

import { createHash } from "node:crypto"
import type { SmsDeliveryResult } from "../../contracts"
import { messageSidPattern, unconfiguredTwilioResult } from "./mapping"

export const TWILIO_SLUG = "twilio"
export const TWILIO_FIXTURE_TRANSPORT = "fixture://twilio/messages"

export const TWILIO_FIXTURE_ACCOUNT_SID = `AC${"a".repeat(32)}`
export const TWILIO_FIXTURE_API_KEY_SID = `SK${"b".repeat(32)}`
export const TWILIO_FIXTURE_API_KEY_SECRET = "synthetic-api-secret"
export const TWILIO_FIXTURE_AUTH_TOKEN = "synthetic-auth-token"
export const TWILIO_FIXTURE_SENDER = "+12125550999"
export const TWILIO_FIXTURE_MESSAGING_SERVICE_SID = `MG${"a".repeat(32)}`
export const TWILIO_FIXTURE_ACCEPTED_RECIPIENT = "+12125550123"
export const TWILIO_FIXTURE_REJECTED_RECIPIENT = "+12125550000"
export const TWILIO_FIXTURE_TIMEOUT_RECIPIENT = "+12125550998"
export const TWILIO_FIXTURE_MESSAGE_SID = `SM${"c".repeat(32)}`

export const TWILIO_FIXTURE_CREDENTIALS = {
  accountSid: TWILIO_FIXTURE_ACCOUNT_SID,
  apiKeySid: TWILIO_FIXTURE_API_KEY_SID,
  apiKeySecret: TWILIO_FIXTURE_API_KEY_SECRET,
  sendingNumber: TWILIO_FIXTURE_SENDER,
}

export const TWILIO_FIXTURE_SCENARIOS = ["accepted", "rejected-number", "timeout", "unconfigured"] as const
export type TwilioFixtureScenario = (typeof TWILIO_FIXTURE_SCENARIOS)[number]

export const TWILIO_OFFICIAL_SIGNATURE_FIXTURE = {
  authToken: "12345",
  signature: "L/OH5YylLD5NRKLltdqwSvS0BnU=",
  url: "https://example.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  },
}

export function isTwilioFixtureAccountSid(accountSid: string): boolean {
  return accountSid === TWILIO_FIXTURE_ACCOUNT_SID
}

export function twilioFixtureMessageSid(correlationId: string): string {
  const hex = createHash("sha256").update(`twilio:${correlationId}`).digest("hex").slice(0, 32)
  const sid = `SM${hex}`
  return messageSidPattern.test(sid) ? sid : TWILIO_FIXTURE_MESSAGE_SID
}

export function resolveTwilioSendScenario(input: { credentials: Record<string, string>; recipient: string }): TwilioFixtureScenario {
  const accountSid = input.credentials.accountSid?.trim() ?? ""
  const apiKeySid = input.credentials.apiKeySid?.trim() ?? ""
  const apiKeySecret = input.credentials.apiKeySecret?.trim() ?? ""
  if (!accountSid || !apiKeySid || !apiKeySecret) return "unconfigured"
  if (input.recipient === TWILIO_FIXTURE_REJECTED_RECIPIENT) return "rejected-number"
  if (input.recipient === TWILIO_FIXTURE_TIMEOUT_RECIPIENT) return "timeout"
  return "accepted"
}

export function twilioFixtureSendResult(scenario: TwilioFixtureScenario, correlationId: string): SmsDeliveryResult {
  if (scenario === "unconfigured") return unconfiguredTwilioResult()
  if (scenario === "rejected-number") {
    return { state: "failed", errorCode: "twilio_21614", errorMessage: "Twilio rejected the message (code 21614). Review the account, sender, recipient, and consent in the provider console." }
  }
  if (scenario === "timeout") {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Twilio did not confirm whether it accepted the message. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId: twilioFixtureMessageSid(correlationId), providerStatus: "queued" }
}

export function twilioStatusCallbackFixture(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: TWILIO_FIXTURE_ACCOUNT_SID,
    MessageSid: TWILIO_FIXTURE_MESSAGE_SID,
    MessageStatus: "delivered",
    To: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    From: TWILIO_FIXTURE_SENDER,
    ...overrides,
  }
}

export function twilioInboundFixture(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: TWILIO_FIXTURE_ACCOUNT_SID,
    MessageSid: `SM${"f".repeat(32)}`,
    From: TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
    To: TWILIO_FIXTURE_SENDER,
    OptOutType: "STOP",
    ...overrides,
  }
}
