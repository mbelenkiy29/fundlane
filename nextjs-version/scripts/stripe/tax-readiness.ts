import { pathToFileURL } from "node:url"
import Stripe from "stripe"
import { readPriceIds, readStripeSecretKey, stripeSecretKeyPattern } from "../../src/lib/mca/stripe-checkout-trial"
import type { StripeTaxBehavior } from "../../src/lib/mca/billing-tax"

export type TaxReadinessStatus = "PASS" | "FAIL" | "WARN"
export interface TaxReadinessCheck { name: string; status: TaxReadinessStatus; detail: string }
export interface TaxReadinessConfig {
  mode: "test" | "live"
  secretKey: string
  priceIds: { base: string; seats: string }
  taxBehavior: StripeTaxBehavior
  requiredJurisdictions: string[]
  portalConfigurationId?: string
}
export interface TaxReadinessFacts {
  settings: { status: string; livemode: boolean; headOfficeAddress: boolean }
  registrations: Array<{ id: string; status: string; livemode: boolean; jurisdiction: string }>
  prices: Array<{ id: string; active: boolean; livemode: boolean; taxBehavior: string | null; productId: string; productTaxCode: string | null; productLivemode?: boolean }>
  portalConfigurations: Array<{ id: string; active: boolean; livemode: boolean; isDefault: boolean; customerUpdateEnabled: boolean; allowedUpdates: string[] }>
  readsComplete: boolean
}

const MAX_PAGES = 20
const DISABLED = "Stripe Tax readiness is disabled. Set MCA_STRIPE_TAX_READINESS_ENABLED=true to permit read-only Stripe checks.\n"
const JURISDICTION = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/

/** Configuration errors carry only static, value-free messages, so they are safe to print. */
class TaxReadinessConfigError extends Error {}
const SAFE_TOKEN = /^[a-z_]{1,64}$/
/** Stripe error type/code are enum-like tokens; never print messages, request IDs or raw bodies. */
function providerFailureDetail(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {}
  const parts = (["type", "code"] as const).flatMap(key => typeof record[key] === "string" && SAFE_TOKEN.test(record[key] as string) ? [`${key}=${record[key]}`] : [])
  return `provider read failed${parts.length ? ` (${parts.join("; ")})` : ""}; check the key's read permissions and mode`
}

export function parseTaxReadinessConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): TaxReadinessConfig {
  const mode = env.MCA_STRIPE_MODE
  if (mode !== "test" && mode !== "live") throw new TaxReadinessConfigError("MCA_STRIPE_MODE must be test or live.")
  const secretKey = readStripeSecretKey(env)
  if (!secretKey || !stripeSecretKeyPattern(mode === "live").test(secretKey)) throw new TaxReadinessConfigError("STRIPE_SECRET_KEY must match MCA_STRIPE_MODE.")
  const priceIds = readPriceIds(env)
  if (!priceIds) throw new TaxReadinessConfigError("Both distinct Stripe Price IDs must be configured.")
  const behavior = env.MCA_STRIPE_TAX_BEHAVIOR?.trim()
  if (behavior !== "exclusive" && behavior !== "inclusive") throw new TaxReadinessConfigError("MCA_STRIPE_TAX_BEHAVIOR must be explicitly exclusive or inclusive.")
  const registrationArgs = argv.filter(value => value.startsWith("--require-registration="))
  if (registrationArgs.length > 1) throw new TaxReadinessConfigError("--require-registration may be supplied at most once.")
  const raw = registrationArgs[0]?.slice("--require-registration=".length) ?? "US-NJ"
  const tokens = raw.split(",").map(value => value.trim().toUpperCase())
  if (tokens.some(value => !value || !JURISDICTION.test(value))) throw new TaxReadinessConfigError("Required registrations must be nonempty canonical jurisdiction tokens.")
  const unknown = argv.find(value => !value.startsWith("--require-registration="))
  if (unknown) throw new TaxReadinessConfigError("Unknown tax-readiness argument.")
  return {
    mode, secretKey, priceIds, taxBehavior: behavior,
    requiredJurisdictions: [...new Set(tokens)],
    portalConfigurationId: env.STRIPE_BILLING_PORTAL_CONFIGURATION?.trim() || undefined,
  }
}

