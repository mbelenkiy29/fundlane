import "server-only"

import type { SmsAdapter, SmsAdapterSendInput, SmsDeliveryResult } from "../../contracts"
import {
  cachedTextTorrentResult,
  rememberTextTorrentResult,
  texttorrentFixtureFetch,
} from "./fixtures"
import {
  TEXTTORRENT_CAPABILITIES,
  TEXTTORRENT_SLUG,
  clientErrorCode,
  e164Pattern,
  isBlacklistedContact,
  isChatAlreadyExists,
  mapAcceptedSend,
  mapCreateChatBody,
  mapSendForm,
  readCreatedChatId,
  readCredentials,
  readInboxChatId,
  sanitizedClientError,
  texttorrentAuthHeaders,
  texttorrentCreateChatUrl,
  texttorrentInboxUrl,
  texttorrentSendUrl,
  unconfiguredResult,
  unknownOutcome,
  validateTextTorrentCredentials,
} from "./mapping"

export {
  TEXTTORRENT_API_BASE,
  TEXTTORRENT_CAPABILITIES,
  TEXTTORRENT_CREATE_CHAT_PATH,
  TEXTTORRENT_INBOX_PATH,
  TEXTTORRENT_SEND_PATH,
  TEXTTORRENT_SLUG,
  clientErrorCode,
  e164Pattern,
  mapAcceptedSend,
  mapCreateChatBody,
  mapSendForm,
  readCredentials,
  texttorrentAuthHeaders,
  texttorrentCreateChatUrl,
  texttorrentInboxUrl,
  texttorrentResultContainsSecret,
  texttorrentSendUrl,
  toReceiverNumber,
  validateTextTorrentCredentials,
} from "./mapping"
export {
  EXPIRED_TEXTTORRENT_SECRET,
  FIXTURE_BODY,
  FIXTURE_CHAT_ID,
  FIXTURE_EXISTING_CHAT_ID,
  FIXTURE_EXISTING_RECIPIENT,
  FIXTURE_MESSAGE_ID,
  FIXTURE_RECIPIENT,
  FIXTURE_REJECTED_NUMBER,
  FIXTURE_SENDER,
  FIXTURE_TIMEOUT_NUMBER,
  SYNTHETIC_API_KEY,
  SYNTHETIC_API_SECRET,
  TEXTTORRENT_FIXTURE_CREDENTIALS,
  TEXTTORRENT_FIXTURE_TRANSPORT,
  listTextTorrentFixtureExternalIds,
  peekTextTorrentFixture,
  resetTextTorrentFixtures,
  texttorrentFixtureFetch,
  texttorrentFixtureSendCallCount,
  texttorrentMessageId,
} from "./fixtures"

export interface TextTorrentSmsTransport {
  send(input: SmsAdapterSendInput): Promise<SmsDeliveryResult>
}

function jsonPayload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}))
}

function senderNumber(input: SmsAdapterSendInput): string {
  const identity = input.senderIdentity.trim()
  if (e164Pattern.test(identity)) return identity
  return readCredentials(input.credentials).sendingNumber
}

export function createTextTorrentSmsTransport(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): TextTorrentSmsTransport {
  const fetchImpl = options.fetchImpl ?? texttorrentFixtureFetch
  const timeoutMs = options.timeoutMs ?? 10_000
  return {
    async send(input) {
      const credentials = readCredentials(input.credentials)
      if (!credentials.apiKey || !credentials.apiSecret) return unconfiguredResult()
      const sender = senderNumber(input)
      const headers = texttorrentAuthHeaders(credentials)
      try {
        const createResponse = await fetchImpl(texttorrentCreateChatUrl(), {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(mapCreateChatBody({ sender, recipient: input.recipient })),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
        const createPayload = await jsonPayload(createResponse)
        let chatId: string | undefined
        if (isBlacklistedContact(createResponse.status, createPayload)) {
          return sanitizedClientError("texttorrent_blacklisted")
        }
        if (isChatAlreadyExists(createResponse.status, createPayload)) {
          const inboxResponse = await fetchImpl(texttorrentInboxUrl(input.recipient), {
            method: "GET",
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          })
          const inboxPayload = await jsonPayload(inboxResponse)
          if (inboxResponse.status >= 400 && inboxResponse.status < 500) {
            return sanitizedClientError(clientErrorCode(inboxPayload, inboxResponse.status))
          }
          if (!inboxResponse.ok) return unknownOutcome()
          chatId = readInboxChatId(inboxPayload, input.recipient)
        } else if (createResponse.status >= 400 && createResponse.status < 500) {
          return sanitizedClientError(clientErrorCode(createPayload, createResponse.status))
        } else if (!createResponse.ok) {
          return unknownOutcome()
        } else {
          chatId = readCreatedChatId(createPayload)
        }
        if (!chatId) return unknownOutcome()

        const sendResponse = await fetchImpl(texttorrentSendUrl(), {
          method: "POST",
          headers,
          body: mapSendForm({
            chatId,
            sender,
            recipient: input.recipient,
            body: input.body,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        })
        const sendPayload = await jsonPayload(sendResponse)
        if (sendResponse.status >= 400 && sendResponse.status < 500) {
          return sanitizedClientError(clientErrorCode(sendPayload, sendResponse.status))
        }
        if (!sendResponse.ok) return unknownOutcome()
        return mapAcceptedSend(sendPayload)
      } catch {
        return unknownOutcome()
      }
    },
  }
}

export function createTextTorrentSmsAdapter(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): SmsAdapter {
  const transport = createTextTorrentSmsTransport(options)
  return {
    slug: TEXTTORRENT_SLUG,
    capabilities: { ...TEXTTORRENT_CAPABILITIES },
    validate(input: unknown) {
      const result = validateTextTorrentCredentials(input)
      return result.ok ? { ok: true } : { ok: false, fields: result.fields }
    },
    async testConnection(account) {
      return account.providerConfigured ? { ok: true } : { ok: false, code: "texttorrent_unconfigured" }
    },
    async send(input: SmsAdapterSendInput) {
      const cached = cachedTextTorrentResult(input.correlationId)
      if (cached) return cached
      const credentials = readCredentials(input.credentials)
      if (!credentials.apiKey || !credentials.apiSecret) {
        return rememberTextTorrentResult(input.correlationId, unconfiguredResult()).result!
      }
      const result = await transport.send(input)
      return rememberTextTorrentResult(input.correlationId, result).result!
    },
  }
}

export const texttorrentSmsAdapter: SmsAdapter = createTextTorrentSmsAdapter()

export default texttorrentSmsAdapter
