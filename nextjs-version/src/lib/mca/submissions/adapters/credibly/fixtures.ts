import "server-only"

import { CREDIBLY_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-credibly-development-token"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "prequalified",
  "offers-ready",
  "outstanding-documents",
  "declined",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  apiVersion?: string
  entityType?: string
  industry?: string
  owners?: Array<{ firstName: string; lastName: string; ownershipPercent: number }>
  positions?: Array<{ label: string; estimatedPayment: number }>
  documentCategories?: string[]
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

export function setCrediblyFixture(destination?: string): void {
  destinationOverride = destination
}

export function crediblyFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindCrediblyApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetCrediblyFixtures(): void {
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

export function crediblyLoanId(attemptKey: string): string {
  return `crd_${attemptKey}`
}

export function crediblyPortalUrl(externalRef: string): string {
  return `https://portal.example.test/credibly/${externalRef}`
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${CREDIBLY_SLUG}:`)
    ? normalized.slice(CREDIBLY_SLUG.length + 1)
    : normalized === CREDIBLY_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential" || suffix === "expired_credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents" || suffix === "outstanding_documents") {
    return "outstanding-documents"
  }
  if (suffix === "pre-qualified" || suffix === "prequalified" || suffix === "pq") return "prequalified"
  if (suffix === "offers-ready" || suffix === "offers_ready" || suffix === "offer-ready") return "offers-ready"
  if (suffix === "timeout" || suffix === "declined" || suffix === "accepted") return suffix
  return "accepted"
}

export function outstandingDocumentsFor(destination: string): string[] {
  const scenario = resolveFixtureScenario(destination)
  return scenario === "outstanding-documents" ? ["bank statements", "voided check"] : []
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "prequalified") return "Prequalified"
  if (scenario === "offers-ready") return "Offers Ready"
  if (scenario === "outstanding-documents") return "In Review"
  return "Submitted"
}

function receiptsFor(
  attemptKey: string,
  documents: Array<{ documentId: string; category: string }>,
  existing: FixtureDocumentReceipt[],
): FixtureDocumentReceipt[] {
  if (existing.length) return existing
  return documents.map((document) => ({
    documentId: document.documentId,
    category: document.category,
    receiptId: `crd_doc_${attemptKey}_${document.documentId}`,
  }))
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
    externalRef: crediblyLoanId(input.attemptKey),
    rawStatus: rawStatusForScenario(scenario),
    outstandingDocuments: outstandingDocumentsFor(input.destination),
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
  record.rawStatus = rawStatusForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  if (scenario === "declined") record.outstandingDocuments = []
  return { ok: true, record }
}
