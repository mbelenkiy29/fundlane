import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EVEREST_BUSINESS_FUNDING_SLUG,
  mapApplication,
  mapCredentialComponents,
  mapJobDocuments,
  mapProviderStatus,
  requiredDocumentErrors,
  validateApplication,
  type EverestMappedDocument,
} from "./mapping"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  everestBusinessFundingFixtureDestination,
  executeSubmit,
  getBoundApplication,
  peekFixture,
  rawStatusForScenario,
  resolveFixtureScenario,
  termsForScenario,
} from "./fixtures"

export {
  bindEverestBusinessFundingApplication,
  everestBusinessFundingDealId,
  everestBusinessFundingFixtureDestination,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peekFixture,
  rawStatusForScenario,
  resetEverestBusinessFundingFixtures,
  resolveFixtureScenario,
  setEverestBusinessFundingFixture,
  SYNTHETIC_OFFER_TERMS,
  termsForScenario,
} from "./fixtures"
export {
  CREDENTIAL_COMPONENT_FIELDS,
  EVEREST_BUSINESS_FUNDING_SLUG,
  mapApplication,
  mapCredentialComponents,
  mapDocumentCategory,
  mapJobDocuments,
  mapProviderStatus,
  PROVIDER_STATUS_MAP,
  requiredDocumentErrors,
  statusToken,
  validateApplication,
  validateJobDocuments,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return everestBusinessFundingFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  return scenario === "expired-credential"
    || runtime?.secrets.clientSecret === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.clientId === EXPIRED_CREDENTIAL_TOKEN
    || runtime?.secrets.apiKey === EXPIRED_CREDENTIAL_TOKEN
}

function hasRequiredFiles(documents: EverestMappedDocument[]): boolean {
  return documents.some((document) => document.category === "application")
    && documents.some((document) => document.category === "bank_statements")
}

function documentsForSubmit(job: SubmissionJob, boundDocuments: EverestMappedDocument[] = []): EverestMappedDocument[] {
  const jobDocuments = mapJobDocuments(job)
  if (hasRequiredFiles(jobDocuments)) return jobDocuments
  if (hasRequiredFiles(boundDocuments)) return boundDocuments
  return jobDocuments.length ? jobDocuments : boundDocuments
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
  const correlationId = correlationIdFor(job, `ebf-${job.id}`)
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
      dealId: executed.record.externalRef,
      ...documentFields(executed.record.documentReceipts),
    },
  })
}

export const everestBusinessFundingAdapter: FunderAdapter = {
  slug: EVEREST_BUSINESS_FUNDING_SLUG,
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
    const destination = destinationFor(job)
    const expired = isExpired(job)
    const scenario = resolveFixtureScenario(destination)
    const existing = peekFixture(job.attemptKey)
    const skipDocumentValidation = Boolean(existing?.completed) || expired || scenario === "timeout"

    if (bound !== undefined) {
      const validated = validateApplication(bound, { requireDocuments: false })
      if (!validated.ok) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `ebf-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: validated.fields,
        })
      }
      const documents = documentsForSubmit(job, validated.value.documents)
      if (!skipDocumentValidation) {
        const docFields = requiredDocumentErrors(documents)
        if (Object.keys(docFields).length) {
          return finalizeSubmit({
            ok: false,
            correlationId: correlationIdFor(job, `ebf-${job.id}`),
            errorCode: "validation_failed",
            errorMessage: "Review the highlighted fields.",
            fields: docFields,
          })
        }
      }
      const secrets = adapterRuntime()?.secrets ?? {}
      const mapped = mapApplication(validated.value, documents, secrets)
      const credentials = mapCredentialComponents(secrets)
      return submitResult(job, executeSubmit({
        attemptKey: job.attemptKey,
        destination,
        expired,
        documents,
        mapped: {
          legalName: mapped.business.legalName,
          ein: mapped.business.ein,
          credentialFields: [
            ...(credentials.clientId ? ["clientId"] : []),
            ...(credentials.clientSecret ? ["clientSecret"] : []),
          ],
          applicationDocumentId: mapped.documents.find((document) => document.category === "application")?.documentId,
          statementDocumentIds: mapped.documents
            .filter((document) => document.category === "bank_statements")
            .map((document) => document.documentId),
        },
      }))
    }

    const documents = documentsForSubmit(job)
    if (!skipDocumentValidation) {
      const docFields = requiredDocumentErrors(documents)
      if (Object.keys(docFields).length) {
        return finalizeSubmit({
          ok: false,
          correlationId: correlationIdFor(job, `ebf-${job.id}`),
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
      correlationId: correlationIdFor(job, `ebf-status-${job.id}`),
      eventId: record ? `ebf-event-${job.attemptKey}` : undefined,
      ...(terms ? { terms } : {}),
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default everestBusinessFundingAdapter
