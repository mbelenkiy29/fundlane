import "server-only"

import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterCapabilities, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  fundomateFixtureDestination,
  getBoundApplication,
  peekFixture,
  resolveFixtureScenario,
} from "./fixtures"
import {
  FUNDOMATE_SLUG,
  mapApplication,
  mapJobDocuments,
  validateApplication,
  validateJobDocuments,
} from "./mapping"

export {
  bindFundomateApplication,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  fundomateFixtureDestination,
  listFixtureExternalRefs,
  peekFixture,
  resetFundomateFixtures,
  resolveFixtureScenario,
  setFundomateFixture,
} from "./fixtures"
export {
  FUNDOMATE_INDUSTRIES,
  FUNDOMATE_OWNERSHIP_TYPES,
  FUNDOMATE_RECEIVED_STATUS,
  FUNDOMATE_SLUG,
  isTexasState,
  mapApplication,
  mapDocumentCategory,
  mapIndustry,
  mapJobDocuments,
  mapOwnershipType,
  normalizeEin,
  parseStartMonthYear,
  validateApplication,
  validateJobDocuments,
} from "./mapping"

export const FUNDOMATE_CAPABILITIES = {
  submit: true,
  statusPoll: false,
  webhooks: false,
  offers: false,
} as const satisfies AdapterCapabilities

function destinationFor(job: SubmissionJob): string {
  return fundomateFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.clientSecret === EXPIRED_CREDENTIAL_TOKEN
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
  const correlationId = correlationIdFor(job, `fm-${job.id}`)
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

export const fundomateAdapter: FunderAdapter = {
  slug: FUNDOMATE_SLUG,
  capabilities: FUNDOMATE_CAPABILITIES,
  validate(input) {
    const result = validateApplication(input, { requireDocuments: true })
    return result.ok ? { ok: true } : { ok: false, fields: result.fields }
  },
  async submit(job) {
    const bound = getBoundApplication(job.attemptKey)
    const documents = mapJobDocuments(job)
    const destination = destinationFor(job)
    const expired = isExpired(job)
    const scenario = resolveFixtureScenario(destination)
    const existing = peekFixture(job.attemptKey)

    if (bound !== undefined) {
      const validated = validateApplication(bound, { requireDocuments: false })
      if (!validated.ok) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `fm-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: validated.fields,
        })
      }
      if (!existing?.completed && !expired && scenario !== "timeout") {
        const docFields = validateJobDocuments(job)
        if (Object.keys(docFields).length) {
          return finalizeSubmit({
            ok: false,
            correlationId: correlationIdFor(job, `fm-${job.id}`),
            errorCode: "validation_failed",
            errorMessage: "Review the highlighted fields.",
            fields: docFields,
          })
        }
      }
      const mapped = mapApplication(validated.value, documents)
      return submitResult(job, executeSubmit({
        attemptKey: job.attemptKey,
        destination,
        expired,
        documents,
        mapped: {
          ein: mapped.business.ein,
          ownershipType: mapped.business.ownershipType,
          industry: mapped.business.industry,
          startMonthYear: mapped.business.startMonthYear,
          state: mapped.business.state,
          requestedAmount: mapped.business.requestedAmount,
          ownerCount: mapped.owners.length,
        },
      }))
    }

    if (!existing?.completed && !expired && scenario !== "timeout") {
      const docFields = validateJobDocuments(job)
      if (Object.keys(docFields).length) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `fm-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: docFields,
        })
      }
    }

    return submitResult(job, executeSubmit({
      attemptKey: job.attemptKey,
      destination,
      expired,
      documents,
    }))
  },
}

export default fundomateAdapter
