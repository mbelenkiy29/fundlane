import { pathToFileURL } from "node:url"
import Stripe from "stripe"
import { BILLING_CATALOG, monthlyPriceCents, TRIAL_DAYS } from "../../src/lib/mca/billing-catalog"

const ACCEPTANCE_TAG = "true"
const API_VERSION = "2026-08-26.dahlia"
const SEAT_CASES = [1, 2, 10, 11, 20, 21] as const

type Metadata = Record<string, string>
type Price = { id: string; active: boolean; currency: string; livemode: boolean; billing_scheme: string; unit_amount: number | null; recurring: { interval: string; usage_type: string } | null; tiers_mode: string | null; tiers?: { up_to: number | null; unit_amount: number | null }[] }
type Customer = { id: string; deleted?: boolean; metadata?: Metadata }
type Clock = { id: string; frozen_time: number; status?: string; metadata?: Metadata }
type Invoice = { id: string; status: string | null; total: number }
type Subscription = { id: string; status: string; items: { data: { id: string }[] }; latest_invoice?: string | Invoice | null }

export interface AcceptanceStripeClient {
  prices: { retrieve(id: string, params?: object): Promise<Price> }
  testHelpers: { testClocks: { create(params: object): Promise<Clock>; advance(id: string, params: object): Promise<Clock>; list(params?: object): Promise<{ data: Clock[] }>; del(id: string): Promise<unknown> } }
  customers: { create(params: object): Promise<Customer>; list(params?: object): Promise<{ data: Customer[] }>; retrieve(id: string): Promise<Customer>; del(id: string): Promise<unknown> }
  paymentMethods: { attach(id: string, params: object): Promise<{ id: string }> }
  subscriptions: { create(params: object): Promise<Subscription>; retrieve(id: string, params?: object): Promise<Subscription> }
  invoices: { createPreview(params: object): Promise<Invoice>; retrieve(id: string): Promise<Invoice> }
}

export type AcceptanceScenario = "trial-to-paid" | "trial-end-missing-card-pauses" | "seat-proration-quotes"
export type AcceptanceReport = { scenario: AcceptanceScenario | "cleanup"; result: "passed"; objects: Record<string, string | string[]>; checks: Record<string, string | number>[] }

function fail(message: string): never { throw new Error(message) }
function tagged(metadata: Metadata | undefined) { return metadata?.fundlane_acceptance === ACCEPTANCE_TAG }
function invoiceId(value: Subscription["latest_invoice"]): string {
  if (typeof value === "string") return value
  if (value?.id) return value.id
  return fail("Stripe did not return a latest invoice for the acceptance subscription.")
}

export function validateAcceptancePreflight(args: readonly string[], env: NodeJS.ProcessEnv) {
  if (env.MCA_BILLING_ACCEPTANCE_ENABLED !== "true") fail("Refusing: MCA_BILLING_ACCEPTANCE_ENABLED must be exactly true.")
  if (!args.includes("--confirm")) fail("Refusing: pass --confirm after reviewing the test-mode operation.")
  if (env.MCA_STRIPE_MODE === "live") fail("Refusing: MCA_STRIPE_MODE=live is never allowed for this runner.")
  const key = env.MCA_ACCEPTANCE_STRIPE_SECRET_KEY
  if (!key || !/^(?:sk|rk)_test_/.test(key)) fail("Refusing: MCA_ACCEPTANCE_STRIPE_SECRET_KEY must be a Stripe test-mode key.")
  const basePriceId = env.STRIPE_BASE_PRICE_ID
  const seatPriceId = env.STRIPE_ADDITIONAL_SEAT_PRICE_ID
  if (!basePriceId?.startsWith("price_") || !seatPriceId?.startsWith("price_") || basePriceId === seatPriceId) fail("Set distinct configured test STRIPE_BASE_PRICE_ID and STRIPE_ADDITIONAL_SEAT_PRICE_ID values.")
  return { key, basePriceId, seatPriceId }
}

