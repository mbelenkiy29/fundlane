import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "../../../errors"
import type { SmsAdapterInbound, SmsAdapterStatus } from "../../contracts"

/** Public Quo (formerly OpenPhone) v1 API. https://www.quo.com/docs/mdx/api-reference/send-your-first-message */
export const OPENPHONE_SLUG = "openphone" as const
export const OPENPHONE_API_BASE = "https://api.quo.com"
export const OPENPHONE_MESSAGES_PATH = "/v1/messages"

export const OPENPHONE_CAPABILITIES = {
  send: true as const,
  statusCallbacks: true,
  inbound: true,
  optOut: true,
}

export const API_KEY_FIELD = "apiKey"
export const USER_FIELD = "user"
export const SENDING_NUMBER_FIELD = "sendingNumber"

export const e164Pattern = /^\+[1-9]\d{7,14}$/
export const userIdPattern = /^US.+$/
export const messageIdPattern = /^AC.+$/

const optOutKeywords = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"])
const optInKeywords = new Set(["start", "unstop"])
const ignoredKeywords = new Set(["help"])

export interface OpenPhoneCredentials {
  apiKey: string
  user: string
  sendingNumber: string
}

export interface OpenPhoneSmsRequest {
  apiKey: string
  user: string
  senderIdentity: string
  recipient: string
  body: string
  correlationId: string
}

export interface OpenPhoneSmsResult {
  state: "accepted" | "failed" | "unknown"
  externalId?: string
  providerStatus?: string
  errorCode?: string
  errorMessage?: string
}

export interface OpenPhoneSmsTransport {
  send(request: OpenPhoneSmsRequest): Promise<OpenPhoneSmsResult>
}

export interface OpenPhoneSendBody {
  content: string
  from: string
  to: string[]
  userId: string
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

function isPhone(value: string): boolean {
  return e164Pattern.test(value)
}

export function openphoneMessagesUrl(): string {
  return `${OPENPHONE_API_BASE}${OPENPHONE_MESSAGES_PATH}`
}

export function openphoneAuthorization(apiKey: string): string {
  return apiKey
}

export function readCredentials(input: unknown): OpenPhoneCredentials {
  const record = asRecord(input) ?? {}
  return {
    apiKey: firstText(record, [API_KEY_FIELD, "api_key"]),
    user: firstText(record, [USER_FIELD, "userId", "user_id"]),
    sendingNumber: firstText(record, [SENDING_NUMBER_FIELD, "from"]),
  }
}

export function validateOpenPhoneCredentials(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> } {
  const value = readCredentials(input)
  const fields: Record<string, string> = {}
  if (!value.apiKey) fields[API_KEY_FIELD] = "Enter the OpenPhone API key."
  if (!value.user) fields[USER_FIELD] = "Enter the OpenPhone user id."
  else if (!userIdPattern.test(value.user)) fields[USER_FIELD] = "Enter an OpenPhone user id beginning with US."
  if (!value.sendingNumber) fields[SENDING_NUMBER_FIELD] = "Enter a sending number in E.164 format."
  else if (!isPhone(value.sendingNumber)) fields[SENDING_NUMBER_FIELD] = "Enter a sending number in E.164 format."
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true }
}

export function mapSendBody(request: OpenPhoneSmsRequest): OpenPhoneSendBody {
  return {
    content: request.body,
    from: request.senderIdentity,
    to: [request.recipient],
    userId: request.user,
  }
}

function readMessageRecord(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload)
  const data = asRecord(root?.data) ?? root
  return asRecord(data?.object) ?? asRecord(data?.resource) ?? data
}

function readExternalId(payload: unknown): string | undefined {
  const record = readMessageRecord(payload)
  const id = firstText(record, ["id"])
  return id && messageIdPattern.test(id) ? id.slice(0, 80) : undefined
}

function readProviderStatus(payload: unknown): string {
  const record = readMessageRecord(payload)
  const status = firstText(record, ["status"])
  return (status || "accepted").slice(0, 80)
}

export function mapOpenPhoneHttpResult(status: number, payload: unknown): OpenPhoneSmsResult {
  if (status >= 400 && status < 500) return sanitizedClientError(clientErrorCode(payload, status))
  if (status < 200 || status >= 300) return unknownOpenPhoneOutcome()
  const externalId = readExternalId(payload)
  if (!externalId) {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "OpenPhone returned no valid message identity. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId, providerStatus: readProviderStatus(payload) }
}

export function clientErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const raw = firstText(root, ["code", "error", "error_code"]) || String(status)
  const code = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
  return `openphone_${code}`
}

export function sanitizedClientError(errorCode: string): OpenPhoneSmsResult {
  return {
    state: "failed",
    errorCode,
    errorMessage: "OpenPhone rejected the message. Review the account, sender, recipient, and consent in the provider console.",
  }
}

