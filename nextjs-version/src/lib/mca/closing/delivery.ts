import "server-only"

import { createHash } from "node:crypto"
import { newId } from "../db"

export interface ClosingTransportRequest {
  workspaceId?: string
  kind: "stipulation_request" | "contract_request" | "repricing_request" | "offer_message" | "psf_request"
  channel: "email" | "sms" | "webhook"
  endpoint?: string
  authorizationToken?: string
  senderId?: string
  sender?: { fromName: string; fromAddress: string }
  recipient: string
  subject?: string
  body?: string
  payload?: Record<string, unknown>
  attachments?: Array<{ id: string; version: number; checksum: string; url: string; expiresAt: string; filename?: string; mimeType?: string; bytes?: Uint8Array }>
  correlationId: string
  recordId: string
  attemptKey: string
  payloadHash: string
}

export interface ClosingTransportResult {
  state: "sent" | "failed" | "blocked"
  correlationId: string
  externalId?: string
  errorCode?: string
  errorMessage?: string
}

export interface ClosingTransport {
  deliver(request: ClosingTransportRequest): Promise<ClosingTransportResult>
  reconcile?(request: ClosingTransportRequest): Promise<ClosingTransportResult>
}

let transportOverride: ClosingTransport | undefined

export function setClosingTransportForTests(transport?: ClosingTransport): void {
  transportOverride = transport
}

function endpointFor(request: ClosingTransportRequest): string | undefined {
  if (request.endpoint) return request.endpoint
  if (request.channel === "sms") return process.env.MCA_MERCHANT_SMS_WEBHOOK_URL?.trim()
  if (request.kind === "offer_message") return process.env.MCA_MERCHANT_EMAIL_WEBHOOK_URL?.trim()
  return process.env.MCA_CLOSING_EMAIL_WEBHOOK_URL?.trim()
}

function tokenFor(request: ClosingTransportRequest): string | undefined {
  if (request.authorizationToken) return request.authorizationToken
  if (request.channel === "sms") return process.env.MCA_MERCHANT_SMS_WEBHOOK_TOKEN?.trim()
  if (request.kind === "offer_message") return process.env.MCA_MERCHANT_EMAIL_WEBHOOK_TOKEN?.trim()
  return process.env.MCA_CLOSING_EMAIL_WEBHOOK_TOKEN?.trim()
}

type PostmarkResponse = { ErrorCode?: unknown; MessageID?: unknown }
type PostmarkSearchResponse = { Messages?: Array<{ MessageID?: unknown; Recipient?: unknown; Metadata?: unknown }> }

