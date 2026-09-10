import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  peacSolutionsFixtureDestination,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  stipsForScenario,
  termsForScenario,
} from "./fixtures"
import {
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  PEAC_SOLUTIONS_SLUG,
  validateApplication,
} from "./mapping"

export {
  bindPeacSolutionsApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peacSolutionsApplicationId,
  peacSolutionsFixtureDestination,
  PEAC_SOLUTIONS_FIXTURE_TRANSPORT,
  peekFixture,
  rawStatusForScenario,
  resetPeacSolutionsFixtures,
  resolveFixtureScenario,
  setPeacSolutionsFixture,
  stipsForScenario,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  mapApplication,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  MAX_OWNERS,
  MAX_REQUESTED_AMOUNT,
  MIN_REPRESENTED_OWNERSHIP,
  parseStatementDeposits,
  PEAC_SOLUTIONS_SLUG,
  PROVIDER_STATUS_MAP,
  representedOwnership,
  resolveAnnualRevenue,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return peacSolutionsFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.username === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.password === EXPIRED_CREDENTIAL_TOKEN
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

function mappedSnapshot(mapped: ReturnType<typeof mapApplication>) {
  return {
    entityType: mapped.business.entityType,
    businessEmail: mapped.business.email,
    fundingPurpose: mapped.financial.fundingPurpose,
    requestedAmount: mapped.financial.requestedAmount,
    annualRevenue: mapped.financial.annualRevenue,
    revenueSource: mapped.financial.revenueSource,
    representedOwnership: mapped.financial.representedOwnership,
    owners: mapped.owners.map((owner) => ({
      firstName: owner.firstName,
      lastName: owner.lastName,
      ownershipPercent: owner.ownershipPercent,
    })),
  }
}

function finalizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function submitResult(job: SubmissionJob, executed: ReturnType<typeof executeSubmit>): AdapterSubmitResult {
  const correlationId = correlationIdFor(job, `peac-${job.id}`)
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
    fields: documentFields(executed.record.documentReceipts),
  })
}

export const peacSolutionsAdapter: FunderAdapter = {
  slug: PEAC_SOLUTIONS_SLUG,
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
          correlationId: correlationIdFor(job, `peac-${job.id}`),
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
        mapped: mappedSnapshot(mapped),
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
    const outstanding = record?.outstandingDocuments ?? stipsForScenario(scenario)
    const mapped = mapProviderStatus(record?.rawStatus ?? rawStatusForScenario(scenario), outstanding)
    const terms = mapped.normalized === "approved" || mapped.normalized === "funded"
      ? record?.terms ?? termsForScenario(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `peac-status-${job.id}`),
      eventId: record ? `peac-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default peacSolutionsAdapter
