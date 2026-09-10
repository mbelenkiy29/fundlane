import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "../../../errors"
import type { SmsAdapterInbound, SmsAdapterStatus, SmsSenderKind } from "../../contracts"

export const TWILIO_SLUG = "twilio"
export const accountSidPattern = /^AC[0-9a-fA-F]{32}$/
export const apiKeySidPattern = /^SK[0-9a-fA-F]{32}$/
export const messageSidPattern = /^(?:SM|MM)[0-9a-fA-F]{32}$/
export const messagingServicePattern = /^MG[0-9a-fA-F]{32}$/
export const e164Pattern = /^\+[1-9]\d{7,14}$/

export const TWILIO_ACCEPTED_STATUSES = ["accepted", "queued", "scheduled"] as const
export const TWILIO_SENT_STATUSES = ["sending", "sent"] as const
export const TWILIO_FAILED_STATUSES = ["failed", "undelivered", "canceled"] as const
export const TWILIO_DELIVERED_STATUSES = ["delivered"] as const

const supportedStatuses = new Set<string>([
  ...TWILIO_ACCEPTED_STATUSES,
  ...TWILIO_SENT_STATUSES,
  ...TWILIO_FAILED_STATUSES,
  ...TWILIO_DELIVERED_STATUSES,
])

export interface TwilioSmsRequest {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  messagingServiceSid?: string
  senderKind: SmsSenderKind
  senderIdentity: string
  recipient: string
  body: string
  statusCallbackUrl: string
  correlationId: string
}

export interface TwilioSmsResult {
  state: "accepted" | "failed" | "unknown"
  externalId?: string
  providerStatus?: string
  errorCode?: string
  errorMessage?: string
}

export interface TwilioSmsTransport {
  send(request: TwilioSmsRequest): Promise<TwilioSmsResult>
}

type TwilioResponse = { sid?: unknown; status?: unknown; code?: unknown }

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const next = value.trim()
  return next || undefined
}

function isPhone(value: string | undefined): value is string {
  return Boolean(value && e164Pattern.test(value))
}

function isMessagingService(value: string | undefined): value is string {
  return Boolean(value && messagingServicePattern.test(value))
}

