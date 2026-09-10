import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  ideaFinancialFixtureDestination,
  outstandingDocumentsFor,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  scenarioTerms,
  stipsForScenario,
} from "./fixtures"
import {
  IDEA_FINANCIAL_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindIdeaFinancialApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  ideaFinancialFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetIdeaFinancialFixtures,
  resolveFixtureScenario,
  scenarioTerms,
  setIdeaFinancialFixture,
  SYNTHETIC_OFFER_TERMS,
  SYNTHETIC_STIPS,
} from "./fixtures"
export {
  DEFAULT_FICO,
  DEFAULT_NAICS,
  DEFAULT_REQUESTED_AMOUNT,
  deriveRequestedAmount,
  IDEA_FINANCIAL_SLUG,
  mapApplication,
  mapJobDocuments,
  mapLegalStructure,
  mapProviderStatus,
  ORIGINATOR_PHONE_ERROR,
  PROVIDER_STATUS_MAP,
  REQUESTED_AMOUNT_MULTIPLIER,
  resolveMonthlyRevenue,
  resolveOriginatorPhone,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return ideaFinancialFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.password === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.clientSecret === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.username === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.clientId === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
}

function resultFields(
  applicationNumber: string | undefined,
  receipts: Array<{ documentId: string; category: string; receiptId: string }>,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {}
  if (applicationNumber) fields.applicationNumber = applicationNumber
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
  const correlationId = correlationIdFor(job, `idea-${job.id}`)
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

export const ideaFinancialAdapter: FunderAdapter = {
  slug: IDEA_FINANCIAL_SLUG,
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
          correlationId: correlationIdFor(job, `idea-${job.id}`),
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
          ein: mapped.business.ein,
          monthlyRevenue: mapped.financial.monthlyRevenue,
          annualRevenue: mapped.financial.annualRevenue,
          requestedAmount: mapped.financial.requestedAmount,
          requestedAmountInferred: mapped.financial.requestedAmountInferred,
          ficoScore: mapped.financial.ficoScore,
          naicsCode: mapped.business.naicsCode,
          originatorPhoneSource: mapped.originator.source,
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
            ownershipPercent: owner.ownershipPercent,
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
    const stips = record?.stips ?? stipsForScenario(scenario)
    const mapped = mapProviderStatus(record?.rawStatus ?? rawStatusForScenario(scenario), outstanding, stips)
    const terms = mapped.normalized === "approved" || mapped.normalized === "funded"
      ? scenarioTerms(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `idea-status-${job.id}`),
      eventId: record ? `idea-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default ideaFinancialAdapter