export async function verifyAcceptancePrices(client: AcceptanceStripeClient, ids: { basePriceId: string; seatPriceId: string }) {
  const [base, seats] = await Promise.all([
    client.prices.retrieve(ids.basePriceId),
    client.prices.retrieve(ids.seatPriceId, { expand: ["tiers"] }),
  ])
  if (base.livemode || seats.livemode) fail("Refusing: configured acceptance prices must both be test-mode objects.")
  if (!base.active || base.currency !== BILLING_CATALOG.currency || base.billing_scheme !== BILLING_CATALOG.base.billingScheme || base.unit_amount !== BILLING_CATALOG.base.unitAmountCents || base.recurring?.interval !== BILLING_CATALOG.interval || base.recurring.usage_type !== BILLING_CATALOG.usageType) fail("Configured base Price does not match billing-catalog.ts.")
  const actualTiers = seats.tiers ?? []
  const expectedTiers = BILLING_CATALOG.additionalSeats.tiers
  const tiersMatch = actualTiers.length === expectedTiers.length && actualTiers.every((tier, index) => tier.up_to === expectedTiers[index].upTo && tier.unit_amount === expectedTiers[index].unitAmountCents)
  if (!seats.active || seats.currency !== BILLING_CATALOG.currency || seats.billing_scheme !== BILLING_CATALOG.additionalSeats.billingScheme || seats.tiers_mode !== BILLING_CATALOG.additionalSeats.tiersMode || seats.recurring?.interval !== BILLING_CATALOG.interval || seats.recurring.usage_type !== BILLING_CATALOG.usageType || !tiersMatch) fail("Configured additional-seat Price does not match billing-catalog.ts.")
}

function subscriptionItems(ids: { basePriceId: string; seatPriceId: string }, seats: number) {
  return [{ price: ids.basePriceId, quantity: 1 }, ...(seats > 1 ? [{ price: ids.seatPriceId, quantity: seats - 1 }] : [])]
}

async function waitForSubscription(client: AcceptanceStripeClient, id: string, statuses: readonly string[]) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const subscription = await client.subscriptions.retrieve(id, { expand: ["latest_invoice"] })
    if (statuses.includes(subscription.status)) return subscription
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  fail(`Stripe subscription did not reach ${statuses.join(" or ")} after the test-clock advance.`)
}

async function createClock(client: AcceptanceStripeClient, scenario: AcceptanceScenario) {
  const now = Math.floor(Date.now() / 1000)
  return client.testHelpers.testClocks.create({ frozen_time: now, name: `Fundlane ${scenario}`, metadata: { fundlane_acceptance: ACCEPTANCE_TAG, scenario } })
}

async function createCustomer(client: AcceptanceStripeClient, clock: Clock, scenario: AcceptanceScenario, suffix = "") {
  return client.customers.create({ name: `Fundlane acceptance ${scenario}${suffix}`, test_clock: clock.id, metadata: { fundlane_acceptance: ACCEPTANCE_TAG, scenario } })
}

async function runTrialToPaid(client: AcceptanceStripeClient, ids: { basePriceId: string; seatPriceId: string }): Promise<AcceptanceReport> {
  const scenario = "trial-to-paid" as const
  const clock = await createClock(client, scenario)
  const customer = await createCustomer(client, clock, scenario)
  const card = await client.paymentMethods.attach("pm_card_visa", { customer: customer.id })
  const subscription = await client.subscriptions.create({ customer: customer.id, items: subscriptionItems(ids, 1), default_payment_method: card.id, trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "pause" } }, metadata: { fundlane_acceptance: ACCEPTANCE_TAG, scenario }, expand: ["latest_invoice"] })
  if (subscription.status !== "trialing") fail(`Expected trialing, received ${subscription.status}.`)
  await client.testHelpers.testClocks.advance(clock.id, { frozen_time: clock.frozen_time + (TRIAL_DAYS + 1) * 86_400 })
  const paid = await waitForSubscription(client, subscription.id, ["active"])
  const invoice = await client.invoices.retrieve(invoiceId(paid.latest_invoice))
  const expected = monthlyPriceCents(1)
  if (invoice.status !== "paid" || invoice.total !== expected) fail(`Paid trial invoice ${invoice.id} did not match the expected ${expected} cents.`)
  return { scenario, result: "passed", objects: { testClock: clock.id, customer: customer.id, subscription: paid.id, invoice: invoice.id }, checks: [{ trialStatus: "trialing" }, { finalStatus: paid.status }, { invoiceStatus: invoice.status ?? "unknown", amountCents: invoice.total, expectedCents: expected }] }
}

