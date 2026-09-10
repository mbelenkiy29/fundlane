import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  bittyAdvanceFixtureDestination,
  bittyAdvancePortalUrl,
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  termsForScenario,
} from "./fixtures"
import {
  BITTY_ADVANCE_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindBittyAdvanceApplication,
  BITTY_ADVANCE_FIXTURE_TRANSPORT,
  bittyAdvanceDealId,
  bittyAdvanceFixtureDestination,
  bittyAdvancePortalUrl,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peekFixture,
  rawStatusForScenario,
  resetBittyAdvanceFixtures,
  resolveFixtureScenario,
  setBittyAdvanceFixture,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  BITTY_ADVANCE_SLUG,
  mapApplication,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  parseStatements,
  PROVIDER_STATUS_MAP,
  statusToken,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return bittyAdvanceFixtureDestination() ?? job.route.destination
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
  const correlationId = correlationIdFor(job, `bitty-${job.id}`)
  if (!executed.ok || !executed.record) {
    return finalizeSubmit({
      ok: false,
      correlationId,
      externalRef: executed.record?.externalRef,
      errorCode: executed.errorCode,
      errorMessage: executed.errorMessage,
    })
  }
  const portalUrl = bittyAdvancePortalUrl(executed.record.externalRef)
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

export const bittyAdvanceAdapter: FunderAdapter = {
  slug: BITTY_ADVANCE_SLUG,
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
          correlationId: correlationIdFor(job, `bitty-${job.id}`),
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
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
            ownershipPercent: owner.ownershipPercent,
          })),
          statements: mapped.statements,
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
    const mapped = mapProviderStatus(record?.rawStatus ?? rawStatusForScenario(scenario))
    const terms = mapped.normalized === "approved"
      ? record?.terms ?? termsForScenario(scenario)
      : undefined
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `bitty-status-${job.id}`),
      eventId: record ? `bitty-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default bittyAdvanceAdapter
