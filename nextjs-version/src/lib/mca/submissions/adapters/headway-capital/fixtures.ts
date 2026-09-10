import "server-only"

import type { AdapterStatusResult } from "../../contracts"
import { HEADWAY_CAPITAL_SLUG } from "./mapping"

export const EXPIRED_CREDENTIAL_TOKEN = "expired-headway-development-password"

export const FIXTURE_SCENARIOS = [
  "accepted",
  "timeout",
  "expired-credential",
  "incomplete",
  "action-required",
  "offer-ready",
  "contract-unsigned",
  "funding-pending",
  "issued",
  "declined",
] as const
export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number]

export const SYNTHETIC_OFFER_TERMS: NonNullable<AdapterStatusResult["terms"]> = {
  amount: 50000,
  rate: 1.29,
  term: 12,
  frequency: "weekly",
}

export interface FixtureMappedSnapshot {
  legalName?: string
  email?: string
  entityType?: string
  annualRevenue?: number
  requestedAmount?: number
  loanPurpose?: string
  owners?: Array<{ firstName: string; lastName: string }>
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

export function setHeadwayCapitalFixture(destination?: string): void {
  destinationOverride = destination
}

export function headwayCapitalFixtureDestination(): string | undefined {
  return destinationOverride
}

export function bindHeadwayCapitalApplication(attemptKey: string, application: unknown): void {
  applications.set(attemptKey, application)
}

export function getBoundApplication(attemptKey: string): unknown {
  return applications.get(attemptKey)
}

export function resetHeadwayCapitalFixtures(): void {
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
  const suffix = normalized.startsWith(`${HEADWAY_CAPITAL_SLUG}:`)
    ? normalized.slice(HEADWAY_CAPITAL_SLUG.length + 1)
    : normalized === HEADWAY_CAPITAL_SLUG || normalized === ""
      ? "accepted"
      : normalized
  if (suffix === "expired" || suffix === "expired-credential") return "expired-credential"
  if (suffix === "missing-info" || suffix === "outstanding-documents" || suffix === "incomplete") return "incomplete"
  if (suffix === "action-required" || suffix === "action_required") return "action-required"
  if (suffix === "offer-ready" || suffix === "offer_ready") return "offer-ready"
  if (suffix === "contract-unsigned" || suffix === "contract_unsigned") return "contract-unsigned"
  if (suffix === "funding-pending" || suffix === "funding_pending") return "funding-pending"
  if (suffix === "timeout" || suffix === "issued" || suffix === "declined" || suffix === "accepted") return suffix
  return "accepted"
}

export function outstandingDocumentsFor(destination: string): string[] {
  const normalized = destination.trim().toLowerCase()
  if (normalized.includes("outstanding") || normalized.includes("missing-info")) {
    return ["bank statements", "application"]
  }
  return []
}

export function rawStatusForScenario(scenario: FixtureScenario): string {
  if (scenario === "declined") return "Declined"
  if (scenario === "incomplete") return "Application Incomplete"
  if (scenario === "action-required") return "Action Required"
  if (scenario === "offer-ready") return "Offer Ready"
  if (scenario === "contract-unsigned") return "Contract Unsigned"
  if (scenario === "funding-pending") return "Funding Pending"
  if (scenario === "issued") return "Issued"
  return "In Underwriting"
}

export function scenarioTerms(scenario: FixtureScenario): AdapterStatusResult["terms"] | undefined {
  if (
    scenario === "offer-ready"
    || scenario === "contract-unsigned"
    || scenario === "funding-pending"
    || scenario === "issued"
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
    receiptId: `hwc_doc_${attemptKey}_${document.documentId}`,
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
    externalRef: `hwc_${input.attemptKey}`,
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
