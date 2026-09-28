import test from "node:test"
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import type Stripe from "stripe"
import { BILLING_CATALOG, monthlyPriceCents } from "../src/lib/mca/billing-catalog"
import { verifyBillingPrices, type StripeBillingClient } from "../src/lib/mca/billing"

const catalog = BILLING_CATALOG
const basePrice = () => ({ id: "price_base", active: true, livemode: false, currency: catalog.currency,
  billing_scheme: catalog.base.billingScheme, unit_amount: catalog.base.unitAmountCents,
  recurring: { interval: catalog.interval, interval_count: 1, usage_type: catalog.usageType } }) as Stripe.Price
const seatPrice = () => ({ id: "price_seats", active: true, livemode: false, currency: catalog.currency,
  billing_scheme: catalog.additionalSeats.billingScheme, tiers_mode: catalog.additionalSeats.tiersMode,
  tiers: catalog.additionalSeats.tiers.map(tier => ({ up_to: tier.upTo, unit_amount: tier.unitAmountCents, flat_amount: null })),
  recurring: { interval: catalog.interval, interval_count: 1, usage_type: catalog.usageType } }) as Stripe.Price

test("Stripe price verification accepts the catalog and rejects incompatible prices", async () => {
  const previous = Object.fromEntries(["MCA_STRIPE_MODE", "STRIPE_BASE_PRICE_ID", "STRIPE_ADDITIONAL_SEAT_PRICE_ID"].map(key => [key, process.env[key]]))
  Object.assign(process.env, { MCA_STRIPE_MODE: "test", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats" })
  const verify = (base: Stripe.Price, seats: Stripe.Price) => verifyBillingPrices({ prices: { retrieve: async (id: string) => id === "price_base" ? base : seats } } as unknown as StripeBillingClient)
  try {
    assert.deepEqual(await verify(basePrice(), seatPrice()), { base: "price_base", seats: "price_seats" })
    for (const [name, base, seats] of [
      ["wrong interval", { ...basePrice(), recurring: { ...basePrice().recurring!, interval: "year" } }, seatPrice()],
      ["wrong interval count", { ...basePrice(), recurring: { ...basePrice().recurring!, interval_count: 2 } }, seatPrice()],
      ["wrong usage type", basePrice(), { ...seatPrice(), recurring: { ...seatPrice().recurring!, usage_type: "metered" } }],
      ["wrong Stripe mode", { ...basePrice(), livemode: true }, seatPrice()],
      ["non-graduated seats", basePrice(), { ...seatPrice(), tiers_mode: "volume" }],
      ["wrong base scheme", { ...basePrice(), billing_scheme: "tiered" }, seatPrice()],
      ["wrong currency", { ...basePrice(), currency: "eur" }, seatPrice()],
      ["inactive", basePrice(), { ...seatPrice(), active: false }],
      ["wrong base amount", { ...basePrice(), unit_amount: catalog.base.unitAmountCents + 1 }, seatPrice()],
      ["wrong tier amount", basePrice(), { ...seatPrice(), tiers: [{ ...seatPrice().tiers![0], unit_amount: catalog.additionalSeats.tiers[0].unitAmountCents + 1 }, ...seatPrice().tiers!.slice(1)] }],
      ["wrong tier boundary", basePrice(), { ...seatPrice(), tiers: [{ ...seatPrice().tiers![0], up_to: catalog.additionalSeats.tiers[0].upTo + 1 }, ...seatPrice().tiers!.slice(1)] }],
      ["nonzero flat amount", basePrice(), { ...seatPrice(), tiers: [{ ...seatPrice().tiers![0], flat_amount: 1 }, ...seatPrice().tiers!.slice(1)] }],
    ] as Array<[string, Stripe.Price, Stripe.Price]>) {
      await assert.rejects(verify(base, seats), { code: "billing_price_mismatch" }, name)
    }
    process.env.MCA_STRIPE_MODE = "live"
    assert.deepEqual(await verify({ ...basePrice(), livemode: true }, { ...seatPrice(), livemode: true }), { base: "price_base", seats: "price_seats" })
    await assert.rejects(verify(basePrice(), { ...seatPrice(), livemode: true }), { code: "billing_price_mismatch" }, "test price in live mode")
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test("quotes match the approved invoice totals at each seat tier boundary", () => {
  for (const [seats, cents] of [[1, 39900], [2, 47800], [10, 111000], [11, 117900], [20, 180000], [21, 185900]]) {
    assert.equal(monthlyPriceCents(seats), cents, `${seats} seats`)
  }
})

test("application and Stripe scripts keep catalog price literals in one module", async () => {
  const root = resolve(import.meta.dirname, "..")
  const catalogPath = join(root, "src/lib/mca/billing-catalog.ts")
  const priceLiteral = /\b(?:39900|7900|6900|5900)\b|\$(?:399|79|69|59)\b|\bmonthlyUsd\s*:\s*399\b|\busd-399\b/g
  const matches: string[] = []
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (path !== catalogPath && /\.(?:ts|tsx|js|jsx|mjs|cjs|json)$/.test(entry.name)) {
        const content = await readFile(path, "utf8")
        if (priceLiteral.test(content)) matches.push(relative(root, path))
        priceLiteral.lastIndex = 0
      }
    }
  }
  await scan(join(root, "src"))
  await scan(join(root, "scripts"))
  assert.deepEqual(matches, [])
})
