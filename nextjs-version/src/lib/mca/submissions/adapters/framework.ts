import "server-only"

import { newId } from "../../db"
import type { DealActor } from "../../deals/schema"
import { AppError } from "../../errors"
import type {
  AdapterCapabilities,
  AdapterStatusResult,
  AdapterSubmitResult,
  FunderAdapter,
  SubmissionJob,
} from "../contracts"
import {
  effectiveAdapterCapabilities,
  findAdapterCredential,
  recordAdapterLastAction,
  redactAdapterSecrets,
  resolveAdapterEnvironment,
  resolveAdapterSecrets,
  runWithAdapterRuntime,
} from "./credentials"
import type {
  AdapterAction,
  AdapterActionView,
  AdapterExecutionOptions,
  AdapterLastAction,
  AdapterRateLimit,
  AdapterResolvedSecrets,
  AdapterRuntime,
} from "./contracts"
import { getAdapter } from "./registry"

export {
  adapterRuntime,
  effectiveAdapterCapabilities,
  redactAdapterSecrets,
  requireAdapterRead,
  requireAdapterAdmin,
  requireAdapterRuntime,
  resolveAdapterEnvironment,
  resolveAdapterSecrets,
  setAdapterEnvironmentForTests,
  toPublicAdapterCredential,
} from "./credentials"

export function adapterResultFromHttp(response: Response, correlationId: string, externalRef?: string): AdapterSubmitResult & { rateLimit?: AdapterRateLimit } {
  if (response.status === 429) {
    const rateLimit = rateLimitFromRetryAfter(response.headers.get("retry-after"))
    return {
      ok: false,
      correlationId,
      externalRef,
      errorCode: "rate_limited",
      errorMessage: `The funder API rate-limited this request. Retry after ${rateLimit.retryAt}.`,
      rateLimit,
      fields: {
        retryAt: rateLimit.retryAt,
        retryAfterSeconds: String(rateLimit.retryAfterSeconds),
        ...(externalRef ? { externalRef } : {}),
      },
    }
  }
  return {
    ok: false,
    correlationId,
    externalRef,
    errorCode: "provider_unavailable",
    errorMessage: "The funder adapter did not accept the request.",
  }
}

export function rateLimitFromRetryAfter(retryAfter: string | null | undefined, now = Date.now()): AdapterRateLimit {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { retryAfterSeconds: seconds, retryAt: new Date(now + seconds * 1000).toISOString() }
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return {
        retryAfterSeconds: Math.max(0, Math.ceil((date - now) / 1000)),
        retryAt: new Date(date).toISOString(),
      }
    }
  }
  return { retryAfterSeconds: 60, retryAt: new Date(now + 60_000).toISOString() }
}

function unavailable(correlationId: string, message: string, fields?: Record<string, string>): AdapterSubmitResult {
  return {
    ok: false,
    correlationId,
    errorCode: "provider_unavailable",
    errorMessage: message,
    fields,
  }
}

function unsupported(correlationId: string, message: string): AdapterSubmitResult {
  return {
    ok: false,
    correlationId,
    errorCode: "capability_unsupported",
    errorMessage: message,
  }
}

function flattenFields(fieldErrors?: Record<string, string[]>): Record<string, string> | undefined {
  if (!fieldErrors) return undefined
  const fields: Record<string, string> = {}
  for (const [key, values] of Object.entries(fieldErrors)) {
    const message = values.find(Boolean)
    if (message) fields[key] = message
  }
  return Object.keys(fields).length ? fields : undefined
}

function rateLimitFromFields(fields?: Record<string, string>): AdapterRateLimit | undefined {
  if (!fields?.retryAt && !fields?.retryAfterSeconds) return undefined
  const retryAfterSeconds = Number(fields.retryAfterSeconds ?? 60)
  return {
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 60,
    retryAt: fields.retryAt || new Date(Date.now() + 60_000).toISOString(),
  }
}

function adapterSlugFor(job: SubmissionJob, resolved?: AdapterResolvedSecrets): string {
  return resolved?.adapterSlug || job.route.destination
}

function resolveAdapter(slug: string): FunderAdapter | undefined {
  return getAdapter(slug)
}

export function assertStatusPollAllowed(capabilities: AdapterCapabilities, adapter?: FunderAdapter): void {
  if (!capabilities.statusPoll || !adapter?.getStatus) {
    throw new AppError(409, "capability_unsupported", "This adapter cannot check status.")
  }
}

