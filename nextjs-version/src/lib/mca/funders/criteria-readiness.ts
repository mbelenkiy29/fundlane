import type { EligibilityRule } from "./contracts"

export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

/** No implicit maximum age: only a configured validUntil means expired. */
export function criteriaReadiness(rules: EligibilityRule[], asOf: string): {
  status: "ready" | "needs_review" | "stale_criteria"
  missingData: string[]
  reasons: string[]
} {
  const time = Date.parse(asOf)
  if (!Number.isFinite(time)) throw new Error("A valid as-of timestamp is required.")
  const day = new Date(time).toISOString().slice(0, 10)
  if (!rules.length) return { status: "needs_review", missingData: ["criteria"], reasons: ["No lender criteria supplied. Fit cannot be confirmed."] }
  const missingData: string[] = []
  const reasons: string[] = []
  let expired = false
  for (const rule of rules) {
    if (rule.unspecified || rule.value === null) missingData.push(`${rule.id}.value`)
    if (!rule.sourceText?.trim()) missingData.push(`${rule.id}.source`)
    if (!rule.sourceAsOf) missingData.push(`${rule.id}.sourceAsOf`)
    if (rule.sourceAsOf && (!isCalendarDate(rule.sourceAsOf) || rule.sourceAsOf > day)) {
      missingData.push(`${rule.id}.sourceAsOf`)
      reasons.push(`${rule.field}: source as-of date is invalid or in the future.`)
    }
    if (rule.validUntil && !isCalendarDate(rule.validUntil)) {
      missingData.push(`${rule.id}.validUntil`)
    } else if (rule.validUntil && rule.validUntil < day) {
      expired = true
      reasons.push(`${rule.field}: configured criteria expired after ${rule.validUntil}.`)
    }
  }
  if (missingData.length) reasons.push("Some criterion values or source details are missing; broker verification is required.")
  return { status: expired ? "stale_criteria" : missingData.length ? "needs_review" : "ready", missingData: [...new Set(missingData)], reasons }
}
