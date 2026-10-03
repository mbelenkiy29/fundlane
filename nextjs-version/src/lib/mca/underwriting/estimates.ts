import type { EligibilityRule } from "../funders/contracts"

/** Pure, deterministic advance estimates. Never an offer; see docs/deal-estimates.md. */
export const ESTIMATE_FORMULA_VERSION = 1
export const ESTIMATE_LABEL = "Estimate — not an offer"
export const BUSINESS_DAYS_PER_MONTH = 21
export const WEEKS_PER_MONTH = 4.33
export const MAX_MONTHS_USED = 3
export const REVENUE_LOW_MULTIPLE = 0.5
export const REVENUE_HIGH_MULTIPLE = 1
export const ROUND_TO = 500
export const ESTIMATE_FREQUENCIES = ["daily", "weekly"] as const
export const ESTIMATE_DEFAULTS = { factor: 1.35, termMonths: 6, frequency: "daily", holdbackPct: 0.12 } as const
export const ESTIMATE_LIMITS = { factor: [1.1, 1.6], termMonths: [2, 18], holdbackPct: [0.05, 0.25] } as const

export type EstimateFrequency = (typeof ESTIMATE_FREQUENCIES)[number]
export type EstimateStatus = "estimate" | "insufficient_data" | "no_capacity" | "below_lender_minimum"
export type AssumptionSource = "broker" | "lender" | "default"
export interface EstimateAssumptions { factor?: number; termMonths?: number; frequency?: EstimateFrequency; holdbackPct?: number }

export interface LenderEstimate {
  funderId: string
  funderName: string
  status: EstimateStatus
  reason?: string
  advanceLow: number | null
  advanceHigh: number | null
  factor: number | null
  termMonths: number | null
  frequency: EstimateFrequency
  payments: number | null
  paymentLow: number | null
  paymentHigh: number | null
  paybackLow: number | null
  paybackHigh: number | null
  inputs: { avgMonthlyDeposits: number | null; monthsUsed: number; existingDailyPayments: number; holdbackPct: number }
  assumptionsSource: { factor: AssumptionSource; termMonths: AssumptionSource; frequency: AssumptionSource; holdbackPct: AssumptionSource }
  warnings: string[]
}

export interface DealEstimatesResponse { label: typeof ESTIMATE_LABEL; formulaVersion: typeof ESTIMATE_FORMULA_VERSION; asOf: string; lenders: LenderEstimate[] }

export interface EstimateDealInput {
  asOf: string
  months: Array<{ period: string; deposits: number | null; warnings: string[] }>
  positions: Array<{ estimatedPayment?: number }>
  lenders: Array<{ funderId: string; name: string; rules: EligibilityRule[] }>
  assumptions: EstimateAssumptions
}

const cents = (value: number) => Math.round(value * 100) / 100
const roundDown = (value: number) => Math.floor(cents(value) / ROUND_TO) * ROUND_TO

function ruleValue(rules: EligibilityRule[], field: string, operator: EligibilityRule["operator"]): number | undefined {
  const rule = rules.find((item) => item.field === field && item.operator === operator && !item.unspecified)
  return typeof rule?.value === "number" && Number.isFinite(rule.value) ? rule.value : undefined
}

const TERM_MONTHS_PER_UNIT: Partial<Record<EligibilityRule["unit"], number>> = { days: 12 / 365, months: 1, years: 12 }

/** A lender term rule in months: converted from its own unit, rules without a known time unit ignored, then clamped. */
function lenderTerm(rules: EligibilityRule[], warnings: string[]): number | undefined {
  const months = (operator: EligibilityRule["operator"]) => {
    const rule = rules.find((item) => item.field === "term" && item.operator === operator && !item.unspecified)
    if (typeof rule?.value !== "number" || !Number.isFinite(rule.value)) return undefined
    const factor = TERM_MONTHS_PER_UNIT[rule.unit]
    if (factor == null) { warnings.push(`Lender term rule ignored: unknown unit "${rule.unit}"`); return undefined }
    return rule.value * factor
  }
  const eq = months("eq"), min = months("min"), max = months("max")
  const raw = eq ?? (min != null && max != null ? (min + max) / 2 : min ?? max)
  if (raw == null) return undefined
  const [low, high] = ESTIMATE_LIMITS.termMonths
  const clamped = Math.min(high, Math.max(low, Math.round(raw)))
  if (clamped !== Math.round(raw)) warnings.push(`Lender term ${Math.round(raw * 10) / 10} months clamped to ${clamped}`)
  return clamped
}

function broker(name: keyof typeof ESTIMATE_LIMITS, value: number | undefined, warnings: string[]): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  const [low, high] = ESTIMATE_LIMITS[name]
  const clamped = Math.min(high, Math.max(low, value))
  if (clamped !== value) warnings.push(`Broker ${name} ${value} clamped to ${clamped}`)
  return clamped
}

