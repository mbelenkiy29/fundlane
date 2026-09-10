import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { RAPID_FINANCE_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-rapid-finance-development-token"

export const RAPID_FINANCE_FIXTURE_TRANSPORT = "fixture://rapid-finance/deals"

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 50000,
  rate: 1.28,
  term: 8,
  frequency: "daily",
  commission: 10,
  offerLink: "https://offers.example.test/rapid-finance/synthetic-offer",
}

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "declined",
  "pending",
  "approved",
  "funded",
  "withdrawn",
  "rescinded",
  "rescind-by-client",
  "contracts-out",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  annualRevenue?: number
  entityType?: string
  owners?: Array<{ firstName: string; lastName: string; ownershipPercent: number }>
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
  documentReceipts: FixtureDocumentReceipt[]
  completed: boolean
  timedOut: boolean
  submitCalls: number
  terms?: AdapterStatusResult["terms"]
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

export function setRapidFinanceFixture(destination?: string): void {
  destinationOverride = destination
}

export function rapidFinanceFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindRapidFinanceApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetRapidFinanceFixtures(): void {
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

export function rapidFinanceDealId(attemptKey: string): string {
  return `rf_${attemptKey}`
}

export function rapidFinancePortalUrl(externalRef: string): string {
  return `https://portal.example.test/rapid-finance/${externalRef}`
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${RAPID_FINANCE_SLUG}:`)
    ? normalized.slice(RAPID_FINANCE_SLUG.length + 1)
    : normalized === RAPID_FINANCE_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential" || suffix === "expired_credential") return "expired-credential"
  if (suffix === "rescind" || suffix === "rescinded" || suffix === "rescind-by-rapid-finance") return "rescinded"
  if (suffix === "rescind-by-client" || suffix === "rescindbyclient") return "rescind-by-client"
  if (suffix === "contracts" || suffix === "contracts-out" || suffix === "contractsout") return "contracts-out"
  if (suffix === "conditionally-submitted" || suffix === "pending") return "pending"
  if (
    suffix === "timeout"
    || suffix === "declined"
    || suffix === "approved"
    || suffix === "funded"
    || suffix === "withdrawn"
    || suffix === "accepted"
  ) return suffix
  return "accepted"
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "pending") return "Pending"
  if (scenario === "approved") return "Approved"
  if (scenario === "funded") return "Funded"
  if (scenario === "withdrawn") return "Withdrawn"
  if (scenario === "rescinded") return "RescindByRapidFinance"
  if (scenario === "rescind-by-client") return "RescindByClient"
  if (scenario === "contracts-out") return "ContractsOut"
  if (scenario === "expired-credential") return ""
  return "SubmittedDeal"
}

export function termsForScenario(scenario: FixtureScenario): AdapterStatusResult["terms"] | undefined {
  if (scenario === "approved" || scenario === "funded") return { ...SYNTHETIC_OFFER_TERMS }
  return undefined
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
    receiptId: `rf_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: rapidFinanceDealId(input.attemptKey),
    rawStatus: rawStatusForScenario(scenario),
    documentReceipts: [],
    completed: false,
    timedOut: false,
    submitCalls: 0,
    terms: termsForScenario(scenario),
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
  record.terms = termsForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  return { ok: true, record }
}
