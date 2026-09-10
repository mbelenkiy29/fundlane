import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { PEAC_SOLUTIONS_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-peac-solutions-development-token"

export const PEAC_SOLUTIONS_FIXTURE_TRANSPORT = "fixture://peac-solutions/deals"

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 75000,
  rate: 1.25,
  term: 12,
  frequency: "weekly",
  offerLink: "https://offers.example.test/peac-solutions/synthetic-offer",
}

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "incomplete",
  "offers-ready",
  "booked",
  "contracts-out",
  "funded",
  "declined",
  "withdrawn",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  entityType?: string
  businessEmail?: string
  fundingPurpose?: string
  requestedAmount?: number
  annualRevenue?: number
  revenueSource?: string
  representedOwnership?: number
  owners?: Array<{ firstName: string; lastName: string; ownershipPercent: number }>
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

export function setPeacSolutionsFixture(destination?: string): void {
  destinationOverride = destination
}

export function peacSolutionsFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindPeacSolutionsApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetPeacSolutionsFixtures(): void {
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

export function peacSolutionsApplicationId(attemptKey: string): string {
  return `peac_${attemptKey}`
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${PEAC_SOLUTIONS_SLUG}:`)
    ? normalized.slice(PEAC_SOLUTIONS_SLUG.length + 1)
    : normalized === PEAC_SOLUTIONS_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential" || suffix === "expired_credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents" || suffix === "stips" || suffix === "incomplete") {
    return "incomplete"
  }
  if (suffix === "offers" || suffix === "offers-ready" || suffix === "offers_ready") return "offers-ready"
  if (suffix === "contracts" || suffix === "contracts-out" || suffix === "contracts_out") return "contracts-out"
  if (suffix === "no-pq" || suffix === "no-pq-offers" || suffix === "declined") return "declined"
  if (
    suffix === "timeout"
    || suffix === "booked"
    || suffix === "funded"
    || suffix === "withdrawn"
    || suffix === "accepted"
  ) return suffix
  return "accepted"
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "No PQ Offers Available"
  if (scenario === "incomplete") return "Incomplete"
  if (scenario === "offers-ready") return "Offers Ready"
  if (scenario === "booked") return "Booked"
  if (scenario === "contracts-out") return "Contracts Out"
  if (scenario === "funded") return "Funded"
  if (scenario === "withdrawn") return "Withdrawn"
  if (scenario === "expired-credential") return ""
  return "In Process"
}

export function stipsForScenario(scenario: FixtureScenario): string[] {
  if (scenario === "incomplete") return ["bank statements", "application"]
  return []
}

export function termsForScenario(scenario: FixtureScenario): AdapterStatusResult["terms"] | undefined {
  if (
    scenario === "offers-ready"
    || scenario === "booked"
    || scenario === "contracts-out"
    || scenario === "funded"
  ) {
    return { ...SYNTHETIC_OFFER_TERMS }
  }
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
    receiptId: `peac_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: peacSolutionsApplicationId(input.attemptKey),
    rawStatus: rawStatusForScenario(scenario),
    outstandingDocuments: stipsForScenario(scenario),
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
  record.outstandingDocuments = stipsForScenario(scenario)
  record.terms = termsForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  return { ok: true, record }
}
