/** Current catalog amounts, pending owner approval in #79. Quantities include the owner and reserved invitations. */
export const BILLING_CATALOG = {
  currency: "usd",
  interval: "month",
  usageType: "licensed",
  version: "fundlane-monthly-usd-399-79-69-59",
  base: { billingScheme: "per_unit", unitAmountCents: 39900 },
  additionalSeats: {
    billingScheme: "tiered",
    tiersMode: "graduated",
    tiers: [
      { upTo: 9, unitAmountCents: 7900 },
      { upTo: 19, unitAmountCents: 6900 },
      { upTo: null, unitAmountCents: 5900 },
    ],
  },
} as const satisfies {
  currency: string
  interval: "month"
  usageType: "licensed"
  version: string
  base: { billingScheme: "per_unit"; unitAmountCents: number }
  additionalSeats: { billingScheme: "tiered"; tiersMode: "graduated"; tiers: readonly { upTo: number | null; unitAmountCents: number }[] }
}
export const BILLING_PLANS = [{ slug: "fundlane", name: "Fundlane", monthlyUsd: BILLING_CATALOG.base.unitAmountCents / 100, seats: 1 }] as const
export type BillingPlanSlug = typeof BILLING_PLANS[number]["slug"]
export type PaidBillingPlanSlug = BillingPlanSlug
export const TRIAL_DAYS = 14
export const TRIAL_SEATS = 5
export function monthlyPriceCents(seats: number): number {
  if (!Number.isSafeInteger(seats) || seats < 1) throw new RangeError("Select an integer number of seats of at least one.")
  let total = BILLING_CATALOG.base.unitAmountCents
  let previousUpTo = 0
  for (const tier of BILLING_CATALOG.additionalSeats.tiers) {
    const quantity = Math.max(0, Math.min(seats - 1, tier.upTo ?? Infinity) - previousUpTo)
    total += quantity * tier.unitAmountCents
    if (tier.upTo === null) break
    previousUpTo = tier.upTo
  }
  return total
}
