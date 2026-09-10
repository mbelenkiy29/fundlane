import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  getBoundApplication,
  ondeckFixtureDestination,
  ondeckPortalUrl,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  termsForScenario,
} from "./fixtures"
import {
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  ONDECK_SLUG,
  validateApplication,
} from "./mapping"

export {
  bindOnDeckApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  ONDECK_FIXTURE_TRANSPORT,
  ondeckAppId,
  ondeckFixtureDestination,
  ondeckPortalUrl,
  peekFixture,
  rawStatusForScenario,
  resetOnDeckFixtures,
  resolveFixtureScenario,
  setOnDeckFixture,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  mapApplication,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  ONDECK_SLUG,
  parseStatements,
  PROVIDER_STATUS_MAP,
  statusToken,
  submittedAverageDailyBalance,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return ondeckFixtureDestination() ?? job.route.destination
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
  const correlationId = correlationIdFor(job, `ondeck-${job.id}`)
  if (!executed.ok || !executed.record) {
    return finalizeSubmit({
      ok: false,
      correlationId,
      externalRef: executed.record?.externalRef,
      errorCode: executed.errorCode,
      errorMessage: executed.errorMessage,
    })
  }
  const portalUrl = ondeckPortalUrl(executed.record.externalRef)
  return finalizeSubmit({
    ok: true,
    correlationId,
    externalRef: executed.record.externalRef,
    rawStatus: executed.record.rawStatus,
    fields: {
      appId: executed.record.externalRef,
      portalUrl,
      ...documentFields(executed.record.documentReceipts),
    },
  })
}

export const ondeckAdapter: FunderAdapter = {
  slug: ONDECK_SLUG,
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
          correlationId: correlationIdFor(job, `ondeck-${job.id}`),
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
            phone: owner.phone,
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
      correlationId: correlationIdFor(job, `ondeck-status-${job.id}`),
      eventId: record ? `ondeck-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default ondeckAdapter
