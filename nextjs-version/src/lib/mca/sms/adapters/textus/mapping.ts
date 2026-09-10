import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "../../../errors"
import type { SmsAdapterInbound, SmsAdapterStatus, SmsDeliveryResult, SmsSenderKind } from "../../contracts"

export const TEXTUS_SLUG = "textus" as const

/** Public TextUs Next API. https://apidocs.next.textus.com/overview/making_requests/ */
export const TEXTUS_API_BASE = "https://next.textus.com"
export const TEXTUS_MESSAGES_PATH = "/messages"
export const TEXTUS_JSONLD = "application/vnd.textus+jsonld"
export const TEXTUS_SIGNATURE_HEADER = "x-textus-signature"

export const ACCOUNT_EMAIL_FIELD = "accountEmail"
export const API_KEY_FIELD = "apiKey"
export const WEBHOOK_SECRET_FIELD = "webhookSecret"

export const TEXTUS_CAPABILITIES = {
  send: true as const,
  statusCallbacks: true,
  inbound: true,
  optOut: true,
}

export const TEXTUS_ACCEPTED_STATUSES = ["created", "scheduled", "queued"] as const
export const TEXTUS_SENT_STATUSES = ["dispatched"] as const
export const TEXTUS_DELIVERED_STATUSES = ["delivered"] as const
export const TEXTUS_FAILED_STATUSES = ["failed", "failed_transient", "unknown"] as const

const emailPattern = /^\S+@\S+\.\S+$/
const e164Pattern = /^\+[1-9]\d{7,14}$/
const messageSlugPattern = /^[A-Za-z0-9_-]{4,64}$/
const optOutKeywords = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"])
const optInKeywords = new Set(["start", "unstop", "yes"])

const statusActions = {
  "message.delivered": "delivered",
  "message.failed": "failed",
  "message.unknown": "unknown",
} as const

const supportedStatuses = new Set<string>([
  ...TEXTUS_ACCEPTED_STATUSES,
  ...TEXTUS_SENT_STATUSES,
  ...TEXTUS_DELIVERED_STATUSES,
  ...TEXTUS_FAILED_STATUSES,
  ...Object.values(statusActions),
])

export interface TextusCredentials {
  accountEmail: string
  apiKey: string
  webhookSecret?: string
}

export interface TextusSendBody {
  email: string
  to: string
  body: string
  from?: string
}

export interface TextusSmsRequest {
  accountEmail: string
  apiKey: string
  senderKind: SmsSenderKind
  senderIdentity: string
  recipient: string
  body: string
  correlationId: string
}

export interface TextusSmsResult {
  state: "accepted" | "failed" | "unknown"
  externalId?: string
  providerStatus?: string
  errorCode?: string
  errorMessage?: string
}

export interface TextusSmsTransport {
  send(request: TextusSmsRequest): Promise<TextusSmsResult>
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

function parseBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body === "string") {
    try {
      return asRecord(JSON.parse(body))
    } catch {
      return undefined
    }
  }
  return asRecord(body)
}

function isPhone(value: string): boolean {
  return e164Pattern.test(value)
}

export function textusMessagesUrl(): string {
  return `${TEXTUS_API_BASE}${TEXTUS_MESSAGES_PATH}`
}

export function textusBearerAuthorization(apiKey: string): string {
  return `Bearer ${apiKey}`
}

export function normalizeTextusMessageId(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("/messages/")) {
    const slug = trimmed.slice("/messages/".length)
    return messageSlugPattern.test(slug) ? `/messages/${slug}` : undefined
  }
  return messageSlugPattern.test(trimmed) ? `/messages/${trimmed}` : undefined
}

export function readCredentials(input: unknown): TextusCredentials {
  const record = asRecord(input) ?? {}
  const webhookSecret = firstText(record, [WEBHOOK_SECRET_FIELD])
  return {
    accountEmail: firstText(record, [ACCOUNT_EMAIL_FIELD, "email", "loginEmail"]),
    apiKey: firstText(record, [API_KEY_FIELD, "apiToken", "token", "authToken"]),
    ...(webhookSecret ? { webhookSecret } : {}),
  }
}

