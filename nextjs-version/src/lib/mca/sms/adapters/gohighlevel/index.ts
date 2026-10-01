import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  gohighlevelFixtureSendResult,
  isGohighlevelFixtureToken,
  resolveGohighlevelSendScenario,
} from "./fixtures"
import {
  GOHIGHLEVEL_CAPABILITIES,
  GOHIGHLEVEL_SLUG,
  ghlDuplicateContactUrl,
  ghlMessagesUrl,
  ghlRequestHeaders,
  ghlUpsertContactUrl,
  mapGhlHttpResult,
  mapGhlSendBody,
  mapGhlUpsertBody,
  mapGohighlevelInbound,
  mapGohighlevelStatusCallback,
  readGhlContactId,
  readGohighlevelCredentials,
  sanitizedGhlClientError,
  ghlClientErrorCode,
  unconfiguredGohighlevelResult,
  unknownGohighlevelOutcome,
  validateGohighlevelCredentials,
  type GohighlevelSmsRequest,
  type GohighlevelSmsTransport,
} from "./mapping"

export {
  GOHIGHLEVEL_FIXTURE_ACCEPTED_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_BODY,
  GOHIGHLEVEL_FIXTURE_CONTACT_ID,
  GOHIGHLEVEL_FIXTURE_CONVERSATION_ID,
  GOHIGHLEVEL_FIXTURE_CREDENTIALS,
  GOHIGHLEVEL_FIXTURE_LOCATION_ID,
  GOHIGHLEVEL_FIXTURE_MESSAGE_ID,
  GOHIGHLEVEL_FIXTURE_NEW_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_REJECTED_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_SCENARIOS,
  GOHIGHLEVEL_FIXTURE_SENDER,
  GOHIGHLEVEL_FIXTURE_TIMEOUT_RECIPIENT,
  GOHIGHLEVEL_FIXTURE_TOKEN,
  GOHIGHLEVEL_FIXTURE_TRANSPORT,
  GOHIGHLEVEL_EXPIRED_TOKEN,
  gohighlevelFixtureFetch,
  gohighlevelFixtureMessageId,
  gohighlevelInboundFixture,
  gohighlevelStatusCallbackFixture,
  isGohighlevelFixtureToken,
  resetGohighlevelFixtures,
  type GohighlevelFixtureScenario,
} from "./fixtures"
export {
  GHL_API_BASE,
  GHL_API_VERSION,
  GHL_ED25519_PUBLIC_KEY,
  GOHIGHLEVEL_CAPABILITIES,
  GOHIGHLEVEL_SLUG,
  LOCATION_ID_FIELD,
  PRIVATE_INTEGRATION_TOKEN_FIELD,
  ghlAuthorization,
  ghlDuplicateContactUrl,
  ghlEventKey,
  ghlMessagesUrl,
  ghlRequestHeaders,
  ghlSignatureFromHeaders,
  ghlUpsertContactUrl,
  gohighlevelResultContainsSecret,
  mapGhlSendBody,
  mapGhlUpsertBody,
  mapGohighlevelInbound,
  mapGohighlevelStatusCallback,
  validateGhlWebhookSignature,
  validateGohighlevelCredentials,
  type GohighlevelSmsRequest,
  type GohighlevelSmsTransport,
} from "./mapping"

function jsonPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

async function resolveContactId(
  fetchImpl: typeof fetch,
  request: GohighlevelSmsRequest,
  timeoutMs: number,
): Promise<{ ok: true; contactId: string } | { ok: false; result: SmsDeliveryResult }> {
  const headers = ghlRequestHeaders(request.privateIntegrationToken)
  try {
    const lookup = await fetchImpl(ghlDuplicateContactUrl(request.locationId, request.recipient), {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
    const lookupPayload = await jsonPayload(lookup)
    if (lookup.status >= 400 && lookup.status < 500) return { ok: false, result: sanitizedGhlClientError(ghlClientErrorCode(lookupPayload, lookup.status)) }
    if (!lookup.ok && lookup.status !== 404) return { ok: false, result: unknownGohighlevelOutcome() }
    const existingId = lookup.ok ? readGhlContactId(lookupPayload) : undefined
    if (existingId) return { ok: true, contactId: existingId }

    const upsert = await fetchImpl(ghlUpsertContactUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify(mapGhlUpsertBody(request.locationId, request.recipient)),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    })
    const upsertPayload = await jsonPayload(upsert)
    if (upsert.status >= 400 && upsert.status < 500) return { ok: false, result: sanitizedGhlClientError(ghlClientErrorCode(upsertPayload, upsert.status)) }
    if (!upsert.ok) return { ok: false, result: unknownGohighlevelOutcome() }
    const createdId = readGhlContactId(upsertPayload)
    if (!createdId) return { ok: false, result: unknownGohighlevelOutcome() }
    return { ok: true, contactId: createdId }
  } catch {
    return { ok: false, result: unknownGohighlevelOutcome() }
  }
}

export function createGohighlevelSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): GohighlevelSmsTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    async send(request) {
      const contact = await resolveContactId(fetchImpl, request, timeoutMs)
      if (!contact.ok) return contact.result
      try {
        const response = await fetchImpl(ghlMessagesUrl(), {
          method: "POST",
          headers: ghlRequestHeaders(request.privateIntegrationToken),
          body: JSON.stringify(mapGhlSendBody({
            contactId: contact.contactId,
            recipient: request.recipient,
            body: request.body,
            senderIdentity: request.senderIdentity,
          })),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
        return mapGhlHttpResult(response.status, await jsonPayload(response))
      } catch {
        return unknownGohighlevelOutcome()
      }
    },
  }
}

function sendRequest(input: SmsAdapterSendInput): GohighlevelSmsRequest {
  const credentials = readGohighlevelCredentials(input.credentials)
  return {
    privateIntegrationToken: credentials.privateIntegrationToken,
    locationId: credentials.locationId,
    senderIdentity: input.senderIdentity,
    recipient: input.recipient,
    body: input.body,
    correlationId: input.correlationId,
  }
}

export function createGohighlevelSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createGohighlevelSmsTransport(options)
  return {
    slug: GOHIGHLEVEL_SLUG,
    capabilities: { ...GOHIGHLEVEL_CAPABILITIES },
    validate(input: unknown) {
      const result = validateGohighlevelCredentials(input)
      return result.ok ? { ok: true } : { ok: false, fields: result.fields }
    },
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "gohighlevel_unconfigured" }
    },
    async send(input) {
      const request = sendRequest(input)
      let result: SmsDeliveryResult
      if (!request.privateIntegrationToken || !request.locationId) {
        result = unconfiguredGohighlevelResult()
      } else if (!options.fetchImpl && isGohighlevelFixtureToken(request.privateIntegrationToken)) {
        result = gohighlevelFixtureSendResult(resolveGohighlevelSendScenario(input), input.correlationId)
      } else {
        result = await transport.send(request)
      }
      return result
    },
    async parseStatus(_headers, body) {
      return mapGohighlevelStatusCallback(body)
    },
    async parseInbound(_headers, body) {
      return mapGohighlevelInbound(body)
    },
  }
}

export const gohighlevelSmsAdapter: SmsAdapter = createGohighlevelSmsAdapter()
