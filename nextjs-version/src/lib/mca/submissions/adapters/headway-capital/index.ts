import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  headwayCapitalFixtureDestination,
  outstandingDocumentsFor,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  scenarioTerms,
} from "./fixtures"
import {
  HEADWAY_CAPITAL_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindHeadwayCapitalApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  headwayCapitalFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetHeadwayCapitalFixtures,
  resolveFixtureScenario,
  scenarioTerms,
  setHeadwayCapitalFixture,
  SYNTHETIC_OFFER_TERMS,
} from "./fixtures"
export {
  HEADWAY_CAPITAL_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  PROVIDER_STATUS_MAP,
  requiredDocumentErrors,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return headwayCapitalFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.password === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
}

function resultFields(
  accountId: string | undefined,
  receipts: Array<{ documentId: string; category: string; receiptId: string }>,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {}
  if (accountId) fields.accountId = accountId
  receipts.forEach((receipt, index) => {
    fields[`documents.${index}.documentId`] = receipt.documentId
    fields[`documents.${index}.category`] = receipt.category
    fields[`documents.${index}.receiptId`] = receipt.receiptId
  })
  return Object.keys(fields).length ? fields : undefined
}

function finalizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function submitResult(job: SubmissionJob, executed: ReturnType<typeof executeSubmit>): AdapterSubmitResult {
  const correlationId = correlationIdFor(job, `hwc-${job.id}`)
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
    rawStatus: executed.record.rawStatus,
    fields: resultFields(executed.record.externalRef, executed.record.documentReceipts),
  })
}

export const headwayCapitalAdapter: FunderAdapter = {
  slug: HEADWAY_CAPITAL_SLUG,
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
          correlationId: correlationIdFor(job, `hwc-${job.id}`),
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
          email: mapped.business.email,
          entityType: mapped.business.entityType,
          annualRevenue: mapped.financial.annualRevenue,
          requestedAmount: mapped.financial.requestedAmount,
          loanPurpose: mapped.financial.loanPurpose,
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
          })),
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
    const destination = destinationFor(job)
    const record = peekFixture(job.attemptKey)
    const scenario = resolveFixtureScenario(destination)
    const outstanding = record?.outstandingDocuments ?? outstandingDocumentsFor(destination)
    const mapped = mapProviderStatus(record?.rawStatus ?? rawStatusForScenario(scenario), outstanding)
    const terms = mapped.normalized === "approved" || mapped.normalized === "funded"
      ? scenarioTerms(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `hwc-status-${job.id}`),
      eventId: record ? `hwc-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default headwayCapitalAdapter
