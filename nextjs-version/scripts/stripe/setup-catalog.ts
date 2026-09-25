import Stripe from "stripe"
import { verifyBillingPrices, priceIds } from "../../src/lib/mca/billing"
import { BILLING_CATALOG } from "../../src/lib/mca/billing-catalog"

/** Read-only by default; never changes an existing price or the account's default portal. */
async function main() {
  const mode = process.env.MCA_STRIPE_MODE
  const key = process.env.STRIPE_SECRET_KEY
  if (!key || !["test", "live"].includes(mode ?? "") || !(mode === "live" ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(key)) {
    throw new Error("Set MCA_STRIPE_MODE and a matching server-only STRIPE_SECRET_KEY.")
  }
  const expectedAccount = process.argv.find(value => value.startsWith("--expected-account="))?.split("=")[1]
  if (!expectedAccount || !/^acct_[a-zA-Z0-9]+$/.test(expectedAccount)) throw new Error("Supply --expected-account=acct_... for the intended Fundlane account.")
  const stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15000, maxNetworkRetries: 1 })
  const account = await stripe.accounts.retrieve(null)
  if (account.id !== expectedAccount) throw new Error("Stripe account does not match --expected-account.")
  const apply = process.argv.includes("--apply")
  const keys = ["fundlane_v1_base_monthly_usd", "fundlane_v1_additional_monthly_usd"]
  const found = await stripe.prices.list({ lookup_keys: keys, limit: 100 })
  let base = found.data.find(price => price.lookup_key === keys[0])
  let seats = found.data.find(price => price.lookup_key === keys[1])
  if ((!base || !seats) && !apply) {
    console.log(JSON.stringify({ account: account.id, mode, catalogComplete: false, missing: keys.filter(k => !found.data.some(p => p.lookup_key === k)), next: "Review destination, then rerun with --apply." }, null, 2))
    return
  }
  if (!base || !seats) {
    let product: Stripe.Product | undefined
    for await (const candidate of stripe.products.list({ active: true, limit: 100 })) {
      if (candidate.metadata.application === "fundlane" && candidate.metadata.catalog_version === "1") {
        if (product) throw new Error("Multiple Fundlane v1 products require operator review.")
        product = candidate
      }
    }
    product ??= await stripe.products.create({ name: "Fundlane", description: "Company subscription with graduated team seats", metadata: { application: "fundlane", catalog_version: "1" } }, { idempotencyKey: "fundlane-v1-product" })
    base ??= await stripe.prices.create({ product: product.id, currency: BILLING_CATALOG.currency, unit_amount: BILLING_CATALOG.base.unitAmountCents, recurring: { interval: BILLING_CATALOG.interval, usage_type: BILLING_CATALOG.usageType }, lookup_key: keys[0], nickname: "Fundlane base — first user included" }, { idempotencyKey: keys[0] })
    seats ??= await stripe.prices.create({ product: product.id, currency: BILLING_CATALOG.currency, billing_scheme: BILLING_CATALOG.additionalSeats.billingScheme, tiers_mode: BILLING_CATALOG.additionalSeats.tiersMode, recurring: { interval: BILLING_CATALOG.interval, usage_type: BILLING_CATALOG.usageType }, tiers: BILLING_CATALOG.additionalSeats.tiers.map(tier => ({ up_to: tier.upTo ?? "inf", unit_amount: tier.unitAmountCents })), lookup_key: keys[1], nickname: "Fundlane additional users" }, { idempotencyKey: keys[1] })
  }
  process.env.STRIPE_BASE_PRICE_ID = base.id
  process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID = seats.id
  await verifyBillingPrices(stripe)
  const configurations = await stripe.billingPortal.configurations.list({ limit: 100 })
  let portal = configurations.data.find(value => value.metadata?.application === "fundlane" && value.metadata?.catalog_version === "1")
  if (!portal && apply) portal = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Manage your Fundlane subscription" },
    metadata: { application: "fundlane", catalog_version: "1" },
    features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: "at_period_end" } },
  }, { idempotencyKey: "fundlane-v1-portal" })
  if (portal && (!portal.active || portal.livemode !== (mode === "live") || portal.features.subscription_update.enabled || !portal.features.payment_method_update.enabled || !portal.features.invoice_history.enabled || !portal.features.subscription_cancel.enabled || portal.features.subscription_cancel.mode !== "at_period_end")) {
    throw new Error("Existing Fundlane portal configuration is incompatible; review it without changing other products' portals.")
  }
  console.log(JSON.stringify({ account: account.id, mode, catalogComplete: true, chargesEnabled: account.charges_enabled,
    STRIPE_BASE_PRICE_ID: priceIds().base, STRIPE_ADDITIONAL_SEAT_PRICE_ID: priceIds().seats,
    STRIPE_BILLING_PORTAL_CONFIGURATION: portal?.id ?? null,
    webhook: "Configure /api/webhooks/stripe with subscription, invoice, refund and dispute events; store the signing secret privately." }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Stripe catalog setup failed."); process.exitCode = 1 })