export function twilioMessagesUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`
}

export function twilioBasicAuthorization(apiKeySid: string, apiKeySecret: string): string {
  return `Basic ${Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString("base64")}`
}

export function twilioMessageForm(request: TwilioSmsRequest): URLSearchParams {
  const form = new URLSearchParams({ To: request.recipient, Body: request.body, StatusCallback: request.statusCallbackUrl })
  form.set(request.senderKind === "phone_number" ? "From" : "MessagingServiceSid", request.senderIdentity)
  if (request.messagingServiceSid) form.set("MessagingServiceSid", request.messagingServiceSid)
  return form
}

export function mapTwilioHttpResult(status: number, payload: TwilioResponse): TwilioSmsResult {
  if (status >= 400 && status < 500) {
    const code = String(payload.code ?? status).replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
    return { state: "failed", errorCode: `twilio_${code}`, errorMessage: `Twilio rejected the message (code ${code}). Review the account, sender, recipient, and consent in the provider console.` }
  }
  if (status < 200 || status >= 300) return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Twilio did not confirm whether it accepted the message. Check provider activity before retrying." }
  const externalId = typeof payload.sid === "string" && messageSidPattern.test(payload.sid) ? payload.sid : undefined
  if (!externalId) return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Twilio returned no valid message identity. Check provider activity before retrying." }
  return { state: "accepted", externalId, providerStatus: typeof payload.status === "string" ? payload.status.slice(0, 80) : "accepted" }
}

export function unknownTwilioOutcome(): TwilioSmsResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Twilio did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredTwilioResult(): TwilioSmsResult {
  return { state: "failed", errorCode: "twilio_unconfigured", errorMessage: "Twilio is not configured for this SMS account." }
}

export function validateTwilioCredentials(input: unknown): { ok: true } | { ok: false; fields: Record<string, string> } {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {}
  const fields: Record<string, string> = {}
  const accountSid = text(value.accountSid)
  const apiKeySid = text(value.apiKeySid)
  const apiKeySecret = text(value.apiKeySecret)
  if (!accountSid || !accountSidPattern.test(accountSid)) fields.accountSid = "Enter a Twilio Account SID."
  if (!apiKeySid || !apiKeySidPattern.test(apiKeySid)) fields.apiKeySid = "Enter a Twilio API key SID."
  if (!apiKeySecret) fields.apiKeySecret = "Enter the Twilio API key secret."

  const senderKind = value.senderKind === "phone_number" || value.senderKind === "messaging_service" ? value.senderKind : undefined
  const sendingNumber = text(value.sendingNumber)
  const messagingServiceSid = text(value.messagingServiceSid)
  const senderIdentity = text(value.senderIdentity)
  if (senderKind === "phone_number") {
    if (!isPhone(sendingNumber ?? senderIdentity)) fields.sendingNumber = "Enter a sending number in E.164 format."
  } else if (senderKind === "messaging_service") {
    if (!isMessagingService(messagingServiceSid ?? senderIdentity)) fields.messagingServiceSid = "Enter a Twilio Messaging Service SID."
  } else {
    const hasPhone = isPhone(sendingNumber) || isPhone(senderIdentity)
    const hasMessaging = isMessagingService(messagingServiceSid) || isMessagingService(senderIdentity)
    if (!hasPhone && !hasMessaging) {
      fields.sendingNumber = "Enter a sending number in E.164 format."
      fields.messagingServiceSid = "Enter a Twilio Messaging Service SID."
    } else {
      if (sendingNumber && !isPhone(sendingNumber)) fields.sendingNumber = "Enter a sending number in E.164 format."
      if (messagingServiceSid && !isMessagingService(messagingServiceSid)) fields.messagingServiceSid = "Enter a Twilio Messaging Service SID."
    }
  }

  if (value.authToken !== undefined && typeof value.authToken === "string" && !value.authToken.trim()) {
    fields.authToken = "Enter the Twilio Auth Token used to validate webhooks."
  }

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true }
}

export function validateTwilioFormSignature(input: { authToken: string; signature: string | null; url: string; params: URLSearchParams }): boolean {
  if (!input.authToken || !input.signature) return false
  const grouped = new Map<string, string[]>()
  input.params.forEach((value, key) => grouped.set(key, [...(grouped.get(key) ?? []), value]))
  const source = [...grouped.keys()].sort().reduce((value, key) => {
    const values = [...new Set(grouped.get(key) ?? [])].sort()
    return values.reduce((result, item) => `${result}${key}${item}`, value)
  }, input.url)
  const expected = createHmac("sha1", input.authToken).update(source).digest("base64")
  const supplied = Buffer.from(input.signature)
  const calculated = Buffer.from(expected)
  return supplied.length === calculated.length && timingSafeEqual(supplied, calculated)
}

export function asTwilioParams(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body
  if (typeof body === "string") return new URLSearchParams(body)
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string") params.append(key, value)
    }
    return params
  }
  return new URLSearchParams()
}

export function twilioEventKey(params: URLSearchParams): string {
  return createHash("sha256").update(JSON.stringify([...params.entries()].sort(([left], [right]) => left.localeCompare(right)))).digest("hex")
}

export function mapTwilioStatusCallback(body: unknown): SmsAdapterStatus {
  const params = asTwilioParams(body)
  const providerMessageId = params.get("MessageSid")?.trim() || params.get("SmsSid")?.trim() || ""
  const providerStatus = (params.get("MessageStatus")?.trim() || params.get("SmsStatus")?.trim() || "").toLowerCase()
  if (!messageSidPattern.test(providerMessageId) || !providerStatus) {
    throw new AppError(422, "twilio_status_invalid", "Twilio status data is incomplete.")
  }
  if (!supportedStatuses.has(providerStatus)) {
    throw new AppError(422, "twilio_status_unsupported", "The Twilio message status is not supported.")
  }
  const errorCode = params.get("ErrorCode")?.trim() || undefined
  const recipient = text(params.get("To"))
  const sender = text(params.get("From"))
  return {
    providerMessageId,
    providerStatus,
    ...(errorCode ? { errorCode } : {}),
    ...(recipient ? { recipient } : {}),
    ...(sender ? { sender } : {}),
    eventKey: twilioEventKey(params),
  }
}

export function mapTwilioInbound(body: unknown): SmsAdapterInbound | { ignored: true } {
  const params = asTwilioParams(body)
  const type = params.get("OptOutType")?.trim().toUpperCase()
  if (!type) {
    const recipient = text(params.get("From"))
    const providerMessageId = params.get("MessageSid")?.trim()
    const inboundBody = params.get("Body")?.trim()
    if (!recipient || !inboundBody) return { ignored: true }
    return {
      kind: "message",
      recipient,
      ...(providerMessageId && messageSidPattern.test(providerMessageId) ? { providerMessageId } : {}),
      body: inboundBody,
    }
  }
  if (type === "HELP") return { ignored: true }
  if (type !== "STOP" && type !== "START") throw new AppError(422, "twilio_opt_out_invalid", "Unsupported Twilio opt-out event.")
  const recipient = text(params.get("From"))
  if (!recipient) throw new AppError(422, "twilio_opt_out_invalid", "Unsupported Twilio opt-out event.")
  const providerMessageId = params.get("MessageSid")?.trim()
  return {
    kind: type === "STOP" ? "opt_out" : "opt_in",
    recipient,
    ...(providerMessageId && messageSidPattern.test(providerMessageId) ? { providerMessageId } : {}),
  }
}

export function twilioResultContainsSecret(value: unknown, secret: string): boolean {
  if (!secret) return false
  return JSON.stringify(value).includes(secret)
}
