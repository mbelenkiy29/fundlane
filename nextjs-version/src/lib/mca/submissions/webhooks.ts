import "server-only"

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { getDatabase } from "../db"
import type { DealActor } from "../deals/schema"
import { AppError } from "../errors"
import { parseWebhookViaAdapter, redactAdapterSecrets } from "./adapters/framework"
import {
  effectiveAdapterCapabilities,
  resolveAdapterEnvironment,
  resolveAdapterSecrets,
} from "./adapters/credentials"
import { getAdapter } from "./adapters/registry"
import type { AdapterStatusResult, SubmissionJob } from "./contracts"
import { reconcileProviderStatus, type ReconcileProviderStatusResult } from "./reconciliation"
import { findJobById } from "./repository"

export const WEBHOOK_SECRET_HEADER = "x-mca-webhook-secret"
export const WEBHOOK_SIGNATURE_HEADER = "x-mca-signature"

const TEXT_MAX = 200_000

export interface IngestAdapterWebhookInput {
  slug: string
  headers: Record<string, string>
  body: unknown
  rawBody: string
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want && value.trim()) return value.trim()
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const next = value.trim()
  return next || undefined
}

function secretsEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return a.length === b.length && timingSafeEqual(a, b)
}

function suppliedSecret(headers: Record<string, string>): string | undefined {
  const direct = header(headers, WEBHOOK_SECRET_HEADER) ?? header(headers, "x-webhook-secret")
  if (direct) return direct
  const authorization = header(headers, "authorization")
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim()
    if (token && !token.startsWith("mca_")) return token
  }
  return undefined
}

function hmacValid(secret: string, rawBody: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const supplied = signature.replace(/^sha256=/i, "").trim()
  if (!/^[0-9a-f]+$/i.test(supplied)) return false
  return secretsEqual(expected, supplied.toLowerCase())
}

function unauthenticated(): never {
  throw new AppError(401, "webhook_unauthenticated", "Webhook authenticity could not be verified.")
}

function readIdentifier(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asText(body[key])
    if (value) return value
  }
  return undefined
}

async function findJobFromWebhook(slug: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<SubmissionJob | undefined> {
  const jobId = header(headers, "x-mca-job-id") ?? readIdentifier(body, ["jobId", "job_id", "submissionJobId"])
  if (jobId) {
    const row = await getDatabase().prepare<{ workspace_id: string }>("SELECT workspace_id FROM mca_submission_jobs WHERE id = ?").get(jobId)
    if (!row) return undefined
    const job = await findJobById(row.workspace_id, jobId)
    if (!job || job.route.destination !== slug) return undefined
    return job
  }
  const externalRef = header(headers, "x-mca-external-ref") ?? readIdentifier(body, ["externalRef", "external_ref", "reference"])
  if (externalRef) {
    const row = await getDatabase().prepare<{ workspace_id: string; id: string }>(
      `SELECT j.workspace_id, j.id FROM mca_submission_jobs j
       JOIN mca_submission_attempts a ON a.job_id = j.id
       WHERE a.external_ref = ? AND j.route_kind = 'api'
       ORDER BY a.created_at DESC, j.id DESC LIMIT 1`,
    ).get(externalRef)
    if (!row) return undefined
    const job = await findJobById(row.workspace_id, row.id)
    if (!job || job.route.destination !== slug) return undefined
    return job
  }
  return undefined
}

function systemActor(job: SubmissionJob, correlationId: string): DealActor {
  return {
    workspaceId: job.workspaceId,
    userId: null,
    membershipId: null,
    role: null,
    managedMembershipIds: [],
    activeMembershipIds: [],
    source: "system",
    correlationId,
  }
}

function verifySecret(secret: string, headers: Record<string, string>, rawBody: string): void {
  const provided = suppliedSecret(headers)
  const signature = header(headers, WEBHOOK_SIGNATURE_HEADER)
  const secretOk = provided ? secretsEqual(provided, secret) : false
  const hmacOk = signature ? hmacValid(secret, rawBody, signature) : false
  if (!secretOk && !hmacOk) unauthenticated()
}

export function parseWebhookJson(rawBody: string): unknown {
  if (rawBody.length > TEXT_MAX) {
    throw new AppError(413, "payload_too_large", "Webhook body is too large.")
  }
  try {
    return JSON.parse(rawBody) as unknown
  } catch {
    throw new AppError(400, "invalid_json", "Webhook body must be valid JSON.")
  }
}

export async function ingestAdapterWebhook(input: IngestAdapterWebhookInput): Promise<ReconcileProviderStatusResult> {
  const slug = input.slug.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new AppError(404, "adapter_not_found", "The requested funder adapter was not found.")
  }
  const adapter = getAdapter(slug)
  const capabilities = effectiveAdapterCapabilities(slug)
  if (!adapter?.parseWebhook || !capabilities.webhooks) {
    throw new AppError(409, "capability_unsupported", "This adapter cannot ingest webhooks.")
  }

  const body = asRecord(input.body)
  const job = await findJobFromWebhook(slug, input.headers, body)
  if (!job) unauthenticated()
  if (job.routeKind !== "api") unauthenticated()

  const resolved = await resolveAdapterSecrets({
    workspaceId: job.workspaceId,
    funderId: job.funderId,
    environment: resolveAdapterEnvironment(),
    adapterSlug: slug,
  })
  const webhookSecret = resolved?.secrets.webhookSecret
  if (!webhookSecret) unauthenticated()
  verifySecret(webhookSecret, input.headers, input.rawBody)

  const parsed: AdapterStatusResult = await parseWebhookViaAdapter(slug, input.headers, input.body, {
    workspaceId: job.workspaceId,
    funderId: job.funderId,
    correlationId: asText(body.correlationId) ?? job.id,
    externalRef: asText(body.externalRef) ?? asText(body.external_ref),
  })
  const status = redactAdapterSecrets(parsed, resolved.secrets)
  const eventId = status.eventId || asText(body.eventId) || asText(body.event_id)
  if (!eventId) {
    throw new AppError(422, "webhook_event_id_required", "Webhook eventId is required.")
  }
  const result = await reconcileProviderStatus({
    job,
    status: { ...status, eventId },
    source: "webhook",
    eventKey: `webhook:${slug}:${eventId}`,
    actor: systemActor(job, status.correlationId),
  })
  return redactAdapterSecrets(result, resolved.secrets)
}

export function requestHeaderMap(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return headers
}
