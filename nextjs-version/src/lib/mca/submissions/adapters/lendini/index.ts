import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  decisionStatusForScenario,
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  lendiniFixtureDestination,
  peekFixture,
  resolveFixtureScenario,
  termsForScenario,
} from "./fixtures"
import {
  ACKNOWLEDGEMENT_STATUS,
  LENDINI_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindLendiniApplication,
  decisionStatusForScenario,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  LENDINI_FIXTURE_TRANSPORT,
  lendiniApplicationId,
  lendiniFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetLendiniFixtures,
  resolveFixtureScenario,
  setLendiniFixture,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  ACKNOWLEDGEMENT_STATUS,
  formatIndustry,
  LENDINI_ENTITY_TYPES,
  LENDINI_INDUSTRIES,
  LENDINI_SLUG,
  mapApplication,
  mapDocumentCategory,
  mapEntityType,
  mapIndustry,
  mapJobDocuments,
  mapProviderStatus,
  MAX_OWNERS,
  PROVIDER_STATUS_MAP,
  selectPrimaryOwner,
  statusToken,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return lendiniFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
}

function documentFields(receipts: Array<{ documentId: string; category: string; receiptId: string }>): Record<string, string> {
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
  const correlationId = correlationIdFor(job, `lendini-${job.id}`)
  if (!executed.ok || !executed.record) {
    return finalizeSubmit({
      ok: false,
      correlationId,
      externalRef: executed.record?.externalRef,
      errorCode: executed.errorCode,
      errorMessage: executed.errorMessage,
    })
  }
  return finalizeSubmit({
    ok: true,
    correlationId,
    externalRef: executed.record.externalRef,
    rawStatus: executed.record.acknowledgementStatus,
    fields: {
      applicationId: executed.record.externalRef,
      acknowledgement: executed.record.acknowledgementStatus,
      ...documentFields(executed.record.documentReceipts),
    },
  })
}

export const lendiniAdapter: FunderAdapter = {
  slug: LENDINI_SLUG,
  capabilities: {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: true,
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
          correlationId: correlationIdFor(job, `lendini-${job.id}`),
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
          legalName: mapped.business.legalName,
          entityType: mapped.business.entityType,
          industry: mapped.business.industry,
          startDate: mapped.business.startDate,
          owners: [{
            firstName: mapped.owner.firstName,
            lastName: mapped.owner.lastName,
            ownershipPercent: mapped.owner.ownershipPercent,
          }],
          documentCategories: mapped.documents.map((document) => document.category),
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
    const rawStatus = record?.decisionStatus || record?.rawStatus || decisionStatusForScenario(scenario) || ACKNOWLEDGEMENT_STATUS
    const mapped = mapProviderStatus(rawStatus)
    const terms = mapped.normalized === "approved"
      ? record?.terms ?? termsForScenario(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `lendini-status-${job.id}`),
      eventId: record ? `lendini-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default lendiniAdapter
