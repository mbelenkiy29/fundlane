/** Public catalog; quantities include the owner and reserved invitations. */
export const BILLING_PLANS = [{ slug: "fundlane", name: "Fundlane", monthlyUsd: 399, seats: 1 }] as const
export type BillingPlanSlug = typeof BILLING_PLANS[number]["slug"]
export type PaidBillingPlanSlug = BillingPlanSlug
export const TRIAL_DAYS = 14
export const TRIAL_SEATS = 5
export function monthlyPriceCents(seats: number): number {
  if (!Number.isSafeInteger(seats) || seats < 1) throw new RangeError("Select an integer number of seats of at least one.")
  return 39900 + Math.min(seats - 1, 9) * 7900 + Math.min(Math.max(seats - 10, 0), 10) * 6900 + Math.max(seats - 20, 0) * 5900
}