export function estimateDeal({ asOf, months, positions, lenders, assumptions }: EstimateDealInput): DealEstimatesResponse {
  const byPeriod = new Map<string, number | null>()
  for (const month of months) {
    const total = byPeriod.get(month.period)
    byPeriod.set(month.period, total === null || month.deposits == null || !Number.isFinite(month.deposits) ? null : (total ?? 0) + month.deposits)
  }
  const used = [...byPeriod].filter((entry): entry is [string, number] => entry[1] != null)
    .sort(([left], [right]) => right.localeCompare(left)).slice(0, MAX_MONTHS_USED)
  const avgMonthlyDeposits = used.length ? cents(used.reduce((sum, [, value]) => sum + value, 0) / used.length) : null
  const usedPeriods = new Set(used.map(([period]) => period))

  const shared: string[] = []
  if (months.some((month) => usedPeriods.has(month.period) && month.warnings.some((warning) => warning.startsWith("transfer:") || warning.startsWith("mca_credit:")))) {
    shared.push("Deposits may include transfers or funding credits")
  }
  const paid = positions.filter((position) => position.estimatedPayment != null && Number.isFinite(position.estimatedPayment))
  if (!positions.length) shared.push("Existing positions not detected; estimate assumes none")
  if (positions.length > paid.length) shared.push(`${positions.length - paid.length} existing position(s) have no payment amount and are excluded`)
  // No cadence is stored for positions; treating each payment as daily is the most conservative reading.
  if (paid.length) shared.push("Existing position payments assumed daily")
  // A negative payment would raise capacity; treat it as zero.
  const existingDailyPayments = cents(paid.reduce((sum, position) => sum + Math.max(0, position.estimatedPayment!), 0))

  const brokerWarnings: string[] = []
  const brokerFactor = broker("factor", assumptions.factor, brokerWarnings)
  const brokerTerm = broker("termMonths", assumptions.termMonths, brokerWarnings)
  const brokerHoldback = broker("holdbackPct", assumptions.holdbackPct, brokerWarnings)
  const frequency = assumptions.frequency ?? ESTIMATE_DEFAULTS.frequency
  const holdbackPct = brokerHoldback ?? ESTIMATE_DEFAULTS.holdbackPct

  return {
    label: ESTIMATE_LABEL, formulaVersion: ESTIMATE_FORMULA_VERSION, asOf,
    lenders: lenders.map(({ funderId, name, rules }): LenderEstimate => {
      const termWarnings: string[] = []
      const ruleTerm = brokerTerm == null ? lenderTerm(rules, termWarnings) : undefined
      const factor = brokerFactor ?? ESTIMATE_DEFAULTS.factor
      const termMonths = brokerTerm ?? ruleTerm ?? ESTIMATE_DEFAULTS.termMonths
      const base = {
        funderId, funderName: name, frequency,
        inputs: { avgMonthlyDeposits, monthsUsed: used.length, existingDailyPayments, holdbackPct },
        assumptionsSource: {
          factor: brokerFactor != null ? "broker" : "default",
          termMonths: brokerTerm != null ? "broker" : ruleTerm != null ? "lender" : "default",
          frequency: assumptions.frequency ? "broker" : "default",
          holdbackPct: brokerHoldback != null ? "broker" : "default",
        },
        warnings: [...brokerWarnings, ...termWarnings, ...shared],
      } satisfies Partial<LenderEstimate>
      const none = (status: EstimateStatus, reason: string): LenderEstimate => ({
        ...base, status, reason, advanceLow: null, advanceHigh: null, factor: null, termMonths: null,
        payments: null, paymentLow: null, paymentHigh: null, paybackLow: null, paybackHigh: null,
      })

      if (avgMonthlyDeposits == null || avgMonthlyDeposits <= 0) return none("insufficient_data", "No analyzed bank statements")
      const availableDaily = holdbackPct * avgMonthlyDeposits / BUSINESS_DAYS_PER_MONTH - existingDailyPayments
      if (availableDaily <= 0) return none("no_capacity", "Existing payments already use the holdback capacity")
      const payments = frequency === "daily" ? Math.round(termMonths * BUSINESS_DAYS_PER_MONTH) : Math.round(termMonths * WEEKS_PER_MONTH)
      const capacityMaxAdvance = availableDaily * termMonths * BUSINESS_DAYS_PER_MONTH / factor
      const lenderMax = ruleValue(rules, "requested_amount", "max")
      const lenderMin = ruleValue(rules, "requested_amount", "min")
      const high = roundDown(Math.min(REVENUE_HIGH_MULTIPLE * avgMonthlyDeposits, capacityMaxAdvance, lenderMax ?? Infinity))
      if (high <= 0) return none("no_capacity", "Existing payments already use the holdback capacity")
      if (lenderMin != null && high < lenderMin) return none("below_lender_minimum", `Estimated maximum is below the lender minimum of $${lenderMin}`)
      const low = Math.max(roundDown(Math.min(REVENUE_LOW_MULTIPLE * avgMonthlyDeposits, high)), lenderMin ?? 0)
      const paybackLow = cents(low * factor), paybackHigh = cents(high * factor)
      if (payments < 1 || ![low, high, paybackLow, paybackHigh].every(Number.isFinite)) return none("insufficient_data", "Term or amounts could not be calculated")
      return {
        ...base, status: "estimate", advanceLow: low, advanceHigh: high, factor, termMonths, payments,
        paybackLow, paybackHigh, paymentLow: cents(paybackLow / payments), paymentHigh: cents(paybackHigh / payments),
      }
    }),
  }
}
