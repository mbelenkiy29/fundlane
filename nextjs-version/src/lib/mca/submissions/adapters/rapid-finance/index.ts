import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  peekFixture,
  rapidFinanceFixtureDestination,
  rapidFinancePortalUrl,
  rawStatusForScenario,
  resolveFixtureScenario,
  termsForScenario,
} from "./fixtures"
import {
  RAPID_FINANCE_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
  validateJobDocuments,
} from "./mapping"

export {
  bindRapidFinanceApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peekFixture,
  RAPID_FINANCE_FIXTURE_TRANSPORT,
  rapidFinanceDealId,
  rapidFinanceFixtureDestination,
  rapidFinancePortalUrl,
  rawStatusForScenario,
  resetRapidFinanceFixtures,
  resolveFixtureScenario,
  setRapidFinanceFixture,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  FALLBACK_STATUS_TOKENS,
  mapApplication,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  PROVIDER_STATUS_MAP,
  RAPID_FINANCE_SLUG,
  resolveAnnualRevenue,
  statusToken,
  validateApplication,
  validateJobDocuments,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return rapidFinanceFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.password === EXPIRED_CREDENTIAL_TOKEN
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
  const correlationId = correlationIdFor(job, `rf-${job.id}`)
  if (!executed.ok || !executed.record) {
    return finalizeSubmit({
      ok: false,
      correlationId,
      externalRef: executed.record?.externalRef,
      errorCode: executed.errorCode,
      errorMessage: executed.errorMessage,
    })
  }
  const portalUrl = rapidFinancePortalUrl(executed.record.externalRef)
  return finalizeSubmit({
    ok: true,
    correlationId,
    externalRef: executed.record.externalRef,
    rawStatus: executed.record.rawStatus,
    fields: {
      dealId: executed.record.externalRef,
      portalUrl,
      ...documentFields(executed.record.documentReceipts),
    },
  })
}

export const rapidFinanceAdapter: FunderAdapter = {
  slug: RAPID_FINANCE_SLUG,
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
          correlationId: correlationIdFor(job, `rf-${job.id}`),
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
          annualRevenue: mapped.business.annualRevenue,
          entityType: mapped.business.entityType,
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
            ownershipPercent: owner.ownershipPercent,
          })),
          documentCategories: mapped.documents.map((document) => document.category),
        },
      }))
    }
    const scenario = resolveFixtureScenario(destinationFor(job))
    if (scenario !== "timeout" && scenario !== "expired-credential" && !isExpired(job) && job.documentVersions.length) {
      const documentErrors = validateJobDocuments(job.documentVersions)
      if (Object.keys(documentErrors).length) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `rf-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: documentErrors,
        })
      }
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
    const mapped = mapProviderStatus(record?.rawStatus ?? rawStatusForScenario(scenario))
    const terms = mapped.normalized === "approved" || mapped.normalized === "funded"
      ? record?.terms ?? termsForScenario(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `rf-status-${job.id}`),
      eventId: record ? `rf-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default rapidFinanceAdapter
