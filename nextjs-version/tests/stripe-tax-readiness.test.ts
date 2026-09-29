import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateStripeTaxReadiness, formatStripeTaxReadiness, loadStripeTaxFacts, main, parseTaxReadinessConfig,
  type TaxReadinessConfig, type TaxReadinessFacts,
} from "../scripts/stripe/tax-readiness"

const config: TaxReadinessConfig = {
  mode: "test", secretKey: "rk_test_distinctive_secret", priceIds: { base: "price_base", seats: "price_seats" },
  taxBehavior: "exclusive", requiredJurisdictions: ["US-NJ"],
}
const facts = (behavior: "exclusive" | "inclusive" = "exclusive"): TaxReadinessFacts => ({
  settings: { status: "active", livemode: false, headOfficeAddress: true },
  registrations: [{ id: "taxreg_nj", status: "active", livemode: false, jurisdiction: "US-NJ" }],
  prices: ["price_base", "price_seats"].map((id, index) => ({ id, active: true, livemode: false, taxBehavior: behavior, productId: `prod_${index}`, productTaxCode: `txcd_${index}`, productLivemode: false })),
  portalConfigurations: [{ id: "bpc_default", active: true, livemode: false, isDefault: true, customerUpdateEnabled: true, allowedUpdates: ["address", "tax_id"] }],
  readsComplete: true,
})

test("tax readiness is inert for unset and non-exact flags and makes no Stripe calls", async () => {
  for (const flag of [undefined, "", "false", "TRUE", "1"]) {
    let calls = 0, output = ""
    const code = await main([], { MCA_STRIPE_TAX_READINESS_ENABLED: flag }, { stdout: { write: value => { output += value } }, stderr: { write: () => undefined } }, async () => { calls++; throw new Error("must not run") }, () => { throw new Error("must not construct") })
    assert.equal(code, 0); assert.equal(calls, 0); assert.match(output, /disabled/)
  }
})

test("tax readiness parser defaults registrations to US-NJ and validates overrides", () => {
  const env = { MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "rk_test_x", STRIPE_BASE_PRICE_ID: "price_a", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_b", MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }
  assert.deepEqual(parseTaxReadinessConfig([], env).requiredJurisdictions, ["US-NJ"])
  assert.deepEqual(parseTaxReadinessConfig(["--require-registration=us-nj, CA,US-NJ"], env).requiredJurisdictions, ["US-NJ", "CA"])
  assert.throws(() => parseTaxReadinessConfig(["--require-registration="], env))
  assert.throws(() => parseTaxReadinessConfig(["--require-registration=US-NJ", "--require-registration=CA"], env))
  assert.throws(() => parseTaxReadinessConfig(["--require-registration=New Jersey"], env))
})

test("tax readiness evaluator passes active exclusive and inclusive configurations", () => {
  assert.equal(evaluateStripeTaxReadiness(facts(), config).some(check => check.status !== "PASS"), false)
  const inclusive = { ...config, taxBehavior: "inclusive" as const }
  assert.equal(evaluateStripeTaxReadiness(facts("inclusive"), inclusive).some(check => check.status !== "PASS"), false)
})

test("tax readiness evaluator fails required provider invariants independently", () => {
  const mutations: Array<(value: TaxReadinessFacts) => void> = [
    value => { value.settings.status = "pending" }, value => { value.settings.headOfficeAddress = false }, value => { value.settings.livemode = true },
    value => { value.registrations = [] }, value => { value.registrations[0].status = "expired" }, value => { value.registrations[0].jurisdiction = "US-NY" },
    value => { value.prices[0].active = false }, value => { value.prices[0].livemode = true }, value => { value.prices[0].taxBehavior = "inclusive" },
    value => { value.portalConfigurations = [] }, value => { value.portalConfigurations.push({ ...value.portalConfigurations[0], id: "bpc_second" }) },
    value => { value.readsComplete = false },
  ]
  for (const mutate of mutations) { const value = facts(); mutate(value); assert.ok(evaluateStripeTaxReadiness(value, config).some(check => check.status === "FAIL")) }
})

test("tax readiness evaluator warns for missing product tax code and portal customer-update controls", () => {
  const value = facts(); value.prices[0].productTaxCode = null; value.portalConfigurations[0].allowedUpdates = ["address"]
  const checks = evaluateStripeTaxReadiness(value, config)
  assert.equal(checks.some(check => check.status === "FAIL"), false)
  assert.equal(checks.filter(check => check.status === "WARN").length, 2)
  assert.match(formatStripeTaxReadiness(checks), /tax_code=txcd_1/)
})

test("tax readiness loader uses retrieval and list methods only, including pagination", async () => {
  const calls: string[] = []
  const registration = (id: string) => ({ id, status: "active", livemode: false, country: "US", country_options: { us: { state: "NJ" } } })
  let registrationPage = 0, portalPage = 0
  const product = (id: string) => ({ id, livemode: false, tax_code: "txcd_standard" })
  const client = {
    tax: { settings: { retrieve: async () => { calls.push("settings.retrieve"); return { status: "active", livemode: false, head_office: { address: {} } } }, update: () => { throw new Error("write") } }, registrations: { list: async () => { calls.push("registrations.list"); registrationPage++; return { data: [registration(`taxreg_${registrationPage}`)], has_more: registrationPage === 1 } }, create: () => { throw new Error("write") } } },
    prices: { retrieve: async (id: string) => { calls.push("prices.retrieve"); return { id, active: true, livemode: false, tax_behavior: "exclusive", product: product(`prod_${id}`) } }, update: () => { throw new Error("write") } },
    billingPortal: { configurations: { list: async () => { calls.push("portal.list"); portalPage++; return { data: [{ id: `bpc_${portalPage}`, active: true, livemode: false, is_default: portalPage === 1, features: { customer_update: { enabled: true, allowed_updates: ["address", "tax_id"] } } }], has_more: portalPage === 1 } }, retrieve: async () => { throw new Error("not selected") }, update: () => { throw new Error("write") } } },
  }
  const loaded = await loadStripeTaxFacts(client as never, config)
  assert.equal(loaded.readsComplete, true); assert.equal(loaded.registrations.length, 2); assert.equal(loaded.portalConfigurations.length, 2)
  assert.deepEqual(calls, ["settings.retrieve", "registrations.list", "registrations.list", "prices.retrieve", "prices.retrieve", "portal.list", "portal.list"])
})

test("tax readiness exits one on FAIL and zero for PASS or WARN-only summaries", async () => {
  const env = { MCA_STRIPE_TAX_READINESS_ENABLED: "true", MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: config.secretKey, STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats", MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }
  const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined } }
  assert.equal(await main([], env, io, async () => facts(), () => ({} as never)), 0)
  const warning = facts(); warning.prices[0].productTaxCode = null
  assert.equal(await main([], env, io, async () => warning, () => ({} as never)), 0)
  const failure = facts(); failure.settings.status = "pending"
  assert.equal(await main([], env, io, async () => failure, () => ({} as never)), 1)
})

