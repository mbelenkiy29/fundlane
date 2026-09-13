/** Public catalog. Stripe price IDs and credentials are resolved only on the server. */
export const BILLING_PLANS = [
  { slug: "free_org", name: "Free", monthlyUsd: 0, seats: 1 },
  { slug: "mca_starter_test", name: "Starter", monthlyUsd: 49, seats: 5 },
  { slug: "mca_team_test", name: "Team", monthlyUsd: 99, seats: 20 },
] as const
export type BillingPlanSlug = typeof BILLING_PLANS[number]["slug"]
export type PaidBillingPlanSlug = Exclude<BillingPlanSlug, "free_org">