export function validateTextusCredentials(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> } {
  const record = asRecord(input) ?? {}
  const value = readCredentials(record)
  const fields: Record<string, string> = {}
  if (!value.accountEmail) fields[ACCOUNT_EMAIL_FIELD] = "Enter the TextUs account email."
  else if (!emailPattern.test(value.accountEmail)) fields[ACCOUNT_EMAIL_FIELD] = "Enter a valid TextUs account email."
  if (!value.apiKey) fields[API_KEY_FIELD] = "Enter the TextUs API key."
  if (record[WEBHOOK_SECRET_FIELD] !== undefined && typeof record[WEBHOOK_SECRET_FIELD] === "string" && !text(record[WEBHOOK_SECRET_FIELD])) {
    fields[WEBHOOK_SECRET_FIELD] = "Enter the TextUs webhook secret used to validate callbacks."
  }
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true }
}

export function mapSendBody(input: { accountEmail: string; senderIdentity: string; recipient: string; body: string }): TextusSendBody {
  const from = isPhone(input.senderIdentity.trim()) ? input.senderIdentity.trim() : undefined
  return {
    email: input.accountEmail,
    to: input.recipient,
    body: input.body,
    ...(from ? { from } : {}),
  }
}

function readExternalId(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const message = asRecord(root?.message) ?? root
  return normalizeTextusMessageId(firstText(message, ["id", "message_id", "messageId"]))
}

function readProviderStatus(payload: unknown): string {
  const root = asRecord(payload)
  const message = asRecord(root?.message) ?? root
  const status = firstText(message, ["deliveryState", "status", "providerStatus"]).toLowerCase()
  return (status || "queued").slice(0, 80)
}

export function mapTextusHttpResult(status: number, payload: unknown): TextusSmsResult {
  if (status >= 400 && status < 500) return sanitizedClientError(clientErrorCode(payload, status))
  if (status < 200 || status >= 300) return unknownOutcome()
  const externalId = readExternalId(payload)
  if (!externalId) return unknownOutcome()
  return { state: "accepted", externalId, providerStatus: readProviderStatus(payload) }
}

export function clientErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const raw = firstText(root, ["code", "error", "error_code", "hydra:title", "title"]) || String(status)
  const code = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
  return `textus_${code}`
}

export function sanitizedClientError(errorCode: string): SmsDeliveryResult {
  return {
    state: "failed",
    errorCode,
    errorMessage: "TextUs rejected the message. Review the account, sender, recipient, and consent in the provider console.",
  }
}

export function unknownOutcome(): SmsDeliveryResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "TextUs did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredResult(): SmsDeliveryResult {
  return { state: "failed", errorCode: "textus_unconfigured", errorMessage: "TextUs is not configured for this SMS account." }
}

export function validateTextusSignature(input: { secret: string; signature: string | null; payload: string }): boolean {
  if (!input.secret || !input.signature) return false
  const expected = createHmac("sha256", input.secret).update(input.payload).digest("hex")
  const supplied = Buffer.from(input.signature)
  const calculated = Buffer.from(expected)
  return supplied.length === calculated.length && timingSafeEqual(supplied, calculated)
}

export function textusEventKey(input: { deliveryId?: string; action?: string; messageId?: string; status?: string }): string {
  if (input.deliveryId) return input.deliveryId
  return createHash("sha256").update(JSON.stringify({
    action: input.action ?? "",
    messageId: input.messageId ?? "",
    status: input.status ?? "",
  })).digest("hex")
}

function conversationRecord(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return asRecord(root?.conversation)
}

function messageRecord(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return asRecord(root?.message) ?? (root?.["@type"] === "Message" ? root : undefined)
}

function optRecord(root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return asRecord(root?.optOut) ?? asRecord(root?.optIn) ?? asRecord(root?.opt_out) ?? asRecord(root?.opt_in)
}

