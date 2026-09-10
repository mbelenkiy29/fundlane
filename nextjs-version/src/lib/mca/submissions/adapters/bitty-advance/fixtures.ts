import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { BITTY_ADVANCE_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-bitty-advance-development-token"

export const BITTY_ADVANCE_FIXTURE_TRANSPORT = "fixture://bitty-advance/deals"

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 40000,
  rate: 1.32,
  term: 10,
  frequency: "daily",
  offerLink: "https://offers.example.test/bitty-advance/synthetic-offer",
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
  owners?: Array<{ firstName: string; lastName: string; ownershipPercent: number }>
  statements?: Array<{ period: string; revenue: number; negativeDays: number }>
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

export function setBittyAdvanceFixture(destination?: string): void {
  destinationOverride = destination
}

export function bittyAdvanceFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindBittyAdvanceApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetBittyAdvanceFixtures(): void {
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

export function bittyAdvanceDealId(attemptKey: string): string {
  return `bitty_${attemptKey}`
}

export function bittyAdvancePortalUrl(externalRef: string): string {
  return `https://portal.example.test/bitty-advance/${externalRef}`
}

export function resolveFixtureScenario(destination: string): FixtureScenario {
  const normalized = destination.trim().toLowerCase()
  const suffix = normalized.startsWith(`${BITTY_ADVANCE_SLUG}:`)
    ? normalized.slice(BITTY_ADVANCE_SLUG.length + 1)
    : normalized === BITTY_ADVANCE_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential" || suffix === "expired_credential") return "expired-credential"
  if (suffix === "decline" || suffix === "declined") return "declined"
  if (suffix === "offer" || suffix === "offered" || suffix === "approved") return "offer"
  if (suffix === "hold" || suffix === "unknown" || suffix === "unsupported") return "hold"
  if (suffix === "timeout" || suffix === "accepted") return suffix
  return "accepted"
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "offer") return "Offer"
  if (scenario === "hold") return "Hold"
  if (scenario === "expired-credential") return ""
  return "Submitted"
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
    receiptId: `bitty_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: bittyAdvanceDealId(input.attemptKey),
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
