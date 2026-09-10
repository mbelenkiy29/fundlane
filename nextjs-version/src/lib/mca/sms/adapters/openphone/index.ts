import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  isOpenPhoneFixtureApiKey,
  openphoneFixtureSendResult,
  resolveOpenPhoneSendScenario,
} from "./fixtures"
import {
  OPENPHONE_CAPABILITIES,
  OPENPHONE_SLUG,
  mapOpenPhoneHttpResult,
  mapOpenPhoneInbound,
  mapOpenPhoneStatusCallback,
  mapSendBody,
  openphoneAuthorization,
  openphoneMessagesUrl,
  unconfiguredOpenPhoneResult,
  unknownOpenPhoneOutcome,
  validateOpenPhoneCredentials,
  type OpenPhoneSmsRequest,
  type OpenPhoneSmsTransport,
} from "./mapping"

export {
  OPENPHONE_FIXTURE_ACCEPTED_RECIPIENT,
  OPENPHONE_FIXTURE_API_KEY,
  OPENPHONE_FIXTURE_BODY,
  OPENPHONE_FIXTURE_CREDENTIALS,
  OPENPHONE_FIXTURE_EVENT_ID,
  OPENPHONE_FIXTURE_INBOUND_EVENT_ID,
  OPENPHONE_FIXTURE_INBOUND_MESSAGE_ID,
  OPENPHONE_FIXTURE_MESSAGE_ID,
  OPENPHONE_FIXTURE_PHONE_NUMBER_ID,
  OPENPHONE_FIXTURE_REJECTED_RECIPIENT,
  OPENPHONE_FIXTURE_SCENARIOS,
  OPENPHONE_FIXTURE_SENDER,
  OPENPHONE_FIXTURE_TIMEOUT_RECIPIENT,
  OPENPHONE_FIXTURE_TRANSPORT,
  OPENPHONE_FIXTURE_USER,
  OPENPHONE_SIGNATURE_FIXTURE,
  isOpenPhoneFixtureApiKey,
  openphoneFixtureMessageId,
  openphoneInboundFixture,
  openphoneStatusCallbackFixture,
  type OpenPhoneFixtureScenario,
} from "./fixtures"
export {
  OPENPHONE_API_BASE,
  OPENPHONE_CAPABILITIES,
  OPENPHONE_MESSAGES_PATH,
  OPENPHONE_SLUG,
  mapOpenPhoneHttpResult,
  mapOpenPhoneInbound,
  mapOpenPhoneStatusCallback,
  mapSendBody,
  openphoneMessagesUrl,
  openphoneResultContainsSecret,
  validateOpenPhoneCredentials,
  validateOpenPhoneSignature,
  type OpenPhoneSmsRequest,
  type OpenPhoneSmsResult,
  type OpenPhoneSmsTransport,
} from "./mapping"

const sends = new Map<string, SmsDeliveryResult>()

export function resetOpenPhoneAdapterState(): void {
  sends.clear()
}

export function createOpenPhoneSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): OpenPhoneSmsTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    async send(request) {
      try {
        const response = await fetchImpl(openphoneMessagesUrl(), {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: openphoneAuthorization(request.apiKey),
            "content-type": "application/json",
          },
          body: JSON.stringify(mapSendBody(request)),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
        const payload = await response.json().catch(() => ({}))
        return mapOpenPhoneHttpResult(response.status, payload)
      } catch {
        return unknownOpenPhoneOutcome()
      }
    },
  }
}

function sendRequest(input: SmsAdapterSendInput): OpenPhoneSmsRequest {
  return {
    apiKey: input.credentials.apiKey?.trim() ?? "",
    user: input.credentials.user?.trim() || input.credentials.userId?.trim() || "",
    senderIdentity: input.senderIdentity,
    recipient: input.recipient,
    body: input.body,
    correlationId: input.correlationId,
  }
}

export function createOpenPhoneSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createOpenPhoneSmsTransport(options)
  return {
    slug: OPENPHONE_SLUG,
    capabilities: { ...OPENPHONE_CAPABILITIES },
    validate: validateOpenPhoneCredentials,
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "openphone_unconfigured" }
    },
    async send(input) {
      const existing = input.correlationId ? sends.get(input.correlationId) : undefined
      if (existing) return existing
      const request = sendRequest(input)
      let result: SmsDeliveryResult
      if (!request.apiKey || !request.user) {
        result = unconfiguredOpenPhoneResult()
      } else if (!options.fetchImpl && isOpenPhoneFixtureApiKey(request.apiKey)) {
        result = openphoneFixtureSendResult(resolveOpenPhoneSendScenario(input), input.correlationId)
      } else {
        result = await transport.send(request)
      }
      if (input.correlationId) sends.set(input.correlationId, result)
      return result
    },
    async parseStatus(_headers, body) {
      return mapOpenPhoneStatusCallback(body)
    },
    async parseInbound(_headers, body) {
      return mapOpenPhoneInbound(body)
    },
  }
}

export const openphoneSmsAdapter: SmsAdapter = createOpenPhoneSmsAdapter()
