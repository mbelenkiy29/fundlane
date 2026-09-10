import "server-only"

import { FORA_FINANCIAL_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-fora-development-token"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "incomplete",
  "approved",
  "contracts-in",
  "pending-funding",
  "funded",
  "declined",
  "unknown",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  legalName?: string
  dba?: string
  entityType?: string
  industry?: string
  ownerFirstName?: string
  ownerLastName?: string
  ownershipPercent?: number
  requestedAmount?: number
  annualRevenue?: number
  monthlyRevenue?: number
  revenueSource?: "annual_revenue" | "monthly_revenue" | "statement_deposits"
  businessCreditPullConsent?: true
  ownerCreditPullConsent?: true
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

export function applicationIdForAttempt(attemptKey: string): string {
  return `fora_${attemptKey}`
}

export function setForaFinancialFixture(destination?: string): void {
  destinationOverride = destination
}

export function foraFinancialFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindForaFinancialApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetForaFinancialFixtures(): void {
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
  const suffix = normalized.startsWith(`${FORA_FINANCIAL_SLUG}:`)
    ? normalized.slice(FORA_FINANCIAL_SLUG.length + 1)
    : normalized === FORA_FINANCIAL_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential") return "expired-credential"
  if (suffix === "incomplete" || suffix === "incomplete-application" || suffix === "missing-info") return "incomplete"
  if (suffix === "contracts-in" || suffix === "contracts_in") return "contracts-in"
  if (suffix === "pending-funding" || suffix === "pending_funding" || suffix === "funding") return "pending-funding"
  if (
    suffix === "timeout"
    || suffix === "accepted"
    || suffix === "approved"
    || suffix === "funded"
    || suffix === "declined"
    || suffix === "unknown"
  ) {
    return suffix
  }
  return "accepted"
}

export function submitRawForScenario(scenario: FixtureScenario): string {
  if (scenario === "incomplete") return "Incomplete Application"
  return "In Progress"
}

export function statusRawForScenario(scenario: FixtureScenario): string {
  if (scenario === "incomplete") return "Incomplete Application"
  if (scenario === "approved") return "Approved"
  if (scenario === "contracts-in") return "Contracts In"
  if (scenario === "pending-funding") return "Pending Funding"
  if (scenario === "funded") return "Funded"
  if (scenario === "declined") return "Declined"
  if (scenario === "unknown") return "CREDIT_COMMITTEE_HOLD"
  return "In Progress"
}

function receiptsFor(
  attemptKey: string,
  documents: Array<{ documentId: string; category: string }>,
  existing: FixtureDocumentReceipt[],
): FixtureDocumentReceipt[] {
  if (existing.length) return existing
  return documents
    .filter((document) => document.category === "application" || document.category === "bank_statements")
    .map((document) => ({
      documentId: document.documentId,
      category: document.category,
      receiptId: `fora_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: applicationIdForAttempt(input.attemptKey),
    rawStatus: submitRawForScenario(scenario),
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
  record.rawStatus = submitRawForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  return { ok: true, record }
}
