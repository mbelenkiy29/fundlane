import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  foraFinancialFixtureDestination,
  getBoundApplication,
  peekFixture,
  resolveFixtureScenario,
  statusRawForScenario,
  submitRawForScenario,
} from "./fixtures"
import {
  FORA_FINANCIAL_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  applicationIdForAttempt,
  bindForaFinancialApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  foraFinancialFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetForaFinancialFixtures,
  resolveFixtureScenario,
  setForaFinancialFixture,
  statusRawForScenario,
  submitRawForScenario,
} from "./fixtures"
export {
  FORA_ENTITY_TYPES,
  FORA_FINANCIAL_SLUG,
  FORA_INDUSTRIES,
  mapApplication,
  mapDocumentCategory,
  mapEntityType,
  mapIndustry,
  mapJobDocuments,
  mapProviderStatus,
  PROVIDER_STATUS_MAP,
  readConsentFlag,
  selectPrimaryOwner,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return foraFinancialFixtureDestination() ?? job.route.destination
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
    dba: mapped.business.dba,
    entityType: mapped.business.entityType,
    industry: mapped.business.industry,
    ownerFirstName: mapped.owner.firstName,
    ownerLastName: mapped.owner.lastName,
    ownershipPercent: mapped.owner.ownershipPercent,
    requestedAmount: mapped.financial.requestedAmount,
    annualRevenue: mapped.financial.annualRevenue,
    monthlyRevenue: mapped.financial.monthlyRevenue,
    revenueSource: mapped.financial.revenueSource,
    businessCreditPullConsent: mapped.business.creditPullConsent,
    ownerCreditPullConsent: mapped.owner.creditPullConsent,
  }
}

function finalizeSubmit(result: AdapterSubmitResult): AdapterSubmitResult {
  return redactAdapterSecrets(result, adapterRuntime()?.secrets ?? {})
}

function submitResult(job: SubmissionJob, executed: ReturnType<typeof executeSubmit>): AdapterSubmitResult {
  const correlationId = correlationIdFor(job, `fora-${job.id}`)
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

export const foraFinancialAdapter: FunderAdapter = {
  slug: FORA_FINANCIAL_SLUG,
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
          correlationId: correlationIdFor(job, `fora-${job.id}`),
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
      : record
        ? submitRawForScenario(scenario)
        : statusRawForScenario(scenario)
    const mapped = mapProviderStatus(rawStatus)
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `fora-status-${job.id}`),
      eventId: record ? `fora-event-${job.attemptKey}` : undefined,
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default foraFinancialAdapter
