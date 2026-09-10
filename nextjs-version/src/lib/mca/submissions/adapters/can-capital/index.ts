import "server-only"

import { AppError } from "../../../errors"
import { adapterRuntime, redactAdapterSecrets } from "../credentials"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  EXPIRED_CREDENTIAL_TOKEN,
  executeSubmit,
  canCapitalFixtureDestination,
  getBoundApplication,
  peekFixture,
  resolveFixtureScenario,
  statusRawForScenario,
} from "./fixtures"
import {
  CAN_CAPITAL_SLUG,
  mapApplication,
  mapCredentialComponents,
  mapJobDocuments,
  mapProviderStatus,
  ownerAgeYears,
  validateApplication,
} from "./mapping"

export {
  applicationNameForAttempt,
  bindCanCapitalApplication,
  canCapitalFixtureDestination,
  EXPIRED_CREDENTIAL_TOKEN,
  fixtureSubmitCallCount,
  listFixtureExternalRefs,
  peekFixture,
  resetCanCapitalFixtures,
  resolveFixtureScenario,
  setCanCapitalFixture,
  statusRawForScenario,
} from "./fixtures"
export {
  CAN_CAPITAL_SLUG,
  CREDENTIAL_COMPONENT_FIELDS,
  FORMATION_REQUIRED_ENTITY_TYPES,
  mapApplication,
  mapCredentialComponents,
  mapEntityType,
  mapJobDocuments,
  mapProviderStatus,
  MINIMUM_OWNER_AGE,
  ownerAgeYears,
  PROVIDER_STATUS_MAP,
  requiresStateOfFormation,
  selectPrimaryOwner,
  validateApplication,
} from "./mapping"

function destinationFor(job: SubmissionJob): string {
  return canCapitalFixtureDestination() ?? job.route.destination
}

function correlationIdFor(job: SubmissionJob, fallback: string): string {
  return adapterRuntime()?.correlationId || fallback
}

function isExpired(job: SubmissionJob): boolean {
  const runtime = adapterRuntime()
  const scenario = resolveFixtureScenario(destinationFor(job))
  const secrets = runtime?.secrets
  const components = secrets ? Object.values(mapCredentialComponents(secrets)) : []
  return scenario === "expired-credential"
    || secrets?.apiKey === EXPIRED_CREDENTIAL_TOKEN
    || secrets?.clientId === EXPIRED_CREDENTIAL_TOKEN
    || secrets?.clientSecret === EXPIRED_CREDENTIAL_TOKEN
    || secrets?.username === EXPIRED_CREDENTIAL_TOKEN
    || secrets?.password === EXPIRED_CREDENTIAL_TOKEN
    || components.includes(EXPIRED_CREDENTIAL_TOKEN)
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
  const correlationId = correlationIdFor(job, `can-${job.id}`)
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
      applicationName: executed.record.externalRef,
      ...(documentFields(executed.record.documentReceipts) ?? {}),
    },
  })
}

export const canCapitalAdapter: FunderAdapter = {
  slug: CAN_CAPITAL_SLUG,
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
          correlationId: correlationIdFor(job, `can-${job.id}`),
          errorCode: "validation_failed",
          errorMessage: "Review the highlighted fields.",
          fields: validated.fields,
        })
      }
      const mapped = mapApplication(validated.value, documents)
      const age = ownerAgeYears(mapped.owner.dateOfBirth)
      return submitResult(job, executeSubmit({
        attemptKey: job.attemptKey,
        destination: destinationFor(job),
        expired: isExpired(job),
        documents,
        mapped: {
          entityType: mapped.business.entityType,
          stateOfFormation: mapped.business.stateOfFormation,
          ownerFirstName: mapped.owner.firstName,
          ownerLastName: mapped.owner.lastName,
          ownershipPercent: mapped.owner.ownershipPercent,
          ownerAge: age,
          requestedAmount: mapped.business.requestedAmount,
          salesRepEmail: mapped.salesRepEmail,
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
      ?? (scenario === "outstanding-documents" ? ["application", "bank statements"] : [])
    const rawStatus = record?.rawStatus ?? statusRawForScenario(scenario)
    const mapped = mapProviderStatus(rawStatus, outstanding)
    return redactAdapterSecrets({
      ...mapped,
      correlationId: correlationIdFor(job, `can-status-${job.id}`),
      eventId: record ? `can-event-${job.attemptKey}` : undefined,
    }, adapterRuntime()?.secrets ?? {})
  },
}

export default canCapitalAdapter