async function runMissingCard(client: AcceptanceStripeClient, ids: { basePriceId: string; seatPriceId: string }): Promise<AcceptanceReport> {
  const scenario = "trial-end-missing-card-pauses" as const
  const clock = await createClock(client, scenario)
  const customer = await createCustomer(client, clock, scenario)
  const subscription = await client.subscriptions.create({ customer: customer.id, items: subscriptionItems(ids, 1), trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: "pause" } }, metadata: { fundlane_acceptance: ACCEPTANCE_TAG, scenario } })
  if (subscription.status !== "trialing") fail(`Expected trialing, received ${subscription.status}.`)
  await client.testHelpers.testClocks.advance(clock.id, { frozen_time: clock.frozen_time + (TRIAL_DAYS + 1) * 86_400 })
  const paused = await waitForSubscription(client, subscription.id, ["paused"])
  return { scenario, result: "passed", objects: { testClock: clock.id, customer: customer.id, subscription: paused.id }, checks: [{ trialStatus: "trialing" }, { finalStatus: paused.status }] }
}

async function runSeatQuotes(client: AcceptanceStripeClient, ids: { basePriceId: string; seatPriceId: string }): Promise<AcceptanceReport> {
  const scenario = "seat-proration-quotes" as const
  const clock = await createClock(client, scenario)
  const customers: string[] = []
  const subscriptions: string[] = []
  const checks: Record<string, string | number>[] = []
  for (const seats of SEAT_CASES) {
    const customer = await createCustomer(client, clock, scenario, ` ${seats}`)
    customers.push(customer.id)
    const card = await client.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    const subscription = await client.subscriptions.create({ customer: customer.id, items: subscriptionItems(ids, seats), default_payment_method: card.id, metadata: { fundlane_acceptance: ACCEPTANCE_TAG, scenario, seats: String(seats) }, expand: ["latest_invoice"] })
    subscriptions.push(subscription.id)
    const invoice = await client.invoices.retrieve(invoiceId(subscription.latest_invoice))
    const quote = await client.invoices.createPreview({ customer: customer.id, subscription: subscription.id })
    const expected = monthlyPriceCents(seats)
    if (invoice.total !== expected || quote.total !== expected) fail(`Stripe totals for ${seats} seats were invoice=${invoice.total}, quote=${quote.total}; expected ${expected}.`)
    checks.push({ seats, expectedCents: expected, invoiceCents: invoice.total, quoteCents: quote.total, invoiceStatus: invoice.status ?? "unknown" })
  }
  return { scenario, result: "passed", objects: { testClock: clock.id, customers, subscriptions }, checks }
}

export async function cleanupAcceptanceObjects(client: AcceptanceStripeClient): Promise<AcceptanceReport> {
  const deletedCustomers: string[] = []
  for (const customer of (await client.customers.list({ limit: 100 })).data) {
    if (customer.deleted || !tagged(customer.metadata)) continue
    const verified = await client.customers.retrieve(customer.id)
    if (!verified.deleted && tagged(verified.metadata)) { await client.customers.del(customer.id); deletedCustomers.push(customer.id) }
  }
  const deletedClocks: string[] = []
  for (const clock of (await client.testHelpers.testClocks.list({ limit: 100 })).data) {
    if (!tagged(clock.metadata)) continue
    await client.testHelpers.testClocks.del(clock.id)
    deletedClocks.push(clock.id)
  }
  return { scenario: "cleanup", result: "passed", objects: { deletedCustomers, deletedTestClocks: deletedClocks }, checks: [{ taggedCustomersDeleted: deletedCustomers.length, taggedTestClocksDeleted: deletedClocks.length }] }
}

export async function runAcceptance(args: readonly string[], env: NodeJS.ProcessEnv, client?: AcceptanceStripeClient): Promise<AcceptanceReport> {
  const config = validateAcceptancePreflight(args, env)
  const stripe = client ?? (new Stripe(config.key, { apiVersion: API_VERSION, timeout: 15_000, maxNetworkRetries: 1 }) as unknown as AcceptanceStripeClient)
  if (args.includes("--cleanup")) return cleanupAcceptanceObjects(stripe)
  const scenario = args.find((arg): arg is AcceptanceScenario => ["trial-to-paid", "trial-end-missing-card-pauses", "seat-proration-quotes"].includes(arg))
  if (!scenario) fail("Choose a scenario: trial-to-paid, trial-end-missing-card-pauses, or seat-proration-quotes.")
  const ids = { basePriceId: config.basePriceId, seatPriceId: config.seatPriceId }
  await verifyAcceptancePrices(stripe, ids)
  if (scenario === "trial-to-paid") return runTrialToPaid(stripe, ids)
  if (scenario === "trial-end-missing-card-pauses") return runMissingCard(stripe, ids)
  return runSeatQuotes(stripe, ids)
}

async function main() {
  const report = await runAcceptance(process.argv.slice(2), process.env)
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Stripe acceptance failed."); process.exitCode = 1 })
}
