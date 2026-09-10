import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  peekFixture,
  plexeFixtureDestination,
  resolveFixtureScenario,
  statusRawForScenario,
} from "./fixtures"
import {
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  PLEXE_SLUG,
  validateApplication,
} from "./mapping"

export {
  applicationIdForAttempt,
  bindPlexeApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peekFixture,
  plexeFixtureDestination,
  resetPlexeFixtures,
  resolveFixtureScenario,
  setPlexeFixture,
  statusRawForScenario,
} from "./fixtures"
export {
  DEFAULT_FUNDING_PURPOSE,
  inferFundingTerms,
  mapApplication,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  PLEXE_SLUG,
  PROVIDER_STATUS_MAP,
  REQUESTED_AMOUNT_MULTIPLIER,
  resolveMonthlyRevenue,
  selectHighestOwner,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return plexeFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  const apiKey = runtime?.secrets.apiKey
  const username = runtime?.secrets.username
  const password = runtime?.secrets.password
  return scenario === "expired-credential"
    || apiKey === EXPIRED_CREDENTIAL_TOKEN
    || username === EXPIRED_CREDENTIAL_TOKEN
    || password === EXPIRED_CREDENTIAL_TOKEN
}

function documentFields(receipts: Array<{ documentId: string; category: string; receiptId: string }>): Record<string, string> | undefined {
  if (!receipts.length) return undefined
  const fields: Record<string, string> = {
    documentReceipt: "accepted",
    documentsReceived: String(receipts.length),
  }
  receipts.forEach((receipt, index) => {
    fields[`documents.${index}.documentId`] = receipt.documentId
    fields[`documents.${index}.category`] = receipt.category
    fields[`documents.${index}.receiptId`] = receipt.receiptId
  })
  return fields
}

function mappedSnapshot(mapped: ReturnType<typeof mapApplication>) {
  return {
    legalName: mapped.business.legalName,
    ownerFirstName: mapped.owner.firstName,
    ownerLastName: mapped.owner.lastName,
    ownershipPercent: mapped.owner.ownershipPercent,
    monthlyRevenue: mapped.funding.monthlyRevenue,
    requestedAmount: mapped.funding.requestedAmount,
    requestedAmountInferred: mapped.funding.requestedAmountInferred,
    fundingPurpose: mapped.funding.fundingPurpose,
    fundingPurposeInferred: mapped.funding.fundingPurposeInferred,
    revenueSource: mapped.funding.revenueSource,
    statementDocumentIds: mapped.documents.map((document) => document.documentId),
  }
}

function finalizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function submitResult(job: SubmissionJob, executed: ReturnType<typeof executeSubmit>): AdapterSubmitResult {
  const correlationId = correlationIdFor(job, `plexe-${job.id}`)
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
    fields: {
      applicationId: executed.record.externalRef,
      ...(documentFields(executed.record.documentReceipts) ?? {}),
    },
  })
}

export const plexeAdapter: FunderAdapter = {
  slug: PLEXE_SLUG,
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
          correlationId: correlationIdFor(job, `plexe-${job.id}`),
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
    const rawStatus = record?.completed
      ? statusRawForScenario(scenario === "timeout" || scenario === "expired-credential" ? "accepted" : scenario)
      : statusRawForScenario(scenario)
    const mapped = mapProviderStatus(rawStatus)
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `plexe-status-${job.id}`),
      eventId: record ? `plexe-event-${job.attemptKey}` : undefined,
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default plexeAdapter
