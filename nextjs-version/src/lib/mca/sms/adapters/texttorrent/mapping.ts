import "server-only"

import type { SmsDeliveryResult } from "../../contracts"

export const TEXTTORRENT_SLUG = "texttorrent" as const

/** Public TextTorrent API. https://texttorrent.com/docs/api base `https://api.texttorrent.com`. */
export const TEXTTORRENT_API_BASE = "https://api.texttorrent.com"

export const TEXTTORRENT_CREATE_CHAT_PATH = "/api/v1/inbox/chat/create"
export const TEXTTORRENT_SEND_PATH = "/api/v1/inbox/chat"
export const TEXTTORRENT_INBOX_PATH = "/api/v1/inbox"

export const TEXTTORRENT_CAPABILITIES = {
  send: true as const,
  statusCallbacks: false,
  inbound: false,
  optOut: false,
}

export const API_KEY_FIELD = "apiKey"
export const API_SECRET_FIELD = "apiSecret"
export const SENDING_NUMBER_FIELD = "sendingNumber"

export const e164Pattern = /^\+[1-9]\d{7,14}$/

const alreadyStartedPattern = /already started a chat/i
const blacklistedPattern = /blacklisted/i

export interface TextTorrentCredentials {
  apiKey: string
  apiSecret: string
  sendingNumber: string
}

export interface TextTorrentCreateChatBody {
  receiver_number: string
  sender_id: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function firstText(record: Record<string, unknown> | undefined, keys: string[]): string {
  if (!record) return ""
  for (const key of keys) {
    const value = text(record[key])
    if (value) return value
  }
  return ""
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "")
}

/** Public create-chat `receiver_number` is NANP 10 digits without +1. Non-NANP digits are passed through. */
export function toReceiverNumber(e164: string): string {
  const digits = digitsOnly(e164)
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1)
  return digits
}

export function phonesMatch(left: string, right: string): boolean {
  return toReceiverNumber(left) === toReceiverNumber(right)
}

export function texttorrentCreateChatUrl(): string {
  return `${TEXTTORRENT_API_BASE}${TEXTTORRENT_CREATE_CHAT_PATH}`
}

export function texttorrentSendUrl(): string {
  return `${TEXTTORRENT_API_BASE}${TEXTTORRENT_SEND_PATH}`
}

export function texttorrentInboxUrl(search: string): string {
  const params = new URLSearchParams({ search, limit: "10" })
  return `${TEXTTORRENT_API_BASE}${TEXTTORRENT_INBOX_PATH}?${params.toString()}`
}

export function readCredentials(input: unknown): TextTorrentCredentials {
  const record = asRecord(input) ?? {}
  return {
    apiKey: firstText(record, [API_KEY_FIELD, "apiSid", "sid"]),
    apiSecret: firstText(record, [API_SECRET_FIELD, "publicKey", "apiPublicKey"]),
    sendingNumber: firstText(record, [SENDING_NUMBER_FIELD, "fromNumber", "from_number", "senderIdentity"]),
  }
}

export function validateTextTorrentCredentials(input: unknown): { ok: true; value: TextTorrentCredentials } | { ok: false; fields: Record<string, string> } {
  const value = readCredentials(input)
  const fields: Record<string, string> = {}
  if (!value.apiKey) fields[API_KEY_FIELD] = "Enter the TextTorrent API key."
  if (!value.apiSecret) fields[API_SECRET_FIELD] = "Enter the TextTorrent API secret."
  if (!value.sendingNumber || !e164Pattern.test(value.sendingNumber)) {
    fields[SENDING_NUMBER_FIELD] = "Enter a sending number in E.164 format."
  }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value }
}

export function texttorrentAuthHeaders(credentials: Pick<TextTorrentCredentials, "apiKey" | "apiSecret">): Record<string, string> {
  return {
    "X-API-SID": credentials.apiKey,
    "X-API-PUBLIC-KEY": credentials.apiSecret,
    accept: "application/json",
  }
}

export function mapCreateChatBody(input: { sender: string; recipient: string }): TextTorrentCreateChatBody {
  return {
    receiver_number: toReceiverNumber(input.recipient),
    sender_id: input.sender,
  }
}

export function mapSendForm(input: { chatId: string; sender: string; recipient: string; body: string }): FormData {
  const form = new FormData()
  form.set("message", input.body)
  form.set("chat_id", input.chatId)
  form.set("from_number", input.sender)
  form.set("to_number", input.recipient)
  return form
}

export function payloadMessage(payload: unknown): string {
  return firstText(asRecord(payload), ["message"])
}

export function isChatAlreadyExists(status: number, payload: unknown): boolean {
  return status === 404 && alreadyStartedPattern.test(payloadMessage(payload))
}

export function isBlacklistedContact(status: number, payload: unknown): boolean {
  return status === 404 && blacklistedPattern.test(payloadMessage(payload))
}

function dataRecord(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload)
  return asRecord(root?.data) ?? root
}

function idText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
  const textValue = text(value)
  return textValue || undefined
}

export function readCreatedChatId(payload: unknown): string | undefined {
  const data = dataRecord(payload)
  return idText(data?.id) ?? idText(data?.chat_id)
}

export function readInboxChatId(payload: unknown, recipient: string): string | undefined {
  const root = asRecord(payload)
  const data = asRecord(root?.data) ?? root
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []
  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue
    const number = firstText(record, ["number", "contact_phone_number"])
    if (number && !phonesMatch(number, recipient)) continue
    const chatId = idText(record.chat_id) ?? idText(record.id)
    if (chatId) return chatId
  }
  return undefined
}

function readExternalId(payload: unknown): string | undefined {
  const data = dataRecord(payload)
  const id = idText(data?.id)
  if (id) return id.slice(0, 80)
  const sid = firstText(data, ["msg_sid", "msgSid"])
  return sid ? sid.slice(0, 80) : undefined
}

function readProviderStatus(payload: unknown): string {
  const data = dataRecord(payload)
  const status = firstText(data, ["api_send_status", "status", "providerStatus"])
  return (status || "sent").slice(0, 80)
}

export function mapAcceptedSend(payload: unknown): SmsDeliveryResult {
  const externalId = readExternalId(payload)
  if (!externalId) {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "TextTorrent returned no valid message identity. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId, providerStatus: readProviderStatus(payload) }
}

export function clientErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const errors = asRecord(root?.errors)
  if (errors?.to_number) return "texttorrent_invalid_number"
  if (errors?.from_number) return "texttorrent_invalid_sender"
  if (errors?.chat_id) return "texttorrent_invalid_chat"
  if (isBlacklistedContact(status, payload)) return "texttorrent_blacklisted"
  if (status === 401) return "texttorrent_unauthorized"
  const raw = firstText(root, ["code", "error", "error_code"]) || String(status)
  const code = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
  return `texttorrent_${code}`
}

export function sanitizedClientError(errorCode: string): SmsDeliveryResult {
  return {
    state: "failed",
    errorCode,
    errorMessage: "TextTorrent rejected the message. Review the account, sender, recipient, and consent in the provider console.",
  }
}

export function unknownOutcome(): SmsDeliveryResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "TextTorrent did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredResult(): SmsDeliveryResult {
  return { state: "failed", errorCode: "texttorrent_unconfigured", errorMessage: "TextTorrent is not configured for this SMS account." }
}

export function texttorrentResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  return JSON.stringify(value).includes(secret)
}
