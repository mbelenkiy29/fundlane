import "server-only"

import {
  DEFAULT_OUTSTANDING_DOCUMENTS,
  documentsCoverOutstanding,
  FORWARD_FINANCING_SLUG,
} from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-ff-development-token"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "missing-info",
  "declined",
  "approved",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  entityType?: string
  industry?: string
  owners?: Array<{ firstName: string; lastName: string; ownershipPercent: number; ssnLast4: string }>
  documentsComplete?: boolean
}

export interface FixtureDocumentReceipt {
  documentId: string
  category: string
  receiptId: string
}

export interface FixtureRecord {
  attemptKey: string
  externalRef: string
  rawStatus: string
  outstandingDocuments: string[]
  documentReceipts: FixtureDocumentReceipt[]
  completed: boolean
  timedOut: boolean
  submitCalls: number
  mapped?: FixtureMappedSnapshot
}

export interface FixtureSubmitInput {
  attemptKey: string
  destination: string
  expired?: boolean
  documents?: Array<{ documentId: string; category: string; checksum: string }>
  mapped?: FixtureMappedSnapshot
}

export interface FixtureSubmitResult {
  ok: boolean
  record?: FixtureRecord
  errorCode?: string
  errorMessage?: string
}

const records = new Map<string, FixtureRecord>()
const applications = new Map<string, unknown>()
let destinationOverride: string | undefined
let submitCallCount = 0

export function setForwardFinancingFixture(destination?: string): void {
  destinationOverride = destination
}

export function forwardFinancingFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindForwardFinancingApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetForwardFinancingFixtures(): void {
  records.clear()
  applications.clear()
  destinationOverride = undefined
  submitCallCount = 0
}

export function peekFixture(attemptKey: string): FixtureRecord | undefined {
  return records.get(attemptKey)
}

export function fixtureSubmitCallCount(): number {
  return submitCallCount
}

export function listFixtureExternalRefs(): string[] {
  return [...new Set([...records.values()].map((record) => record.externalRef).filter(Boolean))]
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${FORWARD_FINANCING_SLUG}:`)
    ? normalized.slice(FORWARD_FINANCING_SLUG.length + 1)
    : normalized === FORWARD_FINANCING_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents") return "missing-info"
  if (suffix === "timeout" || suffix === "declined" || suffix === "accepted" || suffix === "approved") return suffix
  return "accepted"
}

function initialRawStatus(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "approved") return "Approved"
  if (scenario === "missing-info") return "Missing Info"
  return "Submitted"
}

function receiptsFor(
  attemptKey: string,
  documents: Array<{ documentId: string; category: string }>,
  existing: FixtureDocumentReceipt[],
): FixtureDocumentReceipt[] {
  const receipts = [...existing]
  for (const document of documents) {
    if (receipts.some((receipt) => receipt.documentId === document.documentId)) continue
    receipts.push({
      documentId: document.documentId,
      category: document.category,
      receiptId: `ff_doc_${attemptKey}_${document.documentId}`,
    })
  }
  return receipts
}

export function executeSubmit(input: FixtureSubmitInput): FixtureSubmitResult {
  submitCallCount += 1
  const scenario = resolveFixtureScenario(input.destination)
  const existing = records.get(input.attemptKey)

  if ((input.expired || scenario === "expired-credential") && !existing?.completed) {
    return {
      ok: false,
      record: existing,
      errorCode: "provider_unavailable",
      errorMessage: "The funder API credentials have expired.",
    }
  }

  const record = existing ?? {
    attemptKey: input.attemptKey,
    externalRef: `ff_${input.attemptKey}`,
    rawStatus: initialRawStatus(scenario),
    outstandingDocuments: scenario === "missing-info" ? [...DEFAULT_OUTSTANDING_DOCUMENTS] : [],
    documentReceipts: [],
    completed: false,
    timedOut: false,
    submitCalls: 0,
    mapped: input.mapped,
  }
  if (!existing) records.set(input.attemptKey, record)
  record.submitCalls += 1
  if (input.mapped) record.mapped = input.mapped
  if (input.expired && record.completed) {
    return { ok: true, record }
  }
  if (scenario === "timeout" && !record.timedOut && !record.completed) {
    record.timedOut = true
    return {
      ok: false,
      record,
      errorCode: "provider_unavailable",
      errorMessage: "The funder API timed out.",
    }
  }

  record.completed = true
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  const documentSource = (input.documents?.length ? input.documents : record.documentReceipts)
  const documentsComplete = documentsCoverOutstanding(record.outstandingDocuments, documentSource)
  if (record.outstandingDocuments.length && documentsComplete) {
    record.outstandingDocuments = []
    record.rawStatus = "Submitted"
  } else if (!record.outstandingDocuments.length) {
    record.rawStatus = initialRawStatus(scenario)
  }
  if (record.mapped) record.mapped.documentsComplete = record.outstandingDocuments.length === 0
  if (scenario === "declined") {
    record.outstandingDocuments = []
    record.rawStatus = "Declined"
  }
  return { ok: true, record }
}
