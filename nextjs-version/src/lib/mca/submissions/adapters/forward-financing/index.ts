import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  forwardFinancingFixtureDestination,
  getBoundApplication,
  peekFixture,
  resolveFixtureScenario,
} from "./fixtures"
import {
  DEFAULT_OUTSTANDING_DOCUMENTS,
  FORWARD_FINANCING_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindForwardFinancingApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  forwardFinancingFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetForwardFinancingFixtures,
  resolveFixtureScenario,
  setForwardFinancingFixture,
} from "./fixtures"
export {
  DEFAULT_OUTSTANDING_DOCUMENTS,
  documentsCoverOutstanding,
  FORWARD_FINANCING_SLUG,
  FORWARD_INDUSTRIES,
  mapApplication,
  mapEntityType,
  mapIndustry,
  mapJobDocuments,
  mapProviderStatus,
  MAX_OWNERS,
  PROVIDER_STATUS_MAP,
  selectOwners,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return forwardFinancingFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential" || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
}

function documentFields(receipts: Array<{ documentId: string; category: string; receiptId: string }>): Record<string, string> | undefined {
  if (!receipts.length) return undefined
  const fields: Record<string, string> = {}
  receipts.forEach((receipt, index) => {
    fields[`documents.${index}.documentId`] = receipt.documentId
    fields[`documents.${index}.category`] = receipt.category
    fields[`documents.${index}.receiptId`] = receipt.receiptId
  })
  return fields
}

function finalizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function submitResult(job: SubmissionJob, executed: ReturnType<typeof executeSubmit>): AdapterSubmitResult {
  const correlationId = correlationIdFor(job, `ff-${job.id}`)
  if (!executed.ok || !executed.record) {
    return finalizeSubmit({
      ok: false,
      correlationId,
      externalRef: executed.record?.externalRef,
      errorCode: executed.errorCode,
      errorMessage: executed.errorMessage,
    })
  }
  const complete = executed.record.outstandingDocuments.length === 0
  return finalizeSubmit({
    ok: true,
    correlationId,
    externalRef: executed.record.externalRef,
    rawStatus: executed.record.rawStatus,
    fields: {
      ...(documentFields(executed.record.documentReceipts) ?? {}),
      documentsComplete: complete ? "true" : "false",
    },
  })
}

export const forwardFinancingAdapter: FunderAdapter = {
  slug: FORWARD_FINANCING_SLUG,
  capabilities: {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  },
  validate(input) {
    const result = validateApplication(input)
    return result.ok ? { ok: true } : { ok: false, fields: result.fields }
  },
  async submit(job) {
    const bound = getBoundApplication(job.attemptKey)
    const documents = mapJobDocuments(job)
    if (bound !== undefined) {
      const validated = validateApplication(bound)
      if (!validated.ok) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `ff-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: validated.fields,
        })
      }
      const mapped = mapApplication(validated.value, documents)
      return submitResult(job, executeSubmit({
        attemptKey: job.attemptKey,
        destination: destinationFor(job),
        expired: isExpired(job),
        documents,
        mapped: {
          entityType: mapped.business.entityType,
          industry: mapped.business.industry,
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
            ownershipPercent: owner.ownershipPercent,
            ssnLast4: owner.ssnLast4,
          })),
          documentsComplete: mapped.documents.length > 0,
        },
      }))
    }
    return submitResult(job, executeSubmit({
      attemptKey: job.attemptKey,
      destination: destinationFor(job),
      expired: isExpired(job),
      documents,
    }))
  },
  async getStatus(job): Promise<AdapterStatusResult> {
    if (isExpired(job)) {
      throw new AppError(503, "provider_unavailable", "The funder API credentials have expired.")
    }
    const record = peekFixture(job.attemptKey)
    const scenario = resolveFixtureScenario(destinationFor(job))
    const outstanding = record?.outstandingDocuments
      ?? (scenario === "missing-info" ? [...DEFAULT_OUTSTANDING_DOCUMENTS] : [])
    const fallbackRaw = scenario === "missing-info"
      ? "Missing Info"
      : scenario === "declined"
        ? "Declined"
        : scenario === "approved"
          ? "Approved"
          : "unknown"
    const mapped = mapProviderStatus(record?.rawStatus ?? fallbackRaw, outstanding)
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `ff-status-${job.id}`),
      eventId: record ? `ff-event-${job.attemptKey}` : undefined,
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default forwardFinancingAdapter