export function mapTextusStatusCallback(body: unknown): SmsAdapterStatus {
  const root = parseBody(body)
  if (!root) throw new AppError(422, "textus_status_invalid", "TextUs status data is incomplete.")
  const action = firstText(root, ["action"]).toLowerCase()
  const message = messageRecord(root)
  const conversation = conversationRecord(root)
  const mappedStatus = action && action in statusActions ? statusActions[action as keyof typeof statusActions] : ""
  const deliveryState = firstText(message, ["deliveryState", "status"]).toLowerCase()
  const providerStatus = mappedStatus || deliveryState
  const providerMessageId = normalizeTextusMessageId(firstText(message, ["id", "message_id", "messageId"])) ?? ""
  if (!providerMessageId || !providerStatus) {
    throw new AppError(422, "textus_status_invalid", "TextUs status data is incomplete.")
  }
  if (action && !(action in statusActions)) {
    throw new AppError(422, "textus_status_unsupported", "The TextUs message status is not supported.")
  }
  if (!supportedStatuses.has(providerStatus)) {
    throw new AppError(422, "textus_status_unsupported", "The TextUs message status is not supported.")
  }
  const recipient = firstText(conversation, ["phoneNumber", "phone_number"]) || firstText(message, ["to", "recipient"])
  const sender = firstText(conversation, ["accountPhoneNumber", "account_phone_number"]) || firstText(message, ["from", "sender"])
  const errorCode = providerStatus === "failed" || providerStatus === "failed_transient" || providerStatus === "unknown"
    ? firstText(message, ["errorCode", "error_code"]) || `textus_${providerStatus.replace(/[^0-9A-Za-z_-]/g, "")}`
    : firstText(message, ["errorCode", "error_code"])
  return {
    providerMessageId,
    providerStatus,
    ...(errorCode ? { errorCode } : {}),
    ...(recipient ? { recipient } : {}),
    ...(sender ? { sender } : {}),
    eventKey: textusEventKey({
      deliveryId: firstText(root, ["id"]) || undefined,
      action,
      messageId: providerMessageId,
      status: providerStatus,
    }),
  }
}

function inboundKeyword(body: string): string {
  return body.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""
}

export function mapTextusInbound(body: unknown): SmsAdapterInbound | { ignored: true } {
  const root = parseBody(body)
  if (!root) return { ignored: true }
  const action = firstText(root, ["action"]).toLowerCase()
  if (action === "contact.opted_out" || action === "contact.opted_in") {
    const opt = optRecord(root)
    const recipient = firstText(opt, ["phoneNumber", "phone_number", "formattedPhoneNumber"]) || firstText(conversationRecord(root), ["phoneNumber", "phone_number"])
    if (!recipient) throw new AppError(422, "textus_opt_out_invalid", "Unsupported TextUs opt-out event.")
    const providerMessageId = normalizeTextusMessageId(firstText(opt, ["id"]) || firstText(root, ["id"]))
    return {
      kind: action === "contact.opted_out" ? "opt_out" : "opt_in",
      recipient,
      ...(providerMessageId ? { providerMessageId } : {}),
    }
  }
  if (action && action !== "message.received") return { ignored: true }
  const message = messageRecord(root)
  const conversation = conversationRecord(root)
  const recipient = firstText(conversation, ["phoneNumber", "phone_number"]) || firstText(message, ["from", "phoneNumber"])
  const inboundBody = firstText(message, ["body", "text", "formattedBody"])
  if (!recipient || !inboundBody) return { ignored: true }
  const providerMessageId = normalizeTextusMessageId(firstText(message, ["id", "message_id", "messageId"]))
  const keyword = inboundKeyword(inboundBody)
  const kind = optOutKeywords.has(keyword) ? "opt_out" : optInKeywords.has(keyword) ? "opt_in" : "message"
  return {
    kind,
    recipient,
    ...(providerMessageId ? { providerMessageId } : {}),
    body: inboundBody,
  }
}

export function textusResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  return JSON.stringify(value).includes(secret)
}