export function evaluateStripeTaxReadiness(facts: TaxReadinessFacts, config: Omit<TaxReadinessConfig, "secretKey">): TaxReadinessCheck[] {
  const checks: TaxReadinessCheck[] = []
  const add = (name: string, status: TaxReadinessStatus, detail: string) => checks.push({ name, status, detail })
  const expectedLive = config.mode === "live"
  add("provider reads complete", facts.readsComplete ? "PASS" : "FAIL", facts.readsComplete ? "all bounded reads completed" : "provider results were incomplete or ambiguous")
  add("Tax settings active", facts.settings.status === "active" ? "PASS" : "FAIL", `status=${facts.settings.status}`)
  add("Tax head office", facts.settings.headOfficeAddress ? "PASS" : "FAIL", facts.settings.headOfficeAddress ? "address is configured" : "head-office address is missing")
  add("Tax settings mode", facts.settings.livemode === expectedLive ? "PASS" : "FAIL", facts.settings.livemode === expectedLive ? `mode=${config.mode}` : "mode mismatch")
  for (const jurisdiction of config.requiredJurisdictions) {
    const matches = facts.registrations.filter(item => item.jurisdiction === jurisdiction && item.status === "active" && item.livemode === expectedLive)
    add(`registration ${jurisdiction}`, matches.length === 1 ? "PASS" : "FAIL", matches.length === 1 ? `id=${matches[0].id}; status=active` : matches.length ? "multiple active registrations" : "active same-mode registration missing")
  }
  for (const price of facts.prices) {
    add(`Price ${price.id}`, price.active && price.livemode === expectedLive && price.taxBehavior === config.taxBehavior ? "PASS" : "FAIL",
      `active=${price.active}; mode=${price.livemode ? "live" : "test"}; tax_behavior=${price.taxBehavior ?? "missing"}`)
    const productModeMatches = price.productLivemode === undefined || price.productLivemode === expectedLive
    if (!productModeMatches) add(`Product ${price.productId} mode`, "FAIL", "mode mismatch")
    add(`Product ${price.productId} tax code`, price.productTaxCode ? "PASS" : "WARN", price.productTaxCode ? `tax_code=${price.productTaxCode}` : "tax code is missing")
  }
  if (facts.prices.length !== 2) add("configured Prices", "FAIL", "both configured Prices must be retrieved")
  const portals = config.portalConfigurationId
    ? facts.portalConfigurations.filter(item => item.id === config.portalConfigurationId)
    : facts.portalConfigurations.filter(item => item.active && item.isDefault)
  if (portals.length !== 1) add("Customer Portal selection", "FAIL", config.portalConfigurationId ? "configured Portal was not retrieved uniquely" : "exactly one active default Portal is required")
  else {
    const portal = portals[0]
    add(`Portal ${portal.id}`, portal.active && portal.livemode === expectedLive ? "PASS" : "FAIL", `active=${portal.active}; mode=${portal.livemode ? "live" : "test"}`)
    const controls = portal.customerUpdateEnabled && portal.allowedUpdates.includes("address") && portal.allowedUpdates.includes("tax_id")
    add(`Portal ${portal.id} customer updates`, controls ? "PASS" : "WARN", controls ? "address and tax_id updates are allowed" : "enable customer address and tax_id updates")
  }
  for (const registration of facts.registrations) if (registration.livemode !== expectedLive)
    add(`registration ${registration.id} mode`, "FAIL", "mode mismatch")
  return checks
}

export function formatStripeTaxReadiness(checks: readonly TaxReadinessCheck[]): string {
  const counts = { PASS: 0, FAIL: 0, WARN: 0 }
  for (const check of checks) counts[check.status]++
  const overall = counts.FAIL ? "FAIL" : counts.WARN ? "WARN" : "PASS"
  return `${checks.map(check => `${check.status} ${check.name}: ${check.detail}`).join("\n")}\nSummary: PASS=${counts.PASS} FAIL=${counts.FAIL} WARN=${counts.WARN}\nStripe Tax readiness: ${overall}\n`
}

type ReadStripe = Pick<Stripe, "tax" | "prices" | "billingPortal">

