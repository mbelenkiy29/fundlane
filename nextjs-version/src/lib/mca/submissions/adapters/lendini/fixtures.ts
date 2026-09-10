import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { ACKNOWLEDGEMENT_STATUS, LENDINI_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-lendini-development-token"

export const LENDINI_FIXTURE_TRANSPORT = "fixture://lendini/deals"

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 45000,
  rate: 1.28,
  term: 12,
  frequency: "daily",
  offerLink: "https://offers.example.test/lendini/synthetic-offer",
}

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "declined",
  "offer",
  "hold",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export interface FixtureMappedSnapshot {
  legalName?: string
  entityType?: string
  industry?: string
  startDate?: string
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
  acknowledgementStatus: string
  decisionStatus: string
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

export function setLendiniFixture(destination?: string): void {
  destinationOverride = destination
}

export function lendiniFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindLendiniApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetLendiniFixtures(): void {
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

export function lendiniApplicationId(attemptKey: string): string {
  return `lendini_${attemptKey}`
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${LENDINI_SLUG}:`)
    ? normalized.slice(LENDINI_SLUG.length + 1)
    : normalized === LENDINI_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential" || suffix === "expired_credential") return "expired-credential"
  if (suffix === "decline" || suffix === "declined") return "declined"
  if (suffix === "offer" || suffix === "offered" || suffix === "approved") return "offer"
  if (suffix === "hold" || suffix === "unknown" || suffix === "unsupported") return "hold"
  if (suffix === "timeout" || suffix === "accepted") return suffix
  return "accepted"
}

export function decisionStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "offer") return "Offer"
  if (scenario === "hold") return "Hold"
  if (scenario === "expired-credential") return ""
  return ACKNOWLEDGEMENT_STATUS
}

export function termsForScenario(scenario: FixtureScenario): AdapterStatusResult["terms"] | undefined {
  if (scenario === "offer") return { ...SYNTHETIC_OFFER_TERMS }
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
    receiptId: `lendini_doc_${attemptKey}_${document.documentId}`,
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

  const decisionStatus = decisionStatusForScenario(scenario)
  const record = existing ?? {
    attemptKey: input.attemptKey,
    externalRef: lendiniApplicationId(input.attemptKey),
    acknowledgementStatus: ACKNOWLEDGEMENT_STATUS,
    decisionStatus,
    rawStatus: decisionStatus,
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
  record.acknowledgementStatus = ACKNOWLEDGEMENT_STATUS
  record.decisionStatus = decisionStatus
  record.rawStatus = decisionStatus
  record.terms = termsForScenario(scenario)
  record.documentReceipts = receiptsFor(input.attemptKey, input.documents ?? [], record.documentReceipts)
  return { ok: true, record }
}