function postmarkFrom(sender: NonNullable<ClosingTransportRequest["sender"]>): string {
  const name = sender.fromName.replace(/[\r\n"<>]/g, " ").replace(/\s+/g, " ").trim()
  return name ? `${name} <${sender.fromAddress}>` : sender.fromAddress
}

export function createPostmarkClosingTransport(options: { serverToken: string; allowedFromAddresses: readonly string[]; messageStream?: string; fetchImpl?: typeof fetch }): ClosingTransport {
  const fetchImpl = options.fetchImpl ?? fetch
  const serverToken = options.serverToken.trim()
  const allowedFrom = new Set(options.allowedFromAddresses.map((value) => value.trim().toLowerCase()).filter(Boolean))
  const messageStream = options.messageStream?.trim() || "outbound"
  const headers = { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": serverToken }

  async function reconcile(request: ClosingTransportRequest): Promise<ClosingTransportResult> {
    if (!serverToken) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_server_token_unconfigured", errorMessage: "Postmark sending is not configured." }
    try {
      const query = new URLSearchParams({ count: "10", offset: "0", recipient: request.recipient, [`metadata_mca_delivery_id`]: request.correlationId, messagestream: messageStream })
      const response = await fetchImpl(`https://api.postmarkapp.com/messages/outbound?${query}`, { method: "GET", headers, signal: AbortSignal.timeout(10_000), redirect: "error" })
      if (!response.ok) return { state: "blocked", correlationId: request.correlationId, errorCode: "provider_outcome_unknown", errorMessage: "Postmark delivery could not be reconciled. Check provider activity before retrying." }
      const body = await response.json().catch(() => ({})) as PostmarkSearchResponse
      const match = body.Messages?.find((item) => {
        const metadata = item.Metadata && typeof item.Metadata === "object" && !Array.isArray(item.Metadata) ? item.Metadata as Record<string, unknown> : {}
        return item.Recipient === request.recipient && metadata.mca_delivery_id === request.correlationId && metadata.mca_payload_hash === request.payloadHash
      })
      const messageId = typeof match?.MessageID === "string" ? match.MessageID.trim().slice(0, 300) : ""
      return messageId
        ? { state: "sent", correlationId: request.correlationId, externalId: messageId }
        : { state: "blocked", correlationId: request.correlationId, errorCode: "provider_outcome_unknown", errorMessage: "Postmark did not confirm whether the message was accepted. Check provider activity before retrying." }
    } catch {
      return { state: "blocked", correlationId: request.correlationId, errorCode: "provider_outcome_unknown", errorMessage: "Postmark delivery could not be reconciled. Check provider activity before retrying." }
    }
  }

  return {
    reconcile,
    async deliver(request) {
      if (!serverToken) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_server_token_unconfigured", errorMessage: "Postmark sending is not configured." }
      if (request.channel !== "email") return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_email_only", errorMessage: "Postmark transport only supports email." }
      if (!request.sender || !allowedFrom.has(request.sender.fromAddress.toLowerCase())) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_sender_unconfirmed", errorMessage: "The selected sender is not confirmed for Postmark delivery." }
      if (!request.subject || !request.body) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_content_missing", errorMessage: "The saved email preview is incomplete." }
      const attachments = request.attachments ?? []
      if (attachments.some((item) => !item.filename || !item.mimeType || !item.bytes)) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_attachment_unavailable", errorMessage: "A pinned attachment could not be loaded for delivery." }
      const rawAttachmentBytes = attachments.reduce((total, item) => total + (item.bytes?.byteLength ?? 0), 0)
      if (rawAttachmentBytes > 35_000_000) return { state: "blocked", correlationId: request.correlationId, errorCode: "postmark_payload_too_large", errorMessage: "The authorized attachments are too large for Postmark delivery." }
      try {
        const response = await fetchImpl("https://api.postmarkapp.com/email", {
          method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            From: postmarkFrom(request.sender), To: request.recipient, Subject: request.subject, TextBody: request.body,
            MessageStream: messageStream, Tag: "mca-closing",
            Metadata: { mca_delivery_id: request.correlationId, mca_record_id: request.recordId, mca_payload_hash: request.payloadHash },
            Attachments: attachments.map((item) => ({ Name: item.filename, Content: Buffer.from(item.bytes!).toString("base64"), ContentType: item.mimeType })),
          }),
        })
        const body = await response.json().catch(() => undefined) as PostmarkResponse | undefined
        if (response.status >= 500) return reconcile(request)
        if (!response.ok) {
          const code = response.status === 401 || response.status === 403 ? "postmark_auth_rejected" : response.status === 429 ? "postmark_rate_limited" : "postmark_rejected"
          const errorMessage = code === "postmark_auth_rejected" ? "Postmark rejected the configured server credential."
            : code === "postmark_rate_limited" ? "Postmark rate limited the message request. Retry later."
              : `Postmark rejected the message with HTTP ${response.status}.`
          return { state: "failed", correlationId: request.correlationId, errorCode: code, errorMessage }
        }
        if (typeof body?.ErrorCode !== "number") return reconcile(request)
        if (body.ErrorCode !== 0) return { state: "failed", correlationId: request.correlationId, errorCode: `postmark_${body.ErrorCode}`, errorMessage: `Postmark rejected the message with provider error code ${body.ErrorCode}.` }
        const messageId = typeof body?.MessageID === "string" ? body.MessageID.trim().slice(0, 300) : ""
        if (messageId) return { state: "sent", correlationId: request.correlationId, externalId: messageId }
        return reconcile(request)
      } catch {
        return reconcile(request)
      }
    },
  }
}

type PostmarkConnection = { workspaceId?: unknown; senderId?: unknown; fromAddress?: unknown; serverToken?: unknown; messageStream?: unknown }

function postmarkConnectionsFromEnvironment(): PostmarkConnection[] {
  let connections: PostmarkConnection[] = []
  try {
    const parsed = JSON.parse(process.env.MCA_CLOSING_POSTMARK_CONNECTIONS_JSON ?? "[]") as unknown
    if (Array.isArray(parsed)) connections = parsed as PostmarkConnection[]
  } catch {
    connections = []
  }
  return connections
}

export function postmarkConnectionConfigured(workspaceId: string): boolean {
  return process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark" && postmarkConnectionsFromEnvironment().some((entry) => entry.workspaceId === workspaceId && typeof entry.senderId === "string" && Boolean(entry.senderId) && typeof entry.fromAddress === "string" && Boolean(entry.fromAddress) && typeof entry.serverToken === "string" && Boolean(entry.serverToken))
}

export function configuredPostmarkClosingTransport(request: ClosingTransportRequest, fetchImpl?: typeof fetch): ClosingTransport {
  const connections = postmarkConnectionsFromEnvironment()
  const connection = connections.find((entry) => entry.workspaceId === request.workspaceId && entry.senderId === request.senderId && typeof entry.fromAddress === "string" && entry.fromAddress.toLowerCase() === request.sender?.fromAddress.toLowerCase())
  return createPostmarkClosingTransport({
    serverToken: typeof connection?.serverToken === "string" ? connection.serverToken : "",
    allowedFromAddresses: typeof connection?.fromAddress === "string" ? [connection.fromAddress] : [],
    messageStream: typeof connection?.messageStream === "string" ? connection.messageStream : process.env.MCA_CLOSING_POSTMARK_MESSAGE_STREAM,
    fetchImpl,
  })
}

const liveTransport: ClosingTransport = {
  async deliver(request) {
    if (request.channel === "email" && process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark") return configuredPostmarkClosingTransport(request).deliver(request)
    const endpoint = endpointFor(request)
    if (!endpoint) {
      const capability = request.channel === "sms" ? "merchant_sms_unconfigured"
        : request.kind === "psf_request" ? "psf_webhook_unconfigured"
          : request.kind === "offer_message" ? "merchant_email_unconfigured" : "closing_email_unconfigured"
      return { state: "blocked", correlationId: request.correlationId, errorCode: capability, errorMessage: "The requested delivery provider is not configured." }
    }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": request.correlationId,
          "idempotency-key": request.attemptKey,
          ...(tokenFor(request) ? { authorization: `Bearer ${tokenFor(request)}` } : {}),
        },
        body: JSON.stringify({
          schemaVersion: 1, kind: request.kind, channel: request.channel, senderId: request.senderId,
          recipient: request.recipient, subject: request.subject, body: request.body, payload: request.payload,
          attachments: request.attachments?.map((item) => ({ id: item.id, version: item.version, checksum: item.checksum, url: item.url, expiresAt: item.expiresAt })),
          correlationId: request.correlationId, recordId: request.recordId, payloadHash: request.payloadHash,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      })
      if (!response.ok) return { state: "failed", correlationId: request.correlationId, errorCode: "provider_rejected", errorMessage: `Provider rejected the request with HTTP ${response.status}.` }
      const responseBody = await response.json().catch(() => ({})) as { id?: unknown; externalId?: unknown }
      const externalId = String(responseBody.externalId ?? responseBody.id ?? response.headers.get("x-request-id") ?? "").slice(0, 300) || undefined
      return { state: "sent", correlationId: request.correlationId, externalId }
    } catch {
      return { state: "failed", correlationId: request.correlationId, errorCode: "provider_unavailable", errorMessage: "The delivery provider could not be reached." }
    }
  },
  async reconcile(request) {
    if (request.channel === "email" && process.env.MCA_CLOSING_EMAIL_PROVIDER === "postmark") return configuredPostmarkClosingTransport(request).reconcile!(request)
    return { state: "blocked", correlationId: request.correlationId, errorCode: "provider_outcome_unknown", errorMessage: "The delivery outcome requires provider reconciliation." }
  },
}

export function closingTransport(): ClosingTransport { return transportOverride ?? liveTransport }

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function deliveryCorrelationId(): string { return newId() }
