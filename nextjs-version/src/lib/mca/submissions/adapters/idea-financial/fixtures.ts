import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { IDEA_FINANCIAL_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-idea-financial-development-secret"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "incomplete",
  "dormant",
  "conditional-offer",
  "offer",
  "closing",
  "contract-ready",
  "contract-out",
  "closing-incomplete",
  "funded",
  "closed",
  "open",
  "declined",
  "not-interested",
  "abandoned",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 50000,
  rate: 1.32,
  term: 10,
  frequency: "weekly",
  offerLink: "https://offers.example.test/idea-financial/checkout",
}

export const SYNTHETIC_STIPS = ["voided check", "proof of ownership"] as const

const OFFER_SCENARIOS = new Set<FixtureScenario>([
  "conditional-offer",
  "offer",
  "closing",
  "contract-ready",
  "contract-out",
  "closing-incomplete",
  "funded",
  "closed",
  "open",
])

export interface FixtureMappedSnapshot {
  legalName?: string
  entityType?: string
  ein?: string
  monthlyRevenue?: number
  annualRevenue?: number
  requestedAmount?: number
  requestedAmountInferred?: boolean
  ficoScore?: number
  naicsCode?: string
  originatorPhoneSource?: string
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
  stips: string[]
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

export function setIdeaFinancialFixture(destination?: string): void {
  destinationOverride = destination
}

export function ideaFinancialFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindIdeaFinancialApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetIdeaFinancialFixtures(): void {
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
  const suffix = normalized.startsWith(`${IDEA_FINANCIAL_SLUG}:`)
    ? normalized.slice(IDEA_FINANCIAL_SLUG.length + 1)
    : normalized === IDEA_FINANCIAL_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents" || suffix === "incomplete" || suffix === "submission-incomplete") {
    return "incomplete"
  }
  if (suffix === "conditional-offer" || suffix === "conditional_offer") return "conditional-offer"
  if (suffix === "contract-ready" || suffix === "contract_ready") return "contract-ready"
  if (suffix === "contract-out" || suffix === "contract_out") return "contract-out"
  if (suffix === "closing-incomplete" || suffix === "closing_incomplete") return "closing-incomplete"
  if (suffix === "not-interested" || suffix === "not_interested") return "not-interested"
  if (
    suffix === "timeout"
    || suffix === "dormant"
    || suffix === "offer"
    || suffix === "closing"
    || suffix === "funded"
    || suffix === "closed"
    || suffix === "open"
    || suffix === "declined"
    || suffix === "abandoned"
    || suffix === "accepted"
  ) {
    return suffix
  }
  return "accepted"
}

export function outstandingDocumentsFor(destination: string): string[] {
  const scenario = resolveFixtureScenario(destination)
  if (scenario === "incomplete") return ["bank statements"]
  const normalized = destination.trim().toLowerCase()
  if (normalized.includes("outstanding") || normalized.includes("missing-info")) {
    return ["bank statements"]
  }
  return []
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "incomplete") return "Submission Incomplete"
  if (scenario === "dormant") return "Dormant"
  if (scenario === "conditional-offer") return "Conditional Offer"
  if (scenario === "offer") return "Offer"
  if (scenario === "closing") return "Closing"
  if (scenario === "contract-ready") return "Contract Ready"
  if (scenario === "contract-out") return "Contract Out"
  if (scenario === "closing-incomplete") return "Closing Incomplete"
  if (scenario === "funded") return "Funded"
  if (scenario === "closed") return "Closed"
  if (scenario === "open") return "Open"
  if (scenario === "declined") return "Declined"
  if (scenario === "not-interested") return "Not Interested"
  if (scenario === "abandoned") return "Abandoned"
  if (scenario === "accepted") return "Processing"
  return "Processing"
}

export function stipsForScenario(scenario: FixtureScenario): string[] {
  return OFFER_SCENARIOS.has(scenario) ? [...SYNTHETIC_STIPS] : []
}

export function scenarioTerms(scenario: FixtureScenario): AdapterStatusResult["terms"] | undefined {
  return OFFER_SCENARIOS.has(scenario) ? { ...SYNTHETIC_OFFER_TERMS } : undefined
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
    receiptId: `idea_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: `idea_${input.attemptKey}`,
    rawStatus: rawStatusForScenario(scenario),
    outstandingDocuments: outstandingDocumentsFor(input.destination),
    stips: stipsForScenario(scenario),
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
  record.stips = stipsForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  if (scenario === "declined" || scenario === "not-interested" || scenario === "abandoned") {
    record.outstandingDocuments = []
    record.stips = []
  }
  return { ok: true, record }
}
