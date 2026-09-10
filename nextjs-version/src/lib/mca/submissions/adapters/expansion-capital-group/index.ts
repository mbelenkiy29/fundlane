import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  expansionCapitalGroupFixtureDestination,
  getBoundApplication,
  isRegisteredPartner,
  peekFixture,
  resolveFixtureScenario,
} from "./fixtures"
import {
  EXPANSION_CAPITAL_GROUP_SLUG,
  mapApplication,
  mapJobDocuments,
  mapProviderStatus,
  validateApplication,
} from "./mapping"

export {
  bindExpansionCapitalGroupApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  expansionCapitalGroupFixtureDestination,
  fixtureSubmitCallCount,
  isRegisteredPartner,
  listFixtureExternalRefs,
  peekFixture,
  REGISTERED_PARTNERS,
  resetExpansionCapitalGroupFixtures,
  resolveFixtureScenario,
  setExpansionCapitalGroupFixture,
} from "./fixtures"
export {
  EXPANSION_CAPITAL_GROUP_SLUG,
  mapApplication,
  mapEntityType,
  mapJobDocuments,
  mapProviderStatus,
  MAX_OWNERS,
  PROVIDER_STATUS_MAP,
  selectOwners,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return expansionCapitalGroupFixtureDestination() ?? job.route.destination
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
  const correlationId = correlationIdFor(job, `ecg-${job.id}`)
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

export const expansionCapitalGroupAdapter: FunderAdapter = {
  slug: EXPANSION_CAPITAL_GROUP_SLUG,
  capabilities: {
    submit: true,
    statusPoll: true,
    webhooks: false,
    offers: false,
  },
  validate(input) {
    const result = validateApplication(input, { isRegisteredPartner })
    return result.ok ? { ok: true } : { ok: false, fields: result.fields }
  },
  async submit(job) {
    const bound = getBoundApplication(job.attemptKey)
    const documents = mapJobDocuments(job)
    if (bound !== undefined) {
      const validated = validateApplication(bound, { isRegisteredPartner })
      if (!validated.ok) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `ecg-${job.id}`),
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
          owners: mapped.owners.map((owner) => ({
            firstName: owner.firstName,
            lastName: owner.lastName,
            ownershipPercent: owner.ownershipPercent,
          })),
          partnerEmail: mapped.partner.email,
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
      ?? (scenario === "outstanding-documents" ? ["bank statements", "voided check"] : [])
    const mapped = mapProviderStatus(record?.rawStatus ?? (scenario === "outstanding-documents" ? "UW Prep" : "unknown"), outstanding)
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `ecg-status-${job.id}`),
      eventId: record ? `ecg-event-${job.attemptKey}` : undefined,
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default expansionCapitalGroupAdapter
