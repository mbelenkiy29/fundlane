import "server-only"

import { isIP } from "node:net"
import { newId } from "../db"
import type { DeliverResult, SubmissionJob } from "./contracts"

type WebhookFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchOverride: WebhookFetch | undefined

export function setWebhookFetchForTests(fetchImpl?: WebhookFetch): void {
  fetchOverride = fetchImpl
}

function http(): WebhookFetch {
  return fetchOverride ?? globalThis.fetch
}

export const WEBHOOK_RESPONSE_SYNC = false as const

export interface WebhookSchemaPreview {
  method: "POST"
  contentType: "application/json"
  responseSync: false
  statusPoll: false
  authenticationHeader: string
  destinationHost: string
  headers: Record<string, string>
  sample: WebhookPayload
}

export interface WebhookPayload {
  dealId: string
  funderId: string
  jobId: string
  confirmationKey: string
  dealVersion: number
  documents: Array<{ documentId: string; checksum: string; category: string }>
  correlationId: string
}

export interface WebhookTarget {
  url: string
  authorization?: string
  host: string
}

function isPrivateIp(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address
  if (isIP(mapped) !== 4) return false
  const [a, b] = mapped.split(".").map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "metadata.google.internal") return true
  if (isIP(host)) return isPrivateIp(host)
  return false
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function resolveWebhookTarget(destination: string): { ok: true; target: WebhookTarget } | { ok: false; message: string } {
  const raw = destination.trim()
  if (!raw) return { ok: false, message: "This funder has no webhook destination." }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: "The webhook destination is not a valid URL." }
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "Webhook destinations must use HTTPS." }
  }
  if (isBlockedHostname(url.hostname)) {
    return { ok: false, message: "Private-network webhook destinations are not allowed." }
  }

  let authorization: string | undefined
  if (url.username || url.password) {
    const username = decodeUserinfo(url.username)
    const password = decodeUserinfo(url.password)
    authorization = password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : `Bearer ${username}`
  }

  const token = url.searchParams.get("token") ?? url.searchParams.get("access_token")
  if (token && !authorization) {
    authorization = `Bearer ${token}`
  }
  url.searchParams.delete("token")
  url.searchParams.delete("access_token")
  const outbound = new URL(`${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`)

  return {
    ok: true,
    target: {
      url: outbound.toString(),
      authorization,
      host: outbound.host,
    },
  }
}

export function buildWebhookPayload(job: SubmissionJob, correlationId: string): WebhookPayload {
  const included = new Set(job.packageDocumentIds)
  return {
    dealId: job.dealId,
    funderId: job.funderId,
    jobId: job.id,
    confirmationKey: job.confirmationKey,
    dealVersion: job.dealVersion,
    documents: job.documentVersions
      .filter((document) => included.has(document.documentId))
      .map((document) => ({
        documentId: document.documentId,
        checksum: document.checksum,
        category: document.category,
      })),
    correlationId,
  }
}

export function webhookSchemaPreview(job: SubmissionJob): WebhookSchemaPreview {
  const resolved = resolveWebhookTarget(job.route.destination)
  return {
    method: "POST",
    contentType: "application/json",
    responseSync: WEBHOOK_RESPONSE_SYNC,
    statusPoll: false,
    authenticationHeader: "Authorization header derived from the funder route destination (URL userinfo or token query).",
    destinationHost: resolved.ok ? resolved.target.host : "",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": "<correlationId>",
      "x-mca-response-sync": "false",
      authorization: "<from funder route destination>",
    },
    sample: buildWebhookPayload(job, "<correlationId>"),
  }
}

function failed(correlationId: string, errorCode: string, errorMessage: string): DeliverResult {
  return {
    ok: false,
    state: "failed",
    correlationId,
    errorCode,
    errorMessage,
  }
}

export async function deliverWebhook(job: SubmissionJob): Promise<DeliverResult> {
  const correlationId = newId()
  const resolved = resolveWebhookTarget(job.route.destination)
  if (!resolved.ok) return failed(correlationId, "provider_unavailable", resolved.message)

  try {
    const response = await http()(resolved.target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-correlation-id": correlationId,
        "x-mca-response-sync": "false",
        ...(resolved.target.authorization ? { authorization: resolved.target.authorization } : {}),
      },
      body: JSON.stringify(buildWebhookPayload(job, correlationId)),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return failed(
        correlationId,
        response.status >= 500 ? "provider_error" : "delivery_failed",
        `Webhook returned HTTP ${response.status}.`,
      )
    }
    const externalRef = response.headers.get("x-external-ref")?.trim() || undefined
    return {
      ok: true,
      state: "sent",
      correlationId,
      externalRef,
    }
  } catch {
    return failed(correlationId, "provider_unavailable", "Webhook delivery failed.")
  }
}
