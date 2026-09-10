import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  cachedEntranceResult,
  entranceFixtureFetch,
  rememberEntranceResult,
} from "./fixtures"
import {
  ENTRANCE_CAPABILITIES,
  ENTRANCE_SLUG,
  clientErrorCode,
  entranceLoginUrl,
  entranceMessagesUrl,
  mapInbound,
  mapLoginBody,
  mapSendBody,
  mapAcceptedSend,
  readLoginRecord,
  sanitizedClientError,
  unconfiguredResult,
  unknownOutcome,
  validateEntranceCredentials,
} from "./mapping"

export {
  ENTRANCE_API_BASE,
  ENTRANCE_CAPABILITIES,
  ENTRANCE_LOGIN_PATH,
  ENTRANCE_SLUG,
  entranceLoginUrl,
  entranceMessagesPath,
  entranceMessagesUrl,
  mapChannelId,
  mapInbound,
  mapLoginBody,
  mapSendBody,
  mapAcceptedSend,
  readCredentials,
  readLoginRecord,
  validateEntranceCredentials,
} from "./mapping"
export {
  ENTRANCE_FIXTURE_TRANSPORT,
  EXPIRED_ENTRANCE_SECRET,
  FIXTURE_BODY,
  FIXTURE_CHANNEL_ID,
  FIXTURE_INBOUND_FROM,
  FIXTURE_INBOUND_MESSAGE_ID,
  FIXTURE_INBOUND_TO,
  FIXTURE_RECIPIENT,
  FIXTURE_REJECTED_NUMBER,
  FIXTURE_SENDER,
  FIXTURE_TIMEOUT_NUMBER,
  FIXTURE_WORKSPACE_ID,
  SYNTHETIC_API_SECRET,
  SYNTHETIC_LOGIN_EMAIL,
  entranceFixtureFetch,
  entranceFixtureSendCallCount,
  entranceMessageId,
  fixtureInboundPayload,
  fixtureLoginResponse,
  listEntranceFixtureExternalIds,
  peekEntranceFixture,
  resetEntranceFixtures,
} from "./fixtures"

export interface EntranceSmsTransport {
  send(input: SmsAdapterSendInput): Promise<SmsDeliveryResult>
}

function jsonPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

export function createEntranceSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): EntranceSmsTransport {
  const fetchImpl = options.fetchImpl ?? entranceFixtureFetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    async send(input) {
      const validated = validateEntranceCredentials(input.credentials)
      if (!validated.ok) return unconfiguredResult()
      try {
        const loginResponse = await fetchImpl(entranceLoginUrl(), {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(mapLoginBody(validated.value)),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
        const loginPayload = await jsonPayload(loginResponse)
        if (loginResponse.status >= 400 && loginResponse.status < 500) return sanitizedClientError(clientErrorCode(loginPayload, loginResponse.status))
        if (!loginResponse.ok) return unknownOutcome()
        const session = readLoginRecord(loginPayload)
        if (!session) return unknownOutcome()
        const sendResponse = await fetchImpl(entranceMessagesUrl(session.workspaceId), {
          method: "POST",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(mapSendBody({
            senderIdentity: input.senderIdentity,
            recipient: input.recipient,
            body: input.body,
          })),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
        const sendPayload = await jsonPayload(sendResponse)
        if (sendResponse.status >= 400 && sendResponse.status < 500) return sanitizedClientError(clientErrorCode(sendPayload, sendResponse.status))
        if (!sendResponse.ok) return unknownOutcome()
        return mapAcceptedSend(sendPayload)
      } catch {
        return unknownOutcome()
      }
    },
  }
}

export function createEntranceSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createEntranceSmsTransport(options)
  return {
    slug: ENTRANCE_SLUG,
    capabilities: { ...ENTRANCE_CAPABILITIES },
    validate(input: unknown) {
      const result = validateEntranceCredentials(input)
      return result.ok ? { ok: true } : { ok: false, fields: result.fields }
    },
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "entrance_unconfigured" }
    },
    async send(input: SmsAdapterSendInput) {
      const cached = cachedEntranceResult(input.correlationId)
      if (cached) return cached
      if (!validateEntranceCredentials(input.credentials).ok) {
        return rememberEntranceResult(input.correlationId, unconfiguredResult()).result!
      }
      const result = await transport.send(input)
      return rememberEntranceResult(input.correlationId, result).result!
    },
    async parseInbound(_headers, body) {
      return mapInbound(body)
    },
  }
}

export const entranceSmsAdapter: SmsAdapter = createEntranceSmsAdapter()

export default entranceSmsAdapter