async function loadRuntime(
  job: SubmissionJob,
  options: AdapterExecutionOptions = {},
): Promise<{ adapter?: FunderAdapter; runtime?: AdapterRuntime; correlationId: string; error?: AdapterSubmitResult }> {
  const correlationId = options.correlationId || newId()
  const environment = resolveAdapterEnvironment(options.environment)
  const slugHint = job.route.destination
  const adapterHint = resolveAdapter(slugHint)
  const resolved = await resolveAdapterSecrets({
    workspaceId: job.workspaceId,
    funderId: job.funderId,
    environment,
    adapterSlug: adapterHint?.slug,
  })
  const slug = adapterSlugFor(job, resolved)
  const adapter = resolveAdapter(slug)
  if (!resolved) {
    return {
      adapter,
      correlationId,
      error: unavailable(
        correlationId,
        environment === "production"
          ? "No production credentials are configured for this funder adapter."
          : "No development credentials are configured for this funder adapter.",
      ),
    }
  }
  if (resolved.environment !== environment || resolved.workspaceId !== job.workspaceId) {
    return {
      adapter,
      correlationId,
      error: unavailable(correlationId, "No credentials are configured for this funder adapter environment."),
    }
  }
  if (!adapter) {
    return {
      correlationId,
      error: unavailable(correlationId, `No funder adapter is registered for ${job.displayFunderName}.`),
    }
  }
  const capabilities = effectiveAdapterCapabilities(adapter.slug, resolved.capabilities)
  const runtime: AdapterRuntime = {
    credentialId: resolved.credentialId,
    workspaceId: resolved.workspaceId,
    funderId: resolved.funderId,
    adapterSlug: adapter.slug,
    environment: resolved.environment,
    capabilities,
    secrets: resolved.secrets,
    correlationId,
    externalRef: options.externalRef,
  }
  return { adapter, runtime, correlationId }
}

function sanitizeSubmitResult(result: AdapterSubmitResult, runtime: AdapterRuntime): AdapterSubmitResult {
  return redactAdapterSecrets({
    ...result,
    correlationId: result.correlationId || runtime.correlationId,
    errorMessage: result.errorMessage ? redactAdapterSecrets(result.errorMessage, runtime.secrets) : result.errorMessage,
  }, runtime.secrets)
}

function submitErrorFromUnknown(error: unknown, runtime: AdapterRuntime): AdapterSubmitResult & { rateLimit?: AdapterRateLimit } {
  if (error instanceof AppError && error.code === "rate_limited") {
    const fields = flattenFields(error.fieldErrors)
    const rateLimit = rateLimitFromFields(fields) ?? rateLimitFromRetryAfter(null)
    return redactAdapterSecrets({
      ok: false,
      correlationId: runtime.correlationId,
      externalRef: fields?.externalRef || runtime.externalRef,
      errorCode: "rate_limited",
      errorMessage: error.message,
      fields,
      rateLimit,
    }, runtime.secrets)
  }
  if (error instanceof AppError && error.code === "capability_unsupported") {
    return unsupported(runtime.correlationId, error.message)
  }
  if (error instanceof AppError && error.code === "provider_unavailable") {
    return unavailable(runtime.correlationId, error.message, flattenFields(error.fieldErrors))
  }
  return unavailable(runtime.correlationId, "The funder adapter failed.")
}

export async function submitViaAdapter(job: SubmissionJob, options: AdapterExecutionOptions = {}): Promise<AdapterSubmitResult> {
  await (await import("../../company-access")).assertCompanyOperational(job.workspaceId)
  const loaded = await loadRuntime(job, options)
  if (loaded.error) return loaded.error
  const { adapter, runtime, correlationId } = loaded
  if (!adapter || !runtime) {
    return unavailable(correlationId, `No funder adapter is registered for ${job.displayFunderName}.`)
  }
  if (!adapter.capabilities.submit) return unsupported(correlationId, `${adapter.slug} cannot submit.`)
  await (await import("../../company-access")).assertCompanyOperational(job.workspaceId)
  await (await import("../../outbound-approval")).assertOutboundDispatch(job.workspaceId, job.createdAt)
  try {
    const result = await runWithAdapterRuntime(runtime, () => adapter.submit(job))
    return sanitizeSubmitResult(result, runtime)
  } catch (error) {
    return submitErrorFromUnknown(error, runtime)
  }
}

