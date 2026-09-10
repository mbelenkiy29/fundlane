import "server-only"

import type { SmsAdapterInbound, SmsDeliveryResult } from "../../contracts"

export const ENTRANCE_SLUG = "entrance" as const

/** Public Entrance API v2 Cloud base. https://docs.entrancegrp.com/ and npm `entrancesms`. */
export const ENTRANCE_API_BASE = "https://apiv2.entrancegrp.com"

export const ENTRANCE_LOGIN_PATH = "/authentication/login"

export const ENTRANCE_CAPABILITIES = {
  send: true as const,
  statusCallbacks: false,
  inbound: true,
  optOut: true,
}

export const LOGIN_EMAIL_FIELD = "loginEmail"
export const API_SECRET_FIELD = "apiSecret"

const emailPattern = /^\S+@\S+\.\S+$/
const optOutKeywords = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"])
const optInKeywords = new Set(["start", "unstop", "yes"])

export interface EntranceCredentials {
  loginEmail: string
  apiSecret: string
}

export interface EntranceLoginBody {
  email: string
  password: string
}

export interface EntranceSendBody {
  channel_id?: number
  message: string
  number: string
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

export function entranceMessagesPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/messages`
}

export function entranceLoginUrl(): string {
  return `${ENTRANCE_API_BASE}${ENTRANCE_LOGIN_PATH}`
}

export function entranceMessagesUrl(workspaceId: string): string {
  return `${ENTRANCE_API_BASE}${entranceMessagesPath(workspaceId)}`
}

export function readCredentials(input: unknown): EntranceCredentials {
  const record = asRecord(input) ?? {}
  return {
    loginEmail: firstText(record, [LOGIN_EMAIL_FIELD, "email"]),
    apiSecret: firstText(record, [API_SECRET_FIELD, "password", "apiPassword"]),
  }
}

export function validateEntranceCredentials(input: unknown): { ok: true; value: EntranceCredentials } | { ok: false; fields: Record<string, string> } {
  const value = readCredentials(input)
  const fields: Record<string, string> = {}
  if (!value.loginEmail) fields[LOGIN_EMAIL_FIELD] = "Enter the Entrance customer login email."
  else if (!emailPattern.test(value.loginEmail)) fields[LOGIN_EMAIL_FIELD] = "Enter a valid Entrance customer login email."
  if (!value.apiSecret) fields[API_SECRET_FIELD] = "Enter the Entrance API secret or password."
  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, value }
}

export function mapLoginBody(credentials: EntranceCredentials): EntranceLoginBody {
  return { email: credentials.loginEmail, password: credentials.apiSecret }
}

export function mapChannelId(senderIdentity: string): number | undefined {
  const trimmed = senderIdentity.trim()
  if (!/^[1-9]\d{0,15}$/.test(trimmed)) return undefined
  const channelId = Number(trimmed)
  return Number.isSafeInteger(channelId) ? channelId : undefined
}

export function mapSendBody(input: { senderIdentity: string; recipient: string; body: string }): EntranceSendBody {
  const channelId = mapChannelId(input.senderIdentity)
  return {
    ...(channelId !== undefined ? { channel_id: channelId } : {}),
    message: input.body,
    number: input.recipient,
  }
}

export function readLoginRecord(payload: unknown): { accessToken: string; workspaceId: string } | undefined {
  const root = asRecord(payload)
  const record = asRecord(root?.record) ?? root
  const accessToken = firstText(record, ["access_token", "accessToken"])
  const workspaceId = firstText(record, ["workspace_id", "workspaceId"])
  if (!accessToken || !workspaceId) return undefined
  return { accessToken, workspaceId }
}

function readExternalId(payload: unknown): string | undefined {
  const root = asRecord(payload)
  const record = asRecord(root?.record) ?? root
  const id = firstText(record, ["id", "message_id", "messageId"])
  if (id) return id.slice(0, 80)
  if (typeof record?.id === "number" && Number.isSafeInteger(record.id)) return String(record.id)
  return undefined
}

function readProviderStatus(payload: unknown): string {
  const root = asRecord(payload)
  const record = asRecord(root?.record) ?? root
  const status = firstText(record, ["status", "providerStatus"])
  return (status || "accepted").slice(0, 80)
}

export function mapAcceptedSend(payload: unknown): SmsDeliveryResult {
  const externalId = readExternalId(payload)
  if (!externalId) {
    return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Entrance returned no valid message identity. Check provider activity before retrying." }
  }
  return { state: "accepted", externalId, providerStatus: readProviderStatus(payload) }
}

export function clientErrorCode(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const raw = firstText(root, ["code", "error", "error_code"]) || String(status)
  const code = raw.replace(/[^0-9A-Za-z_-]/g, "").slice(0, 40) || String(status)
  return `entrance_${code}`
}

export function sanitizedClientError(errorCode: string): SmsDeliveryResult {
  return {
    state: "failed",
    errorCode,
    errorMessage: "Entrance rejected the message. Review the account, sender, recipient, and consent in the provider console.",
  }
}

export function unknownOutcome(): SmsDeliveryResult {
  return { state: "unknown", errorCode: "provider_outcome_unknown", errorMessage: "Entrance did not confirm whether it accepted the message. Check provider activity before retrying." }
}

export function unconfiguredResult(): SmsDeliveryResult {
  return { state: "failed", errorCode: "entrance_unconfigured", errorMessage: "Entrance is not configured for this SMS account." }
}

function inboundPayload(body: unknown): Record<string, unknown> | undefined {
  const root = asRecord(body)
  if (!root) return undefined
  const data = asRecord(root.data)
  return asRecord(data?.payload) ?? asRecord(root.payload) ?? (root.text || root.from ? root : undefined)
}

function inboundPhone(value: unknown): string {
  if (typeof value === "string") return value.trim()
  const record = asRecord(value)
  return firstText(record, ["phone_number", "phoneNumber", "number"])
}

function inboundKeyword(body: string): string {
  return body.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""
}

export function mapInbound(body: unknown): SmsAdapterInbound | { ignored: true } {
  const payload = inboundPayload(body)
  if (!payload) return { ignored: true }
  if (text(payload.direction) && text(payload.direction).toLowerCase() !== "inbound") return { ignored: true }
  const recipient = inboundPhone(payload.from)
  const message = firstText(payload, ["text", "message", "body"])
  if (!recipient) return { ignored: true }
  const keyword = inboundKeyword(message)
  const providerMessageId = firstText(payload, ["id", "message_id", "messageId"]) || undefined
  if (optOutKeywords.has(keyword)) return { kind: "opt_out", recipient, providerMessageId, body: message || undefined }
  if (optInKeywords.has(keyword)) return { kind: "opt_in", recipient, providerMessageId, body: message || undefined }
  if (!message) return { ignored: true }
  return { kind: "message", recipient, providerMessageId, body: message }
}


