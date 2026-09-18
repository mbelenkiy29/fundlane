import type { HomeActionReasonCode } from "./contracts"

export type HomeOutreachId = "call" | "sms" | "email"

export interface HomeSuggestedAction {
  id: HomeOutreachId
  label: string
  enabled: boolean
  href?: string
}

export function notificationLabel(input: {
  code: HomeActionReasonCode
  fallback: string
  missingStatementMonths?: number
}): string {
  if (input.code === "renewal") return "Eligible for Renewal"
  if (input.code === "missing_doc") {
    const months = input.missingStatementMonths
    if (typeof months === "number" && months >= 1) {
      return months === 1 ? "Missing 1 month of Statements" : `Missing ${months} months of Statements`
    }
    return "Missing documents"
  }
  return input.fallback
}

function callAction(phone?: string): HomeSuggestedAction {
  if (!phone) return { id: "call", label: "Call Immediately", enabled: false }
  return { id: "call", label: "Call Immediately", enabled: true, href: `tel:${phone}` }
}

export function suggestedActions(input: {
  code: HomeActionReasonCode
  phone?: string
}): HomeSuggestedAction[] {
  if (input.code === "renewal") return [callAction(input.phone)]
  return [
    { id: "sms", label: "SMS", enabled: true },
    { id: "email", label: "Email", enabled: true },
  ]
}
