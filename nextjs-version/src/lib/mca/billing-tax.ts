import { AppError } from "./errors"

export type StripeTaxBehavior = "exclusive" | "inclusive"

/** Parse the optional Stripe Price tax behavior used by billing verification. */
export function stripeTaxBehavior(env: Readonly<Record<string, string | undefined>> = process.env): StripeTaxBehavior | undefined {
  const behavior = env.MCA_STRIPE_TAX_BEHAVIOR?.trim()
  if (!behavior) return undefined
  if (behavior === "exclusive" || behavior === "inclusive") return behavior
  throw new AppError(503, "billing_tax_behavior_invalid", "Stripe tax behavior must be exclusive or inclusive.")
}

/** Public pricing copy fails closed without making the public page unavailable. */
export function billingTaxCopy(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  try {
    return stripeTaxBehavior(env) === "inclusive"
      ? "Prices include applicable sales tax."
      : "Sales tax is added where applicable."
  } catch {
    return null
  }
}
