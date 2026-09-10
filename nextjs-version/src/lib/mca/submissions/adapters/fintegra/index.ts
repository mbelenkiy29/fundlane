import "server-only"

import { randomUUID } from "node:crypto"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import {
  fintegraApplicationOverride,
  findFintegraReceipt,
  fintegraExternalRef,
  rawStatusForFixture,
  rememberFintegraReceipt,
  resolveFintegraFixture,
  submitResultFromReceipt,
  type FintegraReceipt,
} from "./fixtures"
import {
  documentsFromJob,
  FINTEGRA_SLUG,
  mapFintegraRequest,
  mapFintegraStatus,
  validateFintegraApplication,
  validateFintegraDocuments,
} from "./mapping"

export {
  FINTEGRA_MAX_OWNERS,
  FINTEGRA_SLUG,
  mapFintegraRequest,
  mapFintegraStatus,
  ssnLast4,
  validateFintegraApplication,
} from "./mapping"
export {
  FINTEGRA_FIXTURE_NAMES,
  resetFintegraAdapterForTests,
  setFintegraApplicationForTests,
  setFintegraFixtureForTests,
} from "./fixtures"

export const fintegraCapabilities = {
  submit: true,
  statusPoll: true,
  webhooks: false,
  offers: false,
} as const

function correlationId(): string {
  return adapterRuntime()?.correlationId || randomUUID()
}

function expiredFromRuntime(): boolean {
  const runtime = adapterRuntime()
  if (!runtime) return false
  const apiKey = runtime.secrets.apiKey?.trim()
  if (!apiKey) return true
  return /expired|invalid/i.test(apiKey)
}

function presentSubmit(receipt: FintegraReceipt): AdapterSubmitResult {
  return sanitizeSubmit(submitResultFromReceipt(receipt))
}

function sanitizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  const runtime = adapterRuntime()
  const next: AdapterSubmitResult = {
    ...result,
    correlationId: result.correlationId || runtime?.correlationId || randomUUID(),
  }
  if (!runtime) return next
  return redactAdapterSecrets(next, runtime.secrets)
}

function sanitizeStatus(result: AdapterStatusResult): AdapterStatusResult {
  const runtime = adapterRuntime()
  const next: AdapterStatusResult = {
    rawStatus: result.rawStatus,
    normalized: result.normalized,
    correlationId: result.correlationId || runtime?.correlationId || randomUUID(),
    eventId: result.eventId,
    unknown: result.unknown,
  }
  if (!runtime) return next
  return redactAdapterSecrets(next, runtime.secrets)
}

function store(receipt: Omit<FintegraReceipt, "attemptKey"> & { attemptKey: string }): AdapterSubmitResult {
  return presentSubmit(rememberFintegraReceipt(receipt))
}

export const fintegraAdapter: FunderAdapter = {
  slug: FINTEGRA_SLUG,
  capabilities: { ...fintegraCapabilities },
  validate(input) {
    const result = validateFintegraApplication(input)
    return result.ok ? { ok: true } : { ok: false, fields: result.fields }
  },
  async submit(job: SubmissionJob) {
    const existing = findFintegraReceipt(job.attemptKey)
    if (existing) return presentSubmit(existing)

    const fixture = resolveFintegraFixture(job.route.destination)
    const id = correlationId()
    const expired = fixture === "expired_credential" || expiredFromRuntime()

    if (fixture === "timeout") {
      return store({
        attemptKey: job.attemptKey,
        correlationId: id,
        externalRef: fintegraExternalRef(job.attemptKey),
        ok: false,
        errorCode: "provider_unavailable",
        errorMessage: "The Fintegra API timed out.",
      })
    }
    if (expired) {
      return store({
        attemptKey: job.attemptKey,
        correlationId: id,
        ok: false,
        errorCode: "credential_expired",
        errorMessage: "The Fintegra API credentials are expired or missing.",
      })
    }
    if (fixture === "disregarded_email") {
      return store({
        attemptKey: job.attemptKey,
        correlationId: id,
        externalRef: fintegraExternalRef(job.attemptKey),
        ok: false,
        rawStatus: "Disregarded Email",
        errorCode: "disregarded_email",
        errorMessage: "Fintegra disregarded this submission because the originator email is not registered.",
        fields: {
          originatorEmail: "Register this originator email with Fintegra before resubmitting.",
        },
      })
    }

    const applicationInput = fintegraApplicationOverride()
    const documentSource = applicationInput?.documents?.length ? applicationInput.documents : documentsFromJob(job)
    const documentFields = validateFintegraDocuments(documentSource)
    const validation = applicationInput
      ? validateFintegraApplication({ ...applicationInput, documents: documentSource })
      : fixture === "missing_fields"
        ? validateFintegraApplication({})
        : undefined
    const fields = validation && !validation.ok ? validation.fields : documentFields
    if (fields && Object.keys(fields).length) {
      return store({
        attemptKey: job.attemptKey,
        correlationId: id,
        ok: false,
        errorCode: "validation_failed",
        errorMessage: "Review the highlighted fields.",
        fields,
      })
    }
    const mapped = validation?.ok ? mapFintegraRequest(validation.application, job) : undefined

    return store({
      attemptKey: job.attemptKey,
      correlationId: id,
      externalRef: fintegraExternalRef(job.attemptKey),
      ok: true,
      rawStatus: rawStatusForFixture(fixture === "processed" ? "processed" : "accepted"),
      fields: {
        signedApplication: "received",
        bankStatements: "received",
        ...(mapped ? { ownerCount: String(mapped.owners.length) } : {}),
      },
    })
  },
  async getStatus(job: SubmissionJob) {
    const fixture = resolveFintegraFixture(job.route.destination)
    const receipt = findFintegraReceipt(job.attemptKey)
    const rawStatus = receipt?.rawStatus || rawStatusForFixture(fixture)
    const mapped = mapFintegraStatus(rawStatus)
    return sanitizeStatus({
      ...mapped,
      correlationId: receipt?.correlationId || correlationId(),
      eventId: `ftg-evt-${job.attemptKey}`,
      unknown: mapped.unknown,
    })
  },
}

export default fintegraAdapter