export function unknownOpenPhoneOutcome(): OpenPhoneSmsResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "OpenPhone did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredOpenPhoneResult(): OpenPhoneSmsResult {
  return { state: "failed", errorCode: "openphone_unconfigured", errorMessage: "OpenPhone is not configured for this SMS account." }
}

function eventObject(body: unknown): { event: Record<string, unknown>; message: Record<string, unknown> } | undefined {
  const event = asRecord(body)
  if (!event) return undefined
  const data = asRecord(event.data)
  const message = asRecord(data?.object) ?? asRecord(data?.resource) ?? (event.object === "message" ? event : undefined)
  if (!message) return undefined
  return { event, message }
}

function phoneFrom(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    for (const item of value) {
      const next = phoneFrom(item)
      if (next) return next
    }
  }
  const record = asRecord(value)
  return firstText(record, ["phone_number", "phoneNumber", "number"])
}

export function openphoneEventKey(input: { eventId: string; type: string; messageId: string; status: string }): string {
  return createHash("sha256").update(JSON.stringify([
    ["eventId", input.eventId],
    ["messageId", input.messageId],
    ["status", input.status],
    ["type", input.type],
  ])).digest("hex")
}

export function mapOpenPhoneStatusCallback(body: unknown): SmsAdapterStatus {
  const parsed = eventObject(body)
  const type = text(parsed?.event.type).toLowerCase()
  const messageId = firstText(parsed?.message, ["id"])
  const providerStatus = (firstText(parsed?.message, ["status"]) || (type === "message.delivered" ? "delivered" : "")).toLowerCase()
  if (!parsed || !messageIdPattern.test(messageId) || !providerStatus) {
    throw new AppError(422, "openphone_status_invalid", "OpenPhone status data is incomplete.")
  }
  if (type !== "message.delivered") {
    throw new AppError(422, "openphone_status_unsupported", "The OpenPhone message status is not supported.")
  }
  const eventId = firstText(parsed.event, ["id"])
  const recipient = phoneFrom(parsed.message.to)
  const sender = phoneFrom(parsed.message.from)
  return {
    providerMessageId: messageId,
    providerStatus,
    ...(recipient ? { recipient } : {}),
    ...(sender ? { sender } : {}),
    eventKey: openphoneEventKey({ eventId, type, messageId, status: providerStatus }),
  }
}

function inboundKeyword(body: string): string {
  const trimmed = body.trim()
  if (!trimmed || /\s/.test(trimmed)) return ""
  return trimmed.toLowerCase()
}

export function mapOpenPhoneInbound(body: unknown): SmsAdapterInbound | { ignored: true } {
  const parsed = eventObject(body)
  if (!parsed) return { ignored: true }
  const type = text(parsed.event.type).toLowerCase()
  const direction = text(parsed.message.direction).toLowerCase()
  if (type && type !== "message.received") return { ignored: true }
  if (direction && direction !== "incoming") return { ignored: true }
  const recipient = phoneFrom(parsed.message.from)
  const inboundBody = firstText(parsed.message, ["body", "text", "content"])
  if (!recipient || !inboundBody) return { ignored: true }
  const keyword = inboundKeyword(inboundBody)
  const providerMessageId = firstText(parsed.message, ["id"])
  const identity = providerMessageId && messageIdPattern.test(providerMessageId) ? { providerMessageId } : {}
  if (ignoredKeywords.has(keyword)) return { ignored: true }
  if (optOutKeywords.has(keyword)) return { kind: "opt_out", recipient, ...identity, body: inboundBody }
  if (optInKeywords.has(keyword)) return { kind: "opt_in", recipient, ...identity, body: inboundBody }
  return { kind: "message", recipient, ...identity, body: inboundBody }
}

function signaturePayload(payload: unknown): string {
  if (typeof payload === "string") return payload
  return JSON.stringify(payload ?? {})
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ""
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]?.trim() ?? ""
}

export function readOpenPhoneSignatureHeader(headers: Record<string, string>): string {
  return headerValue(headers, "openphone-signature")
}

export function validateOpenPhoneSignature(input: {
  signingKey: string
  signature: string | null
  payload: unknown
}): boolean {
  if (!input.signingKey || !input.signature) return false
  const signedPayload = signaturePayload(input.payload)
  const key = Buffer.from(input.signingKey, "base64")
  if (!key.length) return false
  const candidates = input.signature.split(",").map((part) => part.trim()).filter(Boolean)
  for (const candidate of candidates) {
    const fields = candidate.split(";")
    if (fields.length < 4) continue
    const [scheme, version, timestamp, digest] = fields
    if (scheme !== "hmac" || version !== "1" || !timestamp || !digest) continue
    const expected = createHmac("sha256", key).update(`${timestamp}.${signedPayload}`, "utf8").digest("base64")
    const supplied = Buffer.from(digest)
    const calculated = Buffer.from(expected)
    if (supplied.length === calculated.length && timingSafeEqual(supplied, calculated)) return true
  }
  return false
}

export function openphoneResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  return JSON.stringify(value).includes(secret)
}
