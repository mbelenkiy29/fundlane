import assert from "node:assert/strict"
import test from "node:test"
import { cleanupAcceptanceObjects, runAcceptance, validateAcceptancePreflight, verifyAcceptancePrices, type AcceptanceStripeClient } from "../scripts/billing/test-clock-acceptance"

const env = { MCA_BILLING_ACCEPTANCE_ENABLED: "true", MCA_STRIPE_MODE: "test", MCA_ACCEPTANCE_STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats" }
const expectedTotals = new Map([[1, 39900], [2, 47800], [10, 111000], [11, 117900], [20, 180000], [21, 185900]])

function price(id: string) {
  if (id === "price_base") return { id, active: true, currency: "usd", livemode: false, billing_scheme: "per_unit", unit_amount: 39900, recurring: { interval: "month", usage_type: "licensed" }, tiers_mode: null }
  return { id, active: true, currency: "usd", livemode: false, billing_scheme: "tiered", unit_amount: null, recurring: { interval: "month", usage_type: "licensed" }, tiers_mode: "graduated", tiers: [{ up_to: 9, unit_amount: 7900 }, { up_to: 19, unit_amount: 6900 }, { up_to: null, unit_amount: 5900 }] }
}

function mockClient() {
  const calls: string[] = []
  const customerSeats = new Map<string, number>()
  let currentInvoiceTotal = 0
  let customerSequence = 0
  const client: AcceptanceStripeClient = {
    prices: { retrieve: async id => { calls.push(`prices.retrieve:${id}`); return price(id) } },
    testHelpers: { testClocks: {
      create: async () => ({ id: "clock_fixture", frozen_time: 1_800_000_000, metadata: { fundlane_acceptance: "true" } }),
      advance: async () => ({ id: "clock_fixture", frozen_time: 1_801_300_000, metadata: { fundlane_acceptance: "true" } }),
      list: async () => ({ data: [] }), del: async () => undefined,
    } },
    customers: {
      create: async () => { const id = `cus_${++customerSequence}`; return { id, metadata: { fundlane_acceptance: "true" } } },
      list: async () => ({ data: [] }), retrieve: async id => ({ id }), del: async () => undefined,
    },
    paymentMethods: { attach: async () => ({ id: "pm_test_attached" }) },
    subscriptions: {
      create: async params => {
        const value = params as { customer: string; items: { quantity: number }[] }
        const seats = 1 + (value.items[1]?.quantity ?? 0)
        customerSeats.set(value.customer, seats)
        const invoice = `in_${value.customer}`
        const total = expectedTotals.get(seats)
        assert.notEqual(total, undefined, `unexpected mocked quantity ${seats}`)
        currentInvoiceTotal = total!
        return { id: `sub_${value.customer}`, status: "active", items: { data: [{ id: "si_base" }] }, latest_invoice: invoice }
      },
      retrieve: async id => ({ id, status: "active", items: { data: [{ id: "si_base" }] }, latest_invoice: `in_${id.slice(4)}` }),
    },
    invoices: {
      retrieve: async id => ({ id, status: "paid", total: currentInvoiceTotal }),
      createPreview: async params => { const customer = (params as { customer: string }).customer; return { id: `up_${customer}`, status: "draft", total: expectedTotals.get(customerSeats.get(customer) ?? 0) ?? 0 } },
    },
  }
  return { client, calls }
}

test("preflight refuses a live key or live target before constructing Stripe", () => {
  assert.throws(() => validateAcceptancePreflight(["--confirm"], { ...env, MCA_ACCEPTANCE_STRIPE_SECRET_KEY: "sk_live_fixture" }), /test-mode key/)
  assert.throws(() => validateAcceptancePreflight(["--confirm"], { ...env, MCA_STRIPE_MODE: "live" }), /never allowed/)
  assert.throws(() => validateAcceptancePreflight(["--confirm"], { ...env, MCA_BILLING_ACCEPTANCE_ENABLED: "TRUE" }), /exactly true/)
  assert.throws(() => validateAcceptancePreflight([], env), /--confirm/)
})

test("configured Stripe prices must exactly match the immutable catalog", async () => {
  const { client } = mockClient()
  client.prices.retrieve = async id => ({ ...price(id), unit_amount: id === "price_base" ? 1 : null })
  await assert.rejects(verifyAcceptancePrices(client, { basePriceId: "price_base", seatPriceId: "price_seats" }), /base Price does not match/)
})

test("seat quote scenario compares provider invoices and previews for every approved total without price writes", async () => {
  const { client, calls } = mockClient()
  const report = await runAcceptance(["seat-proration-quotes", "--confirm"], env, client)
  assert.deepEqual(report.checks.map(check => [check.seats, check.expectedCents, check.invoiceCents, check.quoteCents]), [...expectedTotals].map(([seats, total]) => [seats, total, total, total]))
  assert.deepEqual(calls, ["prices.retrieve:price_base", "prices.retrieve:price_seats"])
  assert.equal("create" in client.prices, false, "the injected client surface exposes no Price write operation")
  assert.equal("update" in client.prices, false, "the injected client surface exposes no Price write operation")
})

test("cleanup deletes only customers and test clocks bearing the exact acceptance tag", async () => {
  const deleted: string[] = []
  const { client } = mockClient()
  client.customers.list = async () => ({ data: [{ id: "cus_owned", metadata: { fundlane_acceptance: "true" } }, { id: "cus_other", metadata: { fundlane_acceptance: "false" } }] })
  client.customers.retrieve = async id => ({ id, metadata: { fundlane_acceptance: id === "cus_owned" ? "true" : "false" } })
  client.customers.del = async id => { deleted.push(id) }
  client.testHelpers.testClocks.list = async () => ({ data: [{ id: "clock_owned", frozen_time: 1, metadata: { fundlane_acceptance: "true" } }, { id: "clock_other", frozen_time: 1, metadata: {} }] })
  client.testHelpers.testClocks.del = async id => { deleted.push(id) }
  const report = await cleanupAcceptanceObjects(client)
  assert.deepEqual(deleted, ["cus_owned", "clock_owned"])
  assert.deepEqual(report.objects, { deletedCustomers: ["cus_owned"], deletedTestClocks: ["clock_owned"] })
})
