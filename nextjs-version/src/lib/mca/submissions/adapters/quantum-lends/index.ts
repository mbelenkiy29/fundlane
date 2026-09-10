import "server-only"

import { AppError } from "../../../errors"
import type { AdapterStatusResult, AdapterSubmitResult, FunderAdapter, SubmissionJob } from "../../contracts"
import {
  QUANTUM_LENDS_FIXTURES,
  QUANTUM_LENDS_SLUG,
  quantumLendsStatusFixture,
  resolveQuantumLendsFixtureKey,
  type QuantumLendsFixtureKey,
} from "./fixtures"
import { mapApplication } from "./mapping"

export {
  QUANTUM_LENDS_ENTITY_TYPE,
  choosePrimaryApplicant,
  mapApplication,
  mapNaics,
  resolveAnnualRevenue,
} from "./mapping"
export {
  QUANTUM_LENDS_FIXTURE_KEYS,
  QUANTUM_LENDS_RAW_STATUS,
  QUANTUM_LENDS_SLUG,
  resolveQuantumLendsFixtureKey,
} from "./fixtures"

export const QUANTUM_LENDS_CAPABILITIES = {
  submit: true,
  statusPoll: true,
  webhooks: false,
  offers: false,
} as const

let fixtureOverride: QuantumLendsFixtureKey | undefined
const acceptedByAttemptKey = new Map<string, AdapterSubmitResult>()

export function setQuantumLendsFixtureForTests(value?: QuantumLendsFixtureKey): void {
  fixtureOverride = value
}

export function resetQuantumLendsAdapterForTests(): void {
  fixtureOverride = undefined
  acceptedByAttemptKey.clear()
}

function fixtureFor(job: SubmissionJob): QuantumLendsFixtureKey {
  return resolveQuantumLendsFixtureKey(job.route.destination, fixtureOverride)
}

function correlationIdFor(job: SubmissionJob): string {
  return `ql-${job.attemptKey}`
}

function statementDocuments(job: SubmissionJob): Array<{ documentId: string; checksum: string }> {
  return job.documentVersions.filter((document) => document.category === "statement")
}

function documentReceiptFields(job: SubmissionJob): Record<string, string> {
  const statements = statementDocuments(job)
  const receivedIds = statements.length > 0 ? statements.map((document) => document.documentId) : job.packageDocumentIds
  if (receivedIds.length === 0) return { documentReceipt: "none", documentsReceived: "0" }
  return {
    documentReceipt: "accepted",
    documentsReceived: String(receivedIds.length),
    documentIds: receivedIds.join(","),
  }
}

function acceptedResult(job: SubmissionJob): AdapterSubmitResult {
  const prior = acceptedByAttemptKey.get(job.attemptKey)
  if (prior) return { ...prior, fields: prior.fields ? { ...prior.fields } : undefined }
  const result: AdapterSubmitResult = {
    ok: true,
    correlationId: correlationIdFor(job),
    externalRef: `ql-${job.attemptKey}`,
    rawStatus: QUANTUM_LENDS_FIXTURES.accepted.rawStatus,
    fields: documentReceiptFields(job),
  }
  acceptedByAttemptKey.set(job.attemptKey, result)
  return { ...result, fields: { ...result.fields } }
}

function failedResult(job: SubmissionJob, key: "timeout" | "expired"): AdapterSubmitResult {
  const fixture = QUANTUM_LENDS_FIXTURES[key]
  return {
    ok: false,
    correlationId: correlationIdFor(job),
    errorCode: fixture.errorCode,
    errorMessage: fixture.errorMessage,
  }
}

async function submitQuantumLends(job: SubmissionJob): Promise<AdapterSubmitResult> {
  const key = fixtureFor(job)
  if (key === "timeout" || key === "expired") {
    if (acceptedByAttemptKey.has(job.attemptKey)) return acceptedResult(job)
    return failedResult(job, key)
  }
  return acceptedResult(job)
}

async function getQuantumLendsStatus(job: SubmissionJob): Promise<AdapterStatusResult> {
  const key = fixtureFor(job)
  if (key === "timeout") {
    throw new AppError(503, "timeout", QUANTUM_LENDS_FIXTURES.timeout.errorMessage)
  }
  if (key === "expired") {
    throw new AppError(401, "expired_credentials", QUANTUM_LENDS_FIXTURES.expired.errorMessage)
  }
  const submitted = acceptedByAttemptKey.get(job.attemptKey)
  const status = quantumLendsStatusFixture(key === "accepted" && submitted ? "sent" : key)
  return {
    rawStatus: status.rawStatus,
    normalized: status.normalized,
    correlationId: submitted?.correlationId ?? correlationIdFor(job),
    eventId: `ql-${job.attemptKey}-${status.rawStatus.toLowerCase()}`,
    unknown: status.unknown,
  }
}

export const quantumLendsAdapter: FunderAdapter = {
  slug: QUANTUM_LENDS_SLUG,
  capabilities: QUANTUM_LENDS_CAPABILITIES,
  validate(input: unknown) {
    const mapped = mapApplication(input)
    return mapped.ok ? { ok: true } : { ok: false, fields: mapped.fields }
  },
  submit: submitQuantumLends,
  getStatus: getQuantumLendsStatus,
}

export default quantumLendsAdapter