export async function getStatusViaAdapter(job: SubmissionJob, options: AdapterExecutionOptions = {}): Promise<AdapterStatusResult> {
  const loaded = await loadRuntime(job, options)
  if (loaded.error) {
    if (loaded.error.errorCode === "provider_unavailable") {
      throw new AppError(503, "provider_unavailable", loaded.error.errorMessage ?? "No credentials are configured for this funder adapter.")
    }
    throw new AppError(409, loaded.error.errorCode ?? "capability_unsupported", loaded.error.errorMessage ?? "This adapter cannot check status.")
  }
  const { adapter, runtime } = loaded
  if (!adapter || !runtime) {
    throw new AppError(503, "provider_unavailable", `No funder adapter is registered for ${job.displayFunderName}.`)
  }
  assertStatusPollAllowed(runtime.capabilities, adapter)
  try {
    const result = await runWithAdapterRuntime(runtime, () => adapter.getStatus!(job))
    return redactAdapterSecrets(result, runtime.secrets)
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === "rate_limited") {
        const fields = flattenFields(error.fieldErrors)
        const rateLimit = rateLimitFromFields(fields) ?? rateLimitFromRetryAfter(null)
        throw new AppError(429, "rate_limited", redactAdapterSecrets(error.message, runtime.secrets), {
          retryAt: [rateLimit.retryAt],
          retryAfterSeconds: [String(rateLimit.retryAfterSeconds)],
          ...(fields?.externalRef || runtime.externalRef ? { externalRef: [fields?.externalRef || runtime.externalRef!] } : {}),
          ...error.fieldErrors,
        })
      }
      throw error
    }
    throw new AppError(503, "provider_unavailable", "The funder adapter could not check status.")
  }
}

export async function parseWebhookViaAdapter(
  slug: string,
  headers: Record<string, string>,
  body: unknown,
  options: AdapterExecutionOptions & { workspaceId?: string; funderId?: string } = {},
): Promise<AdapterStatusResult> {
  const adapter = resolveAdapter(slug)
  const capabilities = effectiveAdapterCapabilities(slug)
  if (!adapter?.parseWebhook || !capabilities.webhooks) {
    throw new AppError(409, "capability_unsupported", "This adapter cannot ingest webhooks.")
  }
  const environment = resolveAdapterEnvironment(options.environment)
  const resolved = options.workspaceId && options.funderId
    ? await resolveAdapterSecrets({
      workspaceId: options.workspaceId,
      funderId: options.funderId,
      environment,
      adapterSlug: slug,
    })
    : undefined
  const correlationId = options.correlationId || newId()
  if (options.workspaceId && options.funderId && !resolved) {
    throw new AppError(503, "provider_unavailable", "No credentials are configured for this funder adapter.")
  }
  const execute = () => adapter.parseWebhook!(headers, body)
  if (!resolved) return execute()
  const runtime: AdapterRuntime = {
    credentialId: resolved.credentialId,
    workspaceId: resolved.workspaceId,
    funderId: resolved.funderId,
    adapterSlug: slug,
    environment: resolved.environment,
    capabilities,
    secrets: resolved.secrets,
    correlationId,
    externalRef: options.externalRef,
  }
  return runWithAdapterRuntime(runtime, execute)
}

function jobFromCredential(
  record: NonNullable<Awaited<ReturnType<typeof findAdapterCredential>>>,
  input: Partial<SubmissionJob> = {},
): SubmissionJob {
  return {
    id: input.id ?? `adapter-action-${record.id}`,
    workspaceId: record.workspaceId,
    dealId: input.dealId ?? "unbound",
    funderId: record.funderId,
    displayFunderName: input.displayFunderName ?? record.adapterSlug,
    routeKind: "api",
    route: input.route ?? {
      id: `adapter-route-${record.id}`,
      kind: "api",
      label: record.adapterSlug,
      destination: record.adapterSlug,
      documentExceptions: [],
      active: true,
    },
    state: input.state ?? "sent",
    confirmationKey: input.confirmationKey ?? record.id,
    attemptKey: input.attemptKey ?? record.id,
    analysisRunId: input.analysisRunId,
    dealVersion: input.dealVersion ?? 0,
    documentVersions: input.documentVersions ?? [],
    packageDocumentIds: input.packageDocumentIds ?? [],
    preflightErrors: input.preflightErrors ?? [],
    merchantIdentityKey: input.merchantIdentityKey ?? `deal:${input.dealId ?? "unbound"}`,
    packageFingerprint: input.packageFingerprint ?? "",
    reason: input.reason,
    createdAt: input.createdAt ?? record.updatedAt,
    updatedAt: input.updatedAt ?? record.updatedAt,
  }
}

function lastActionFromView(view: AdapterActionView): AdapterLastAction {
  return {
    action: view.action,
    correlationId: view.correlationId,
    externalRef: view.externalRef,
    errorCode: view.errorCode,
    errorMessage: view.errorMessage,
    fields: view.fields,
    rateLimit: view.rateLimit,
    rawStatus: view.rawStatus,
    at: new Date().toISOString(),
  }
}