test("tax readiness output never contains secrets or raw provider error details", async () => {
  let output = ""
  const env = { MCA_STRIPE_TAX_READINESS_ENABLED: "true", MCA_STRIPE_MODE: "test", STRIPE_SECRET_KEY: "rk_test_SECRET_VALUE", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats", MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }
  const code = await main([], env, { stdout: { write: value => { output += value } }, stderr: { write: value => { output += value } } }, async () => { throw new Error("Authorization Bearer SECRET_VALUE request req_secret raw body") }, () => ({} as never))
  assert.equal(code, 1)
  for (const secret of ["SECRET_VALUE", "Authorization", "req_secret", "raw body"]) assert.doesNotMatch(output, new RegExp(secret))
})

test("tax readiness prints actionable value-free configuration and provider failures", async () => {
  let output = ""
  const io = { stdout: { write: (value: string) => { output += value } }, stderr: { write: (value: string) => { output += value } } }
  const env = { MCA_STRIPE_TAX_READINESS_ENABLED: "true", MCA_STRIPE_MODE: "live", STRIPE_SECRET_KEY: "rk_live_SECRET_VALUE", STRIPE_BASE_PRICE_ID: "price_base", STRIPE_ADDITIONAL_SEAT_PRICE_ID: "price_seats" }
  assert.equal(await main([], env, io, async () => { throw new Error("must not load") }, () => { throw new Error("must not construct") }), 1)
  assert.match(output, /FAIL configuration: MCA_STRIPE_TAX_BEHAVIOR must be explicitly exclusive or inclusive\./)
  output = ""
  const providerError = Object.assign(new Error("Bearer SECRET_VALUE req_123 raw"), { type: "StripePermissionError", code: "secret_code_SECRET_VALUE" })
  const permission = Object.assign(new Error("Bearer SECRET_VALUE req_123 raw"), { type: "permission_error" })
  assert.equal(await main([], { ...env, MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }, io, async () => { throw permission }, () => ({} as never)), 1)
  assert.match(output, /FAIL provider check: provider read failed \(type=permission_error\)/)
  output = ""
  assert.equal(await main([], { ...env, MCA_STRIPE_TAX_BEHAVIOR: "exclusive" }, io, async () => { throw providerError }, () => ({} as never)), 1)
  assert.match(output, /FAIL provider check: provider read failed;/)
  for (const secret of ["SECRET_VALUE", "req_123", "Bearer"]) assert.doesNotMatch(output, new RegExp(secret))
})
