import "server-only"

import { CAN_CAPITAL_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-can-capital-development-token"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "outstanding-documents",
  "declined",
  "unknown",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  entityType?: string
  stateOfFormation?: string
  ownerFirstName?: string
  ownerLastName?: string
  ownershipPercent?: number
  ownerAge?: number
  requestedAmount?: number
  salesRepEmail?: string
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
  scenario: FixtureScenario
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

export function applicationNameForAttempt(attemptKey: string): string {
  return `can_${attemptKey}`
}

export function setCanCapitalFixture(destination?: string): void {
  destinationOverride = destination
}

export function canCapitalFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindCanCapitalApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetCanCapitalFixtures(): void {
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
  const suffix = normalized.startsWith(`${CAN_CAPITAL_SLUG}:`)
    ? normalized.slice(CAN_CAPITAL_SLUG.length + 1)
    : normalized === CAN_CAPITAL_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents") return "outstanding-documents"
  if (suffix === "timeout" || suffix === "declined" || suffix === "accepted" || suffix === "unknown") return suffix
  return "accepted"
}

export function statusRawForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "outstanding-documents") return "Missing Information"
  if (scenario === "unknown") return "CREDIT_COMMITTEE_HOLD"
  return "Application Received"
}

function initialOutstanding(scenario: FixtureScenario): string[] {
  return scenario === "outstanding-documents" ? ["application", "bank statements"] : []
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
    receiptId: `can_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: applicationNameForAttempt(input.attemptKey),
    rawStatus: statusRawForScenario(scenario),
    outstandingDocuments: initialOutstanding(scenario),
    documentReceipts: [],
    completed: false,
    timedOut: false,
    submitCalls: 0,
    scenario,
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
  record.rawStatus = statusRawForScenario(scenario === "timeout" || scenario === "expired-credential" ? "accepted" : scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  if (scenario === "declined") record.outstandingDocuments = []
  return { ok: true, record }
}