function viewFromSubmit(action: AdapterAction, credentialId: string, capabilities: AdapterCapabilities, result: AdapterSubmitResult & { rateLimit?: AdapterRateLimit }): AdapterActionView {
  return {
    ok: result.ok,
    action,
    credentialId,
    correlationId: result.correlationId,
    externalRef: result.externalRef,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    fields: result.fields,
    rateLimit: result.rateLimit ?? rateLimitFromFields(result.fields),
    rawStatus: result.rawStatus,
    capabilities,
  }
}

async function requireCredential(actor: DealActor, credentialId: string) {
  const record = await findAdapterCredential(actor.workspaceId, credentialId)
  if (!record || record.workspaceId !== actor.workspaceId) {
    throw new AppError(403, "permission_denied", "You do not have permission to perform this action.")
  }
  return record
}

export async function checkAdapterStatus(
  actor: DealActor,
  credentialId: string,
  input: AdapterExecutionOptions & { job?: Partial<SubmissionJob> } = {},
): Promise<AdapterActionView> {
  const record = await requireCredential(actor, credentialId)
  const adapter = resolveAdapter(record.adapterSlug)
  const capabilities = effectiveAdapterCapabilities(record.adapterSlug, record.capabilities)
  assertStatusPollAllowed(capabilities, adapter)
  const job = jobFromCredential(record, input.job)
  try {
    const status = await getStatusViaAdapter(job, {
      environment: record.environment,
      correlationId: input.correlationId,
      externalRef: input.externalRef,
    })
    const view: AdapterActionView = {
      ok: true,
      action: "status",
      credentialId: record.id,
      correlationId: status.correlationId,
      externalRef: input.externalRef,
      rawStatus: status.rawStatus,
      normalized: status.normalized,
      unknown: status.unknown,
      capabilities,
    }
    await recordAdapterLastAction(actor.workspaceId, record.id, lastActionFromView(view))
    return view
  } catch (error) {
    if (error instanceof AppError && error.code === "rate_limited") {
      const fields = flattenFields(error.fieldErrors)
      const view: AdapterActionView = {
        ok: false,
        action: "status",
        credentialId: record.id,
        correlationId: input.correlationId || actor.correlationId,
        externalRef: fields?.externalRef || input.externalRef,
        errorCode: "rate_limited",
        errorMessage: error.message,
        fields,
        rateLimit: rateLimitFromFields(fields) ?? rateLimitFromRetryAfter(null),
        capabilities,
      }
      await recordAdapterLastAction(actor.workspaceId, record.id, lastActionFromView(view))
      throw new AppError(429, "rate_limited", error.message, error.fieldErrors)
    }
    throw error
  }
}

export async function retryAdapterAction(
  actor: DealActor,
  credentialId: string,
  input: AdapterExecutionOptions & { action?: AdapterAction; job?: Partial<SubmissionJob> } = {},
): Promise<AdapterActionView> {
  const record = await requireCredential(actor, credentialId)
  const action: AdapterAction = input.action === "submit" ? "submit" : "status"
  const correlationId = input.correlationId || record.lastAction?.correlationId || newId()
  const externalRef = input.externalRef || record.lastAction?.externalRef
  const job = jobFromCredential(record, {
    ...input.job,
    attemptKey: input.job?.attemptKey ?? record.lastAction?.externalRef ?? record.id,
  })
  if (action === "status") {
    return checkAdapterStatus(actor, credentialId, { ...input, correlationId, externalRef, job })
  }
  const result = await submitViaAdapter(job, {
    environment: record.environment,
    correlationId,
    externalRef,
  })
  const capabilities = effectiveAdapterCapabilities(record.adapterSlug, record.capabilities)
  const view = viewFromSubmit("submit", record.id, capabilities, result)
  await recordAdapterLastAction(actor.workspaceId, record.id, lastActionFromView(view))
  if (!result.ok && result.errorCode === "rate_limited") {
    throw new AppError(429, "rate_limited", result.errorMessage ?? "The funder API rate-limited this request.", {
      retryAt: view.rateLimit ? [view.rateLimit.retryAt] : [],
      retryAfterSeconds: view.rateLimit ? [String(view.rateLimit.retryAfterSeconds)] : [],
      ...(view.externalRef ? { externalRef: [view.externalRef] } : {}),
      ...(result.fields ? Object.fromEntries(Object.entries(result.fields).map(([key, value]) => [key, [value]])) : {}),
    })
  }
  if (!result.ok && result.errorCode === "provider_unavailable") {
    throw new AppError(503, "provider_unavailable", result.errorMessage ?? "No credentials are configured for this funder adapter.", result.fields
      ? Object.fromEntries(Object.entries(result.fields).map(([key, value]) => [key, [value]]))
      : undefined)
  }
  if (!result.ok && result.errorCode === "capability_unsupported") {
    throw new AppError(409, "capability_unsupported", result.errorMessage ?? "This adapter cannot perform that action.")
  }
  return view
}