function registrationJurisdiction(registration: Stripe.Tax.Registration): string {
  const country = registration.country.toUpperCase()
  if (country === "US" && registration.country_options.us?.state) return `US-${registration.country_options.us.state.toUpperCase()}`
  return country
}

export async function loadStripeTaxFacts(client: ReadStripe, config: TaxReadinessConfig): Promise<TaxReadinessFacts> {
  const settings = await client.tax.settings.retrieve()
  const registrations: TaxReadinessFacts["registrations"] = []
  let startingAfter: string | undefined
  let readsComplete = true
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await client.tax.registrations.list({ status: "active", limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    registrations.push(...response.data.map(item => ({ id: item.id, status: item.status, livemode: item.livemode, jurisdiction: registrationJurisdiction(item) })))
    if (!response.has_more) { startingAfter = undefined; break }
    startingAfter = response.data.at(-1)?.id
    if (!startingAfter || page === MAX_PAGES - 1) { readsComplete = false; break }
  }
  const stripePrices = await Promise.all([config.priceIds.base, config.priceIds.seats].map(id => client.prices.retrieve(id, { expand: ["product"] })))
  const prices = stripePrices.map(price => {
    const product = typeof price.product === "string" || price.product.deleted ? null : price.product
    return { id: price.id, active: price.active, livemode: price.livemode, taxBehavior: price.tax_behavior, productId: typeof price.product === "string" ? price.product : price.product.id, productTaxCode: product ? (typeof product.tax_code === "string" ? product.tax_code : product.tax_code?.id ?? null) : null, productLivemode: product?.livemode }
  })
  let portalConfigurations: TaxReadinessFacts["portalConfigurations"] = []
  if (config.portalConfigurationId) {
    const portal = await client.billingPortal.configurations.retrieve(config.portalConfigurationId)
    portalConfigurations = [portalFact(portal)]
  } else {
    startingAfter = undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.billingPortal.configurations.list({ active: true, is_default: true, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
      portalConfigurations.push(...response.data.map(portalFact))
      if (!response.has_more) { startingAfter = undefined; break }
      startingAfter = response.data.at(-1)?.id
      if (!startingAfter || page === MAX_PAGES - 1) { readsComplete = false; break }
    }
  }
  return { settings: { status: settings.status, livemode: settings.livemode, headOfficeAddress: Boolean(settings.head_office?.address) }, registrations, prices, portalConfigurations, readsComplete }
}

function portalFact(portal: Stripe.BillingPortal.Configuration): TaxReadinessFacts["portalConfigurations"][number] {
  return { id: portal.id, active: portal.active, livemode: portal.livemode, isDefault: portal.is_default, customerUpdateEnabled: portal.features.customer_update.enabled, allowedUpdates: [...portal.features.customer_update.allowed_updates] }
}

interface Writer { write(value: string): unknown }
export async function main(
  argv = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: { stdout: Writer; stderr: Writer } = { stdout: process.stdout, stderr: process.stderr },
  loader: (client: ReadStripe, config: TaxReadinessConfig) => Promise<TaxReadinessFacts> = loadStripeTaxFacts,
  clientFactory: (key: string) => ReadStripe = key => new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15_000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() }),
): Promise<number> {
  if (env.MCA_STRIPE_TAX_READINESS_ENABLED !== "true") { io.stdout.write(DISABLED); return 0 }
  let config: TaxReadinessConfig
  try { config = parseTaxReadinessConfig(argv, env) }
  catch (error) {
    const detail = error instanceof TaxReadinessConfigError ? error.message : "configuration could not be parsed"
    io.stderr.write(formatStripeTaxReadiness([{ name: "configuration", status: "FAIL", detail }]))
    return 1
  }
  try {
    const facts = await loader(clientFactory(config.secretKey), config)
    const checks = evaluateStripeTaxReadiness(facts, config)
    io.stdout.write(formatStripeTaxReadiness(checks))
    return checks.some(check => check.status === "FAIL") ? 1 : 0
  } catch (error) {
    io.stderr.write(formatStripeTaxReadiness([{ name: "provider check", status: "FAIL", detail: providerFailureDetail(error) }]))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().then(code => { process.exitCode = code })
