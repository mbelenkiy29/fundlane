import "server-only"

import { createHmac, timingSafeEqual } from "node:crypto"
import { AppError } from "../errors"

export const USESEND_API_ORIGIN = "https://app.usesend.com"
const SIGNATURE_PREFIX = "v1="
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000

export interface UsesendDomain {
  id: number
  name: string
  status: string
}

export interface UsesendInboundAttachment {
  id?: string
  filename?: string
  mimeType?: string
  base64?: string
  disposition?: string
  contentId?: string
  declaredLength?: number
  strictBase64: true
}

export interface UsesendInboundEmail {
  messageId?: string
  to?: string
  from?: string
  subject?: string
  text?: string
  forwardingConfirmationReview?: boolean
  attachments?: UsesendInboundAttachment[]
}

function header(request: Request, name: string): string | null {
  return request.headers.get(name)
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function usesendSignature(secret: string, timestamp: string, rawBody: string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`
}

export function verifyUsesendSignature(request: Request, rawBody: string, secret: string, now = Date.now()): void {
  const signature = header(request, "x-usesend-signature")
  const timestamp = header(request, "x-usesend-timestamp")
  if (!signature || !timestamp) throw new AppError(401, "webhook_signature_required", "useSend X-UseSend-Signature and X-UseSend-Timestamp are required.")
  if (!signature.startsWith(SIGNATURE_PREFIX)) throw new AppError(401, "webhook_signature_invalid", "useSend signature header must start with v1=.")
  const millis = Number(timestamp)
  if (!Number.isFinite(millis)) throw new AppError(401, "webhook_signature_invalid", "useSend timestamp must be milliseconds since epoch.")
  if (Math.abs(now - millis) > TIMESTAMP_TOLERANCE_MS) throw new AppError(401, "webhook_signature_stale", "useSend signature is older than five minutes.")
  const expected = usesendSignature(secret, timestamp, rawBody)
  if (!equalText(expected, signature)) throw new AppError(401, "webhook_signature_invalid", "useSend webhook signature is invalid.")
}

export function requirePublicHttpsOrigin(value: string, code = "usesend_origin_invalid"): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new AppError(422, code, "Enter the public HTTPS application origin.") }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || /^(localhost|127\.|0\.|\[?::1\]?$)/i.test(url.hostname) || url.hostname.endsWith(".localhost")) {
    throw new AppError(422, code, "useSend setup requires a deployed public HTTPS application origin.")
  }
  return url
}

export function parseEmailAddress(value: unknown): string | undefined {
  if (typeof value === "string") {
    const angled = /<([^<>\s@]+@[^<>\s@]+)>/.exec(value)
    const address = (angled?.[1] ?? value).trim().toLowerCase()
    return /^[^@\s]+@[^@\s]+$/.test(address) ? address : undefined
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>
    return parseEmailAddress(item.email ?? item.Email ?? item.address)
  }
  return undefined
}

export function emailDomain(address: string): string {
  return address.trim().toLowerCase().split("@")[1] ?? ""
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function headerList(value: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
      const item = entry as Record<string, unknown>
      const name = text(item.name) ?? text(item.Name)
      const headerValue = text(item.value) ?? text(item.Value)
      return name && headerValue ? [{ name, value: headerValue }] : []
    })
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([name, headerValue]) => {
      const resolved = text(headerValue)
      return resolved ? [{ name, value: resolved }] : []
    })
  }
  return []
}

function originalMessageId(headers: Array<{ name: string; value: string }>, fallback?: string): string | undefined {
  const candidate = headers.find((item) => item.name.toLowerCase() === "message-id")?.value
  if (candidate && candidate.length <= 200 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(candidate)) return candidate
  return fallback && fallback.length <= 200 ? fallback : undefined
}

export function usesendEventType(payload: Record<string, unknown>): string | undefined {
  return text(payload.type)
}

export function usesendInboundEmail(payload: Record<string, unknown>, inboundAddress: string): UsesendInboundEmail {
  const eventType = usesendEventType(payload)
  if (eventType && eventType !== "email.received") {
    throw new AppError(202, "usesend_event_ignored", "This useSend event is not inbound email and was acknowledged without creating intake.")
  }
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload
  const recipients = (Array.isArray(data.to) ? data.to : [data.to, data.originalRecipient, payload.to])
    .flatMap((item) => {
      if (Array.isArray(item)) return item.map(parseEmailAddress)
      return [parseEmailAddress(item)]
    })
    .filter((item): item is string => Boolean(item))
  const matched = recipients.find((item) => item === inboundAddress) ?? (recipients.length === 1 ? recipients[0] : undefined)
  const headers = headerList(data.headers ?? payload.headers)
  const providerId = text(data.id) ?? text(payload.id)
  const subject = text(data.subject) ?? ""
  const bodyText = text(data.text) ?? text(data.textBody) ?? text(data.TextBody) ?? ""
  const attachments = (Array.isArray(data.attachments) ? data.attachments : []).map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
    const content = text(item.content) ?? text(item.Content) ?? text(item.base64)
    const length = typeof item.contentLength === "number" ? item.contentLength : typeof item.ContentLength === "number" ? item.ContentLength : undefined
    return {
      id: text(item.id),
      filename: text(item.filename) ?? text(item.name) ?? text(item.Name),
      mimeType: text(item.contentType) ?? text(item.ContentType) ?? text(item.mimeType),
      base64: content,
      contentId: text(item.contentId) ?? text(item.ContentID),
      disposition: text(item.contentDisposition) ?? text(item.disposition),
      declaredLength: length,
      strictBase64: true as const,
    }
  })
  return {
    messageId: originalMessageId(headers, providerId),
    to: matched,
    from: parseEmailAddress(data.from) ?? parseEmailAddress(payload.from),
    subject,
    text: bodyText,
    forwardingConfirmationReview: /forwarding confirmation|confirm forwarding/i.test(`${subject}\n${bodyText}`),
    attachments,
  }
}

function usesendBaseUrl(): string {
  const configured = process.env.MCA_USESEND_BASE_URL?.trim()
  if (!configured) return USESEND_API_ORIGIN
  try {
    const url = new URL(configured)
    if (url.protocol !== "https:" || url.username || url.password) throw new Error()
    return url.origin
  } catch {
    throw new AppError(422, "usesend_base_url_invalid", "MCA_USESEND_BASE_URL must be an HTTPS origin.")
  }
}

const USESEND_USER_AGENT = "Mozilla/5.0 (compatible; MCA-Intake/1.0; +https://fundlane.io)"

function usesendErrorBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}
}

export function usesendAuthRejected(status: number, body: unknown): boolean {
  if (status !== 401 && status !== 403) return false
  const record = usesendErrorBody(body)
  return !(record.cloudflare_error || record.error_code === 1010 || record.error_name === "browser_signature_banned")
}

export async function usesendRequest<T>(
  fetchImpl: typeof fetch,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const response = await fetchImpl(`${usesendBaseUrl()}/api${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": USESEND_USER_AGENT,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => undefined) as T
  return { status: response.status, body }
}

export async function listUsesendDomains(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<UsesendDomain[]> {
  const { status, body } = await usesendRequest<unknown>(fetchImpl, apiKey, "/v1/domains")
  if (usesendAuthRejected(status, body)) throw new AppError(503, "usesend_account_rejected", "useSend rejected the API key.")
  if (status === 403) throw new AppError(503, "usesend_edge_blocked", "useSend's edge blocked the domain lookup. Retry from a deployed origin.")
  if (status !== 200) throw new AppError(502, "usesend_setup_failed", `useSend domain lookup returned HTTP ${status}.`)
  const records = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : null
  if (!records) throw new AppError(502, "usesend_response_invalid", "useSend did not return a domain list.")
  return records.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    const id = typeof item.id === "number" ? item.id : Number(item.id)
    const name = text(item.name)
    const domainStatus = text(item.status)
    if (!Number.isInteger(id) || id <= 0 || !name || !domainStatus) return []
    return [{ id, name: name.toLowerCase(), status: domainStatus }]
  })
}

export function verifiedUsesendDomain(domains: UsesendDomain[], fromAddress: string): UsesendDomain {
  const domain = emailDomain(parseEmailAddress(fromAddress) ?? "")
  if (!domain) throw new AppError(422, "usesend_from_invalid", "Enter a receipt From address on a verified useSend domain.")
  const match = domains.find((item) => item.status === "SUCCESS" && (item.name === domain || domain.endsWith(`.${item.name}`)))
  if (!match) throw new AppError(409, "usesend_domain_unverified", "The receipt From address must use a useSend domain whose status is SUCCESS.")
  return match
}

export function receiptEmailContent(input: { dealLink?: string; addDocumentLink?: string; warnings: string[] }): { subject: string; text: string; html: string } {
  const warnings = input.warnings.filter(Boolean)
  const text = [
    "We received the forwarded merchant application.",
    input.dealLink ? `Open the deal: ${input.dealLink}` : undefined,
    input.addDocumentLink ? `Add documents: ${input.addDocumentLink}` : undefined,
    warnings.length ? `Warnings: ${warnings.join(" ")}` : undefined,
    "If you did not send this message, you can ignore this email.",
  ].filter(Boolean).join("\n\n")
  const html = [
    "<p>We received the forwarded merchant application.</p>",
    input.dealLink ? `<p><a href="${input.dealLink}">Open the deal</a></p>` : "",
    input.addDocumentLink ? `<p><a href="${input.addDocumentLink}">Add documents</a></p>` : "",
    warnings.length ? `<p>Warnings: ${warnings.map((item) => item.replace(/[<>]/g, "")).join(" ")}</p>` : "",
    "<p>If you did not send this message, you can ignore this email.</p>",
  ].join("")
  return { subject: "We received the forwarded application", text, html }
}

export async function sendUsesendEmail(input: {
  apiKey: string
  from: string
  to: string | string[]
  cc?: string[]
  subject: string
  text: string
  html: string
  replyTo?: string
  attachments?: Array<{ filename: string; content: string }>
  headers?: Record<string, string>
  idempotencyKey: string
  fetchImpl?: typeof fetch
}): Promise<{ emailId: string }> {
  const { status, body } = await usesendRequest<Record<string, unknown>>(input.fetchImpl ?? fetch, input.apiKey, "/v1/emails", {
    method: "POST",
    headers: { "Idempotency-Key": input.idempotencyKey.slice(0, 256) },
    body: JSON.stringify({ to: input.to, from: input.from, subject: input.subject, text: input.text, html: input.html, ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}), ...(input.cc?.length ? { cc: input.cc } : {}), ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.headers ? { headers: input.headers } : {}) }),
  })
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : undefined
  const errorCode = text(error?.code) ?? text(record.code)
  const emailId = text(record.emailId) ?? text(record.id)
  const extra = { providerStatus: status }
  if (usesendAuthRejected(status, body)) throw new AppError(503, "usesend_auth_rejected", "useSend rejected the configured API key.", undefined, extra)
  if (status === 403) throw new AppError(503, "usesend_edge_blocked", "useSend's edge blocked the receipt send. Retry from a deployed origin.", undefined, extra)
  if (status === 429) throw new AppError(503, "usesend_rate_limited", "useSend rate limited the receipt. Retry later.", undefined, extra)
  if (status === 409 && errorCode === "NOT_UNIQUE") throw new AppError(409, "usesend_idempotency_conflict", "useSend already used this receipt idempotency key with a different payload.", undefined, extra)
  if (status !== 200 || !emailId) {
    throw new AppError(502, "usesend_send_failed", `useSend rejected the receipt with HTTP ${status}.`, undefined, extra)
  }
  return { emailId }
}
