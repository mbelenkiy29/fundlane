import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  isTextusFixtureApiKey,
  resolveTextusSendScenario,
  resetTextusFixtures,
  textusFixtureFetch,
  textusFixtureSendResult,
} from "./fixtures"
import {
  TEXTUS_CAPABILITIES,
  TEXTUS_JSONLD,
  TEXTUS_SLUG,
  mapSendBody,
  mapTextusHttpResult,
  mapTextusInbound,
  mapTextusStatusCallback,
  textusBearerAuthorization,
  textusMessagesUrl,
  unknownOutcome,
  unconfiguredResult,
  validateTextusCredentials,
  type TextusSmsRequest,
  type TextusSmsTransport,
} from "./mapping"

export {
  TEXTUS_FIXTURE_ACCEPTED_RECIPIENT,
  TEXTUS_FIXTURE_ACCOUNT_EMAIL,
  TEXTUS_FIXTURE_ACCOUNT_PHONE,
  TEXTUS_FIXTURE_API_KEY,
  TEXTUS_FIXTURE_BODY,
  TEXTUS_FIXTURE_CREDENTIALS,
  TEXTUS_FIXTURE_DELIVERY_ID,
  TEXTUS_FIXTURE_INBOUND_FROM,
  TEXTUS_FIXTURE_INBOUND_MESSAGE_ID,
  TEXTUS_FIXTURE_MESSAGE_ID,
  TEXTUS_FIXTURE_REJECTED_RECIPIENT,
  TEXTUS_FIXTURE_SCENARIOS,
  TEXTUS_FIXTURE_SENDER,
  TEXTUS_FIXTURE_TIMEOUT_RECIPIENT,
  TEXTUS_FIXTURE_TRANSPORT,
  TEXTUS_FIXTURE_WEBHOOK_SECRET,
  EXPIRED_TEXTUS_API_KEY,
  isTextusFixtureApiKey,
  textusFixtureFetch,
  textusFixtureMessageId,
  textusFixtureSendCallCount,
  textusInboundFixture,
  textusOptInFixture,
  textusOptOutFixture,
  textusStatusCallbackFixture,
  resetTextusFixtures,
  type TextusFixtureScenario,
} from "./fixtures"
export {
  ACCOUNT_EMAIL_FIELD,
  API_KEY_FIELD,
  TEXTUS_API_BASE,
  TEXTUS_CAPABILITIES,
  TEXTUS_JSONLD,
  TEXTUS_MESSAGES_PATH,
  TEXTUS_SIGNATURE_HEADER,
  TEXTUS_SLUG,
  mapSendBody,
  mapTextusHttpResult,
  mapTextusInbound,
  mapTextusStatusCallback,
  textusBearerAuthorization,
  textusEventKey,
  textusMessagesUrl,
  textusResultContainsSecret,
  validateTextusCredentials,
  validateTextusSignature,
  type TextusSmsRequest,
  type TextusSmsResult,
  type TextusSmsTransport,
} from "./mapping"

const sends = new Map<string, SmsDeliveryResult>()

export function resetTextusAdapterState(): void {
  sends.clear()
  resetTextusFixtures()
}

export function createTextusSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): TextusSmsTransport {
  const fetchImpl = options.fetchImpl ?? textusFixtureFetch
  return {
    async send(request) {
      try {
        const response = await fetchImpl(textusMessagesUrl(), {
          method: "POST",
          headers: {
            accept: TEXTUS_JSONLD,
            authorization: textusBearerAuthorization(request.apiKey),
            "content-type": TEXTUS_JSONLD,
          },
          body: JSON.stringify(mapSendBody({
            accountEmail: request.accountEmail,
            senderIdentity: request.senderIdentity,
            recipient: request.recipient,
            body: request.body,
          })),
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        })
        const payload = await response.json().catch(() => ({}))
        return mapTextusHttpResult(response.status, payload)
      } catch {
        return unknownOutcome()
      }
    },
  }
}

function sendRequest(input: SmsAdapterSendInput): TextusSmsRequest {
  return {
    accountEmail: input.credentials.accountEmail?.trim() || input.credentials.email?.trim() || "",
    apiKey: input.credentials.apiKey?.trim() || input.credentials.apiToken?.trim() || input.credentials.token?.trim() || "",
    senderKind: input.senderKind,
    senderIdentity: input.senderIdentity,
    recipient: input.recipient,
    body: input.body,
    correlationId: input.correlationId,
  }
}

export function createTextusSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createTextusSmsTransport(options)
  return {
    slug: TEXTUS_SLUG,
    capabilities: { ...TEXTUS_CAPABILITIES },
    validate: validateTextusCredentials,
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "textus_unconfigured" }
    },
    async send(input) {
      const existing = input.correlationId ? sends.get(input.correlationId) : undefined
      if (existing) return existing
      const request = sendRequest(input)
      let result: SmsDeliveryResult
      if (!request.accountEmail || !request.apiKey) {
        result = unconfiguredResult()
      } else if (!options.fetchImpl && isTextusFixtureApiKey(request.apiKey)) {
        result = textusFixtureSendResult(resolveTextusSendScenario(input), input.correlationId)
      } else {
        result = await transport.send(request)
      }
      if (input.correlationId) sends.set(input.correlationId, result)
      return result
    },
    async parseStatus(_headers, body) {
      return mapTextusStatusCallback(body)
    },
    async parseInbound(_headers, body) {
      return mapTextusInbound(body)
    },
  }
}

export const textusSmsAdapter: SmsAdapter = createTextusSmsAdapter()

export default textusSmsAdapter
