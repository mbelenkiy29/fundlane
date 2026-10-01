import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  isTwilioFixtureAccountSid,
  resolveTwilioSendScenario,
  twilioFixtureSendResult,
} from "./fixtures"
import {
  mapTwilioHttpResult,
  mapTwilioInbound,
  mapTwilioStatusCallback,
  TWILIO_SLUG,
  twilioBasicAuthorization,
  twilioMessageForm,
  twilioMessagesUrl,
  unknownTwilioOutcome,
  unconfiguredTwilioResult,
  validateTwilioCredentials,
  type TwilioSmsRequest,
  type TwilioSmsTransport,
} from "./mapping"

export {
  TWILIO_FIXTURE_ACCEPTED_RECIPIENT,
  TWILIO_FIXTURE_ACCOUNT_SID,
  TWILIO_FIXTURE_API_KEY_SECRET,
  TWILIO_FIXTURE_API_KEY_SID,
  TWILIO_FIXTURE_AUTH_TOKEN,
  TWILIO_FIXTURE_CREDENTIALS,
  TWILIO_FIXTURE_MESSAGE_SID,
  TWILIO_FIXTURE_MESSAGING_SERVICE_SID,
  TWILIO_FIXTURE_REJECTED_RECIPIENT,
  TWILIO_FIXTURE_SCENARIOS,
  TWILIO_FIXTURE_SENDER,
  TWILIO_FIXTURE_TIMEOUT_RECIPIENT,
  TWILIO_FIXTURE_TRANSPORT,
  TWILIO_OFFICIAL_SIGNATURE_FIXTURE,
  isTwilioFixtureAccountSid,
  twilioFixtureMessageSid,
  twilioInboundFixture,
  twilioStatusCallbackFixture,
  type TwilioFixtureScenario,
} from "./fixtures"
export {
  TWILIO_SLUG,
  mapTwilioHttpResult,
  mapTwilioInbound,
  mapTwilioStatusCallback,
  twilioMessageForm,
  twilioMessagesUrl,
  twilioResultContainsSecret,
  validateTwilioCredentials,
  validateTwilioFormSignature,
  type TwilioSmsRequest,
  type TwilioSmsResult,
  type TwilioSmsTransport,
} from "./mapping"

export function createTwilioSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): TwilioSmsTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async send(request) {
      const form = twilioMessageForm(request)
      try {
        const response = await fetchImpl(twilioMessagesUrl(request.accountSid), {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: twilioBasicAuthorization(request.apiKeySid, request.apiKeySecret),
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          },
          body: form,
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
        const payload = await response.json().catch(() => ({})) as { sid?: unknown; status?: unknown; code?: unknown }
        return mapTwilioHttpResult(response.status, payload)
      } catch {
        return unknownTwilioOutcome()
      }
    },
  }
}

function sendRequest(input: SmsAdapterSendInput): TwilioSmsRequest {
  return {
    accountSid: input.credentials.accountSid?.trim() ?? "",
    apiKeySid: input.credentials.apiKeySid?.trim() ?? "",
    apiKeySecret: input.credentials.apiKeySecret?.trim() ?? "",
    messagingServiceSid: input.credentials.messagingServiceSid,
    senderKind: input.senderKind,
    senderIdentity: input.senderIdentity,
    recipient: input.recipient,
    body: input.body,
    statusCallbackUrl: input.statusCallbackUrl,
    correlationId: input.correlationId,
  }
}

export function createTwilioSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createTwilioSmsTransport(options)
  return {
    slug: TWILIO_SLUG,
    capabilities: { send: true, statusCallbacks: true, inbound: true, optOut: true },
    validate: validateTwilioCredentials,
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "twilio_unconfigured" }
    },
    async send(input) {
      const request = sendRequest(input)
      let result: SmsDeliveryResult
      if (!request.accountSid || !request.apiKeySid || !request.apiKeySecret) {
        result = unconfiguredTwilioResult()
      } else if (!options.fetchImpl && isTwilioFixtureAccountSid(request.accountSid)) {
        result = twilioFixtureSendResult(resolveTwilioSendScenario(input), input.correlationId)
      } else {
        result = await transport.send(request)
      }
      return result
    },
    async parseStatus(_headers, body) {
      return mapTwilioStatusCallback(body)
    },
    async parseInbound(_headers, body) {
      return mapTwilioInbound(body)
    },
  }
}

export const twilioSmsAdapter: SmsAdapter = createTwilioSmsAdapter()
