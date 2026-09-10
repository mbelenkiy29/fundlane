import { allocateCents, assertCents, multiplyCentsByDecimal, percentageOfCents, type AllocatedAmount, type BasisPointAllocation } from "./money"

export const CALCULATION_RULE_VERSION = 1 as const
export const ROUNDING_POLICY = "nearest_cent_half_away_from_zero" as const

export type PaymentFrequency = "daily" | "weekly" | "biweekly" | "monthly"
export type PaymentCalendar = "calendar_days" | "business_days" | "fixed_count"

export interface OfferCalculationInput {
  principalCents: number
  factorRate: string
  commissionBasis: "principal"
  commissionPointsBasisPoints: number
  feesCents?: number
  paymentCount?: number
  paymentFrequency?: PaymentFrequency
  paymentCalendar?: PaymentCalendar
  suppliedPeriodicPaymentCents?: number
  paybackOverrideCents?: number
  commissionOverrideCents?: number
}

export interface CalculationSnapshot {
  ruleVersion: typeof CALCULATION_RULE_VERSION
  roundingPolicy: typeof ROUNDING_POLICY
  inputs: OfferCalculationInput
  paybackCents: number
  commissionCents: number
  periodicPaymentEstimateCents: number | null
  suppliedPeriodicPaymentCents: number | null
  paymentDifferenceCents: number | null
  warnings: string[]
}

export function calculateOffer(input: OfferCalculationInput): CalculationSnapshot {
  assertCents(input.principalCents, "principalCents")
  assertCents(input.feesCents ?? 0, "feesCents")
  if (input.commissionBasis !== "principal") throw new TypeError("commissionBasis must be principal.")
  const paybackCents = input.paybackOverrideCents === undefined
    ? multiplyCentsByDecimal(input.principalCents, input.factorRate, "factorRate")
    : assertCents(input.paybackOverrideCents, "paybackOverrideCents")
  const commissionCents = input.commissionOverrideCents === undefined
    ? percentageOfCents(input.principalCents, input.commissionPointsBasisPoints)
    : assertCents(input.commissionOverrideCents, "commissionOverrideCents")
  const hasCalendar = Boolean(input.paymentFrequency && input.paymentCalendar && input.paymentCount)
  if (input.paymentCount !== undefined && (!Number.isSafeInteger(input.paymentCount) || input.paymentCount <= 0)) {
    throw new TypeError("paymentCount must be a positive safe integer.")
  }
  const periodicPaymentEstimateCents = hasCalendar
    ? Number((BigInt(paybackCents) + BigInt(input.paymentCount!) / BigInt(2)) / BigInt(input.paymentCount!))
    : null
  const supplied = input.suppliedPeriodicPaymentCents === undefined
    ? null
    : assertCents(input.suppliedPeriodicPaymentCents, "suppliedPeriodicPaymentCents")
  const paymentDifferenceCents = supplied === null || periodicPaymentEstimateCents === null
    ? null
    : supplied - periodicPaymentEstimateCents
  const warnings: string[] = []
  if (!hasCalendar) warnings.push("Periodic payment estimate is unknown until frequency, calendar convention, and payment count are defined.")
  if (paymentDifferenceCents !== null && paymentDifferenceCents !== 0) warnings.push("The supplied funder payment differs from the calculated estimate.")
  if (input.paybackOverrideCents !== undefined) warnings.push("Payback uses an explicit override.")
  if (input.commissionOverrideCents !== undefined) warnings.push("Commission uses an explicit override.")
  return {
    ruleVersion: CALCULATION_RULE_VERSION,
    roundingPolicy: ROUNDING_POLICY,
    inputs: { ...input, feesCents: input.feesCents ?? 0 },
    paybackCents,
    commissionCents,
    periodicPaymentEstimateCents,
    suppliedPeriodicPaymentCents: supplied,
    paymentDifferenceCents,
    warnings,
  }
}

export interface SplitSnapshot {
  ruleVersion: 1
  roundingPolicy: "largest_fractional_remainder_then_input_order"
  baseCents: number
  allocations: AllocatedAmount[]
}

export function calculateSplitSnapshot(baseCents: number, allocations: readonly BasisPointAllocation[]): SplitSnapshot {
  return {
    ruleVersion: 1,
    roundingPolicy: "largest_fractional_remainder_then_input_order",
    baseCents: assertCents(baseCents, "baseCents"),
    allocations: allocateCents(baseCents, allocations),
  }
}
