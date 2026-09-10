import type { AdapterSubmitResult } from "../../contracts"
import type { FintegraApplication } from "./mapping"

export const FINTEGRA_FIXTURE_NAMES = [
  "accepted",
  "missing_fields",
  "timeout",
  "expired_credential",
  "disregarded_email",
  "awaiting_clarification",
  "rejected",
  "cancelled",
  "processed",
  "unknown_status",
] as const
export type FintegraFixtureName = (typeof FINTEGRA_FIXTURE_NAMES)[number]

export interface FintegraReceipt {
  attemptKey: string
  correlationId: string
  externalRef?: string
  ok: boolean
  rawStatus?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string>
}

const receipts = new Map<string, FintegraReceipt>()
let fixtureOverride: FintegraFixtureName | undefined
let applicationOverride: FintegraApplication | undefined

export function setFintegraFixtureForTests(name?: FintegraFixtureName): void {
  fixtureOverride = name
}

export function setFintegraApplicationForTests(application?: FintegraApplication): void {
  applicationOverride = application
}

export function fintegraApplicationOverride(): FintegraApplication | undefined {
  return applicationOverride
}

export function resetFintegraAdapterForTests(): void {
  receipts.clear()
  fixtureOverride = undefined
  applicationOverride = undefined
}

export function fintegraExternalRef(attemptKey: string): string {
  return `ftg-${attemptKey}`
}

export function findFintegraReceipt(attemptKey: string): FintegraReceipt | undefined {
  return receipts.get(attemptKey)
}

export function rememberFintegraReceipt(receipt: FintegraReceipt): FintegraReceipt {
  const current = receipts.get(receipt.attemptKey)
  if (current) return current
  receipts.set(receipt.attemptKey, receipt)
  return receipt
}

export function resolveFintegraFixture(destination: string): FintegraFixtureName {
  if (fixtureOverride) return fixtureOverride
  const key = destination.trim().toLowerCase()
  if (key.includes("timeout")) return "timeout"
  if (key.includes("expired")) return "expired_credential"
  if (key.includes("disregarded")) return "disregarded_email"
  if (key.includes("missing") || key.includes("invalid")) return "missing_fields"
  if (key.includes("awaiting")) return "awaiting_clarification"
  if (key.includes("rejected")) return "rejected"
  if (key.includes("cancelled") || key.includes("canceled")) return "cancelled"
  if (key.includes("unknown")) return "unknown_status"
  if (key.includes("processed")) return "processed"
  return "accepted"
}

export function rawStatusForFixture(fixture: FintegraFixtureName): string {
  switch (fixture) {
    case "awaiting_clarification":
      return "Awaiting Clarification"
    case "rejected":
      return "Rejected"
    case "cancelled":
      return "Cancelled"
    case "disregarded_email":
      return "Disregarded Email"
    case "processed":
      return "Processed"
    case "unknown_status":
      return "Credit Committee Hold"
    case "accepted":
    case "missing_fields":
    case "timeout":
    case "expired_credential":
      return "Received"
  }
}

export function submitResultFromReceipt(receipt: FintegraReceipt): AdapterSubmitResult {
  return {
    ok: receipt.ok,
    correlationId: receipt.correlationId,
    externalRef: receipt.externalRef,
    rawStatus: receipt.rawStatus,
    errorCode: receipt.errorCode,
    errorMessage: receipt.errorMessage,
    fields: receipt.fields,
  }
}
