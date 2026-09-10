import "server-only"

import { createHash, createPublicKey, verify } from "node:crypto"
import { AppError } from "../../../errors"
import type { SmsAdapterInbound, SmsAdapterStatus, SmsDeliveryResult } from "../../contracts"

export const GOHIGHLEVEL_SLUG = "gohighlevel" as const

/** Public HighLevel services host. https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken */
export const GHL_API_BASE = "https://services.leadconnectorhq.com"

/** Version header from the Private Integrations guide. Conversation pages also list `v3`. */
export const GHL_API_VERSION = "2021-07-28"

export const GHL_MESSAGES_PATH = "/conversations/messages"
export const GHL_CONTACTS_UPSERT_PATH = "/contacts/upsert"
export const GHL_CONTACTS_DUPLICATE_PATH = "/contacts/search/duplicate"

export const PRIVATE_INTEGRATION_TOKEN_FIELD = "privateIntegrationToken"
export const LOCATION_ID_FIELD = "locationId"

export const GOHIGHLEVEL_CAPABILITIES = {
  send: true as const,
  statusCallbacks: true,
  inbound: true,
  optOut: true,
}

/** Published Ed25519 key for `X-GHL-Signature`. https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/ */
export const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`

const e164Pattern = /^\+[1-9]\d{7,14}$/
const locationIdPattern = /^[A-Za-z0-9_-]{4,64}$/
const optOutKeywords = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"])
const optInKeywords = new Set(["start", "unstop", "yes"])

export const GHL_ACCEPTED_STATUSES = ["pending", "scheduled"] as const
export const GHL_SENT_STATUSES = ["sent", "connected"] as const
export const GHL_DELIVERED_STATUSES = ["delivered", "opened", "clicked", "read"] as const
export const GHL_FAILED_STATUSES = ["failed", "undelivered"] as const
export const GHL_OPT_OUT_STATUSES = ["opt_out"] as const

const supportedStatuses = new Set<string>([
  ...GHL_ACCEPTED_STATUSES,
  ...GHL_SENT_STATUSES,
  ...GHL_DELIVERED_STATUSES,
  ...GHL_FAILED_STATUSES,
  ...GHL_OPT_OUT_STATUSES,
])

export interface GohighlevelCredentials {
  privateIntegrationToken: string
  locationId: string
}

export interface GohighlevelSmsRequest {
  privateIntegrationToken: string
  locationId: string
  senderIdentity: string
  recipient: string
  body: string
  correlationId: string
}

export interface GohighlevelSmsTransport {
  send(request: GohighlevelSmsRequest): Promise<SmsDeliveryResult>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return undefined
    }
  }
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

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return ""
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]?.trim() ?? ""
}

export function isE164Phone(value: string): boolean {
  return e164Pattern.test(value)
}

export function readGohighlevelCredentials(input: unknown): GohighlevelCredentials {
  const record = asRecord(input) ?? {}
  return {
    privateIntegrationToken: firstText(record, [PRIVATE_INTEGRATION_TOKEN_FIELD, "token", "accessToken"]),
    locationId: firstText(record, [LOCATION_ID_FIELD, "location"]),
  }
}

export function validateGohighlevelCredentials(input: unknown): { ok: true; value: GohighlevelCredentials } | { ok: false; fields: Record<string, string> } {
  const value = readGohighlevelCredentials(input)
  const fields: Record<string, string> = {}
  if (!value.privateIntegrationToken) fields[PRIVATE_INTEGRATION_TOKEN_FIELD] = "Enter the GoHighLevel Private Integration Token."
  if (!value.locationId || !locationIdPattern.test(value.locationId)) fields[LOCATION_ID_FIELD] = "Enter the GoHighLevel Location ID."
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value }
}

export function ghlAuthorization(token: string): string {
  return `Bearer ${token}`
}

export function ghlRequestHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: ghlAuthorization(token),
    "content-type": "application/json",
    Version: GHL_API_VERSION,
  }
}

export function ghlDuplicateContactUrl(locationId: string, phone: string): string {
  const params = new URLSearchParams({ locationId, number: phone })
  return `${GHL_API_BASE}${GHL_CONTACTS_DUPLICATE_PATH}?${params.toString()}`
}

export function ghlUpsertContactUrl(): string {
  return `${GHL_API_BASE}${GHL_CONTACTS_UPSERT_PATH}`
}

export function ghlMessagesUrl(): string {
  return `${GHL_API_BASE}${GHL_MESSAGES_PATH}`
}

export function mapGhlUpsertBody(locationId: string, phone: string): { locationId: string; phone: string } {
  return { locationId, phone }
}

export function mapGhlSendBody(input: { contactId: string; recipient: string; body: string; senderIdentity: string }): {
  type: "SMS"
  contactId: string
  message: string
  toNumber: string
  fromNumber?: string
} {
  const fromNumber = input.senderIdentity.trim()
  return {
    type: "SMS",
    contactId: input.contactId,
    message: input.body,
    toNumber: input.recipient,
    ...(isE164Phone(fromNumber) ? { fromNumber } : {}),
  }
}

function readNestedContact(record: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!record) return undefined
  const contact = asRecord(record.contact)
  if (contact) return contact
  const contacts = record.contacts
  if (Array.isArray(contacts) && contacts.length > 0) return asRecord(contacts[0])
  return record
}

export function readGhlContactId(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const contact = readNestedContact(root)
  const id = firstText(contact, ["id", "contactId", "_id"]) || firstText(root, ["id", "contactId"])
  return id ? id.slice(0, 80) : undefined
}

export function readGhlMessageId(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const message = asRecord(root?.message)
  const id = firstText(root, ["messageId", "id"]) || firstText(message, ["id", "messageId"])
  return id ? id.slice(0, 80) : undefined
}

export function mapGhlAcceptedSend(payload: unknown): SmsDeliveryResult {
  const externalId = readGhlMessageId(payload)
  if (!externalId) {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "GoHighLevel returned no valid message identity. Check provider activity before retrying." }
  }
  const root = asRecord(payload)
  const status = firstText(root, ["status", "providerStatus"])
  return { state: "accepted", externalId, providerStatus: (status || "pending").slice(0, 80) }
}

export function ghlClientErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const raw = firstText(root, ["code", "error", "error_code"]) || String(status)
  const code = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
  return `gohighlevel_${code}`
}

export function sanitizedGhlClientError(errorCode: string): SmsDeliveryResult {
  return {
    state: "failed",
    errorCode,
    errorMessage: "GoHighLevel rejected the message. Review the account, location, sender, recipient, and consent in the provider console.",
  }
}

export function unknownGohighlevelOutcome(): SmsDeliveryResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "GoHighLevel did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredGohighlevelResult(): SmsDeliveryResult {
  return { state: "failed", errorCode: "gohighlevel_unconfigured", errorMessage: "GoHighLevel is not configured for this SMS account." }
}

export function mapGhlHttpResult(status: number, payload: unknown): SmsDeliveryResult {
  if (status >= 400 && status < 500) return sanitizedGhlClientError(ghlClientErrorCode(payload, status))
  if (status < 200 || status >= 300) return unknownGohighlevelOutcome()
  return mapGhlAcceptedSend(payload)
}

export function ghlEventKey(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(Object.keys(payload).sort().map((key) => [key, payload[key]]))).digest("hex")
}

function isSmsMessageType(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return !normalized || normalized === "sms" || normalized === "type_sms"
}

export function mapGohighlevelStatusCallback(body: unknown): SmsAdapterStatus {
  const payload = asRecord(body)
  if (!payload) throw new AppError(422, "gohighlevel_status_invalid", "GoHighLevel status data is incomplete.")
  const type = firstText(payload, ["type"])
  if (type && type !== "OutboundMessage") throw new AppError(422, "gohighlevel_status_invalid", "GoHighLevel status data is incomplete.")
  const messageType = firstText(payload, ["messageType", "messageTypeString"])
  if (!isSmsMessageType(messageType)) throw new AppError(422, "gohighlevel_status_unsupported", "The GoHighLevel message status is not supported.")
  const providerMessageId = firstText(payload, ["messageId", "id"])
  const providerStatus = firstText(payload, ["status"]).toLowerCase()
  if (!providerMessageId || !providerStatus) throw new AppError(422, "gohighlevel_status_invalid", "GoHighLevel status data is incomplete.")
  if (!supportedStatuses.has(providerStatus)) throw new AppError(422, "gohighlevel_status_unsupported", "The GoHighLevel message status is not supported.")
  const recipient = firstText(payload, ["to", "phone"]) || undefined
  const sender = firstText(payload, ["from"]) || undefined
  const errorCode = firstText(payload, ["error", "errorCode", "code"]) || undefined
  return {
    providerMessageId,
    providerStatus,
    ...(errorCode ? { errorCode } : {}),
    ...(recipient ? { recipient } : {}),
    ...(sender ? { sender } : {}),
    eventKey: ghlEventKey(payload),
  }
}

function inboundKeyword(body: string): string {
  return body.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""
}

export function mapGohighlevelInbound(body: unknown): SmsAdapterInbound | { ignored: true } {
  const payload = asRecord(body)
  if (!payload) return { ignored: true }
  const type = firstText(payload, ["type"])
  if (type && type !== "InboundMessage") return { ignored: true }
  const direction = firstText(payload, ["direction"]).toLowerCase()
  if (direction && direction !== "inbound") return { ignored: true }
  const messageType = firstText(payload, ["messageType", "messageTypeString"])
  if (!isSmsMessageType(messageType)) return { ignored: true }
  const recipient = firstText(payload, ["from", "phone"])
  const message = firstText(payload, ["body", "message"])
  if (!recipient) return { ignored: true }
  const providerMessageId = firstText(payload, ["messageId", "id"]) || undefined
  const keyword = inboundKeyword(message)
  if (optOutKeywords.has(keyword)) return { kind: "opt_out", recipient, providerMessageId, body: message || undefined }
  if (optInKeywords.has(keyword)) return { kind: "opt_in", recipient, providerMessageId, body: message || undefined }
  if (!message) return { ignored: true }
  return { kind: "message", recipient, providerMessageId, body: message }
}

export function validateGhlWebhookSignature(input: { payload: string; signature: string | null; publicKeyPem?: string }): boolean {
  if (!input.payload || !input.signature) return false
  try {
    const publicKey = createPublicKey(input.publicKeyPem?.trim() || GHL_ED25519_PUBLIC_KEY)
    return verify(null, Buffer.from(input.payload, "utf8"), publicKey, Buffer.from(input.signature, "base64"))
  } catch {
    return false
  }
}

export function ghlSignatureFromHeaders(headers: Record<string, string>): string | null {
  return headerValue(headers, "x-ghl-signature") || null
}

export function gohighlevelResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  return JSON.stringify(value).includes(secret)
}
