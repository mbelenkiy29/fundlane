import "server-only"

const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]+$/

export function stripeSecretKeyPattern(live: boolean) {
  return live ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/
}

export function readStripeSecretKey() {
  return process.env.STRIPE_SECRET_KEY?.trim() ?? ""
}

export function readPriceIds(): { base: string; seats: string } | null {
  const base = process.env.STRIPE_BASE_PRICE_ID?.trim() ?? ""
  const seats = process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID?.trim() ?? ""
  if (!base || !seats || base === seats || !PRICE_ID_PATTERN.test(base) || !PRICE_ID_PATTERN.test(seats)) return null
  return { base, seats }
}

export function missingStripePriceIdNames() {
  const base = process.env.STRIPE_BASE_PRICE_ID?.trim() ?? ""
  const seats = process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID?.trim() ?? ""
  const missing: string[] = []
  if (!base || !PRICE_ID_PATTERN.test(base) || base === seats) missing.push("STRIPE_BASE_PRICE_ID")
  if (!seats || !PRICE_ID_PATTERN.test(seats) || base === seats) missing.push("STRIPE_ADDITIONAL_SEAT_PRICE_ID")
  return missing
}

/** Card-first Checkout trial is fully configured only when every required setting is present and valid. Names only, never values. */
export function stripeCheckoutTrialConfiguration() {
  const missing: string[] = []
  if (process.env.MCA_STRIPE_BILLING_ENABLED !== "true") missing.push("MCA_STRIPE_BILLING_ENABLED")
  const mode = process.env.MCA_STRIPE_MODE
  const live = mode === "live" ? true : mode === "test" ? false : null
  if (live === null) missing.push("MCA_STRIPE_MODE")
  const key = readStripeSecretKey()
  if (!key || (live !== null && !stripeSecretKeyPattern(live).test(key))) missing.push("STRIPE_SECRET_KEY")
  missing.push(...missingStripePriceIdNames())
  if (!process.env.STRIPE_BILLING_WEBHOOK_SECRET?.trim()) missing.push("STRIPE_BILLING_WEBHOOK_SECRET")
  return { configured: missing.length === 0, missing }
}

export const isStripeCheckoutTrialConfigured = () => stripeCheckoutTrialConfiguration().configured

export function warnUnconfiguredStripeCheckoutTrial() {
  const { missing } = stripeCheckoutTrialConfiguration()
  console.warn(`[billing] Stripe Checkout trial not fully configured (missing: ${missing.join(", ")}); using the legacy no-card 14-day trial`)
}
