import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import Stripe from "stripe"
import { BILLING_CATALOG } from "../../src/lib/mca/billing-catalog"

// Optional external browser module keeps acceptance tooling out of production deps.
async function main() {
  const evidencePath = process.argv.find(arg => arg.startsWith("--evidence="))?.slice(11)
  const key = process.env.STRIPE_SECRET_KEY
  assert.ok(process.argv.includes("--apply") && evidencePath)
  assert.ok(key && /^(rk|sk)_test_/.test(key) && process.env.MCA_STRIPE_MODE === "test")
  const browserModule = process.env.MCA_ACCEPTANCE_PLAYWRIGHT_MODULE
  assert.ok(browserModule)
  const { chromium } = await import(browserModule)
  const stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15000, maxNetworkRetries: 1 })
  const account = (await stripe.accounts.retrieve(null)).id
  assert.equal(account, "acct_1UIDeIBP3qJwlwms")
  const admin = new URL(process.env.MCA_TEST_DATABASE_ADMIN_URL ?? "invalid:")
  assert.equal(admin.hostname, "127.0.0.1"); assert.equal(admin.port, "55439"); assert.equal(admin.search, "")
  const run = `fundlane-hosted-${randomUUID()}`
  const e = { account, run, result: "running", stage: "setup", checks: [] as string[], ids: {} as Record<string, string>, cleanup: [] as string[] }
  await writeFile(evidencePath, JSON.stringify(e, null, 2), { flag: "wx", mode: 0o600 })
  const save = () => writeFile(evidencePath, JSON.stringify(e, null, 2), { mode: 0o600 })
  const browser = await chromium.launch({ headless: true, executablePath: process.env.MCA_ACCEPTANCE_CHROME })
  const page = await browser.newPage()
  const browserErrors: string[] = []
  page.on("pageerror", (error: Error) => browserErrors.push(error.message))
  page.on("requestfailed", (request: { url(): string; failure(): { errorText: string } | null }) => browserErrors.push(`${new URL(request.url()).hostname}: ${request.failure()?.errorText}`))
  page.setDefaultTimeout(20000)
  let database: Awaited<ReturnType<typeof import("../../tests/helpers/postgres-test-db.mjs").createPostgresTestDatabase>> | undefined
  let closeApp: (() => Promise<void>) | undefined
  try {
    const { createPostgresTestDatabase } = await import("../../tests/helpers/postgres-test-db.mjs")
    database = await createPostgresTestDatabase("stripe_hosted")
    e.ids.database = database.databaseName
    Object.assign(process.env, { DATABASE_URL: database.databaseUrl, DATABASE_URL_UNPOOLED: database.databaseUrlUnpooled, MCA_STRIPE_BILLING_ENABLED: "true", MCA_APP_ORIGIN: "http://127.0.0.1:3000" })
    const billing = await import("../../src/lib/mca/billing")
    const { getDatabase, closeDatabaseForTests, nowIso } = await import("../../src/lib/mca/db")
    closeApp = closeDatabaseForTests
    const { createWorkspaceWithAdmin } = await import("../../src/lib/mca/workspaces")
    const { getCompanyAccess } = await import("../../src/lib/mca/company-access")
    const metadata = { application: "fundlane", acceptance_run: run }
    const product = await stripe.products.create({ name: run, metadata, tax_code: "txcd_10103001" })
    e.ids.product = product.id; await save()
    const price = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: BILLING_CATALOG.base.unitAmountCents, recurring: { interval: "month" }, metadata })
    e.ids.price = price.id; await save()
    const seats = await stripe.prices.create({ product: product.id, currency: "usd", billing_scheme: "tiered", tiers_mode: "graduated", recurring: { interval: "month" }, tiers: BILLING_CATALOG.additionalSeats.tiers.map(tier => ({ up_to: tier.upTo ?? "inf", unit_amount: tier.unitAmountCents })), metadata })
    e.ids.seats = seats.id; await save()
    process.env.STRIPE_BASE_PRICE_ID = price.id
    process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID = seats.id
    const local = await createWorkspaceWithAdmin({ workspaceName: run, adminName: "Synthetic hosted owner", adminEmail: `${run}@example.test`, password: `${randomUUID()}aA9!`, role: "admin" })
    e.ids.workspace = local.workspaceId
    const customer = await stripe.customers.create({ name: "Synthetic Fundlane Acceptance", email: `${run}@example.test`, metadata })
    e.ids.customer = customer.id; await save()
    await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,0,?)").run(local.workspaceId, customer.id, nowIso())
    const checkout = await billing.createBillingCheckout(local.workspaceId, 2, false, stripe)
    const session = (await stripe.checkout.sessions.list({ customer: customer.id, limit: 10 })).data.find(item => item.status === "open")
    assert.ok(session)
    e.ids.checkout = session.id; await save()
    assert.ok(checkout.url)
    e.stage = "hosted Checkout load"
    await save(); console.log(e.stage)
    await page.goto(checkout.url, { waitUntil: "domcontentloaded" })
    e.stage = "select card payment method"
    await save(); console.log(e.stage)
    await page.getByRole("button", { name: "Pay with card", exact: true }).dispatchEvent("click")
    e.stage = "fill hosted card fields"
    await save(); console.log(e.stage)
    await page.locator('input[name="cardNumber"]').fill("4000000000003220", { timeout: 45000 })
    await page.locator('input[name="cardExpiry"]').fill("1230")
    await page.locator('input[name="cardCvc"]').fill("123")
    await page.locator('input[name="billingName"]').fill("Synthetic Fundlane Acceptance")
    if (await page.locator('input[name="billingPostalCode"]').isVisible()) await page.locator('input[name="billingPostalCode"]').fill("10001")
    if (await page.locator('input[name="billingAddressLine1"]').isVisible()) {
      await page.locator('input[name="billingAddressLine1"]').fill("123 Test Street")
      await page.locator('input[name="billingLocality"]').fill("New York")
      await page.locator('[name="billingAdministrativeArea"]').selectOption("NY")
    }
    await page.locator('#enableStripePass').uncheck()
    await page.keyboard.press("Escape")
    await page.locator('input[name="billingName"]').click()
    e.stage = "hosted Checkout submit and 3DS"
    await save(); console.log(e.stage)
    await page.locator('button[type="submit"]').click()
    let challenge = false
    for (let i = 0; i < 120 && !challenge; i++) {
      for (const frame of page.frames()) {
        const complete = frame.getByRole("button", { name: /^Complete(?: authentication)?$/i })
        if (await complete.isVisible().catch(() => false)) { await complete.click(); challenge = true; break }
      }
      if (!challenge) await sleep(500)
    }
    assert.ok(challenge, "Hosted challenge must be observed")
    e.checks.push("real hosted 3DS challenge completed")
    await save(); console.log(e.checks.at(-1))
    let completed = await stripe.checkout.sessions.retrieve(session.id)
    for (let i = 0; i < 60 && completed.payment_status !== "paid"; i++) { await sleep(1000); completed = await stripe.checkout.sessions.retrieve(session.id) }
    assert.equal(completed.status, "complete"); assert.equal(completed.payment_status, "paid")
    const subscriptionId = typeof completed.subscription === "string" ? completed.subscription : completed.subscription?.id
    assert.ok(subscriptionId); e.ids.subscription = subscriptionId
    assert.equal((await stripe.subscriptions.retrieve(subscriptionId)).billing_mode.type, "flexible")
    await billing.syncWorkspaceBilling(local.workspaceId, stripe)
    assert.equal((await getCompanyAccess(local.workspaceId)).allowed, true)
    assert.equal((await getCompanyAccess(local.workspaceId)).seatLimit, 2)
    e.checks.push("provider-confirmed hosted Checkout creates flexible subscription and grants two seats after application reconciliation")
    await save(); console.log(e.checks.at(-1))
    e.stage = "hosted Portal paused cancellation"
    assert.ok((await stripe.billingPortal.configurations.list({ limit: 1 })).data.length)
    const config = await stripe.billingPortal.configurations.create({ metadata, features: { payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: "at_period_end" } } })
    e.ids.portal = config.id; await save()
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION = config.id
    const { setPlatformCompanyAccess } = await import("../../src/lib/mca/billing-operations")
    await setPlatformCompanyAccess(local.workspaceId, local.userId, { manualPaused: true, reason: "Synthetic hosted acceptance" })
    const portal = await billing.createBillingPortal(local.workspaceId, false, stripe)
    await page.goto(portal.url, { waitUntil: "domcontentloaded" })
    await page.getByText(/Cancel subscription/i, { exact: true }).first().click()
    await page.getByRole("button", { name: /Cancel subscription/i }).last().click()
    let canceled = await stripe.subscriptions.retrieve(subscriptionId)
    for (let i = 0; i < 30 && !canceled.cancel_at_period_end; i++) { await sleep(1000); canceled = await stripe.subscriptions.retrieve(subscriptionId) }
    assert.equal(canceled.cancel_at_period_end, true)
    await billing.syncWorkspaceBilling(local.workspaceId, stripe)
    assert.equal((await getCompanyAccess(local.workspaceId)).reason, "manual_suspension")
    e.checks.push("hosted Portal cancellation works while company manually paused and preserves suspension")
    e.result = "passed"
  } catch (error) {
    e.result = "blocked-or-failed"
    await writeFile(`${evidencePath}.failure.txt`, error instanceof Error ? error.message : "Unknown failure", { mode: 0o600 })
    await writeFile(`${evidencePath}.page.txt`, await page.locator("body").innerText().catch(() => "Page unavailable"), { mode: 0o600 })
    await writeFile(`${evidencePath}.errors.json`, JSON.stringify(browserErrors, null, 2), { mode: 0o600 })
    await page.screenshot({ path: `${evidencePath}.png`, fullPage: true })
    const fields = []
    for (const frame of page.frames()) fields.push(await frame.locator("input,select,button,iframe").evaluateAll((els: Element[]) => els.map(el => ({ tag: el.tagName, name: el.getAttribute("name"), id: el.id, type: el.getAttribute("type"), text: el.tagName === "BUTTON" ? el.textContent : undefined }))).catch(() => []))
    await writeFile(`${evidencePath}.fields.json`, JSON.stringify(fields, null, 2), { mode: 0o600 })
    console.error(JSON.stringify({ stage: e.stage, type: error instanceof Error ? error.name : "unknown" }))
    process.exitCode = 1
  } finally {
    await browser.close()
    const clean = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); e.cleanup.push(name) } catch { e.cleanup.push(`${name}: FAILED`); process.exitCode = 1 } }
    await clean("owned Checkout expired or complete", async () => { if (e.ids.checkout && (await stripe.checkout.sessions.retrieve(e.ids.checkout)).status === "open") await stripe.checkout.sessions.expire(e.ids.checkout) })
    await clean("owned customer deleted", async () => { if (e.ids.customer) { const customer = await stripe.customers.retrieve(e.ids.customer); assert.ok(!customer.deleted && customer.metadata.acceptance_run === run); await stripe.customers.del(customer.id) } })
    await clean("owned Portal deactivated", async () => { if (e.ids.portal) { const config = await stripe.billingPortal.configurations.retrieve(e.ids.portal); assert.equal(config.metadata?.acceptance_run, run); assert.equal(config.is_default, false); await stripe.billingPortal.configurations.update(config.id, { active: false }) } })
    await clean("owned catalog archived", async () => { if (e.ids.product) { assert.equal((await stripe.products.retrieve(e.ids.product)).metadata.acceptance_run, run); for await (const price of stripe.prices.list({ product: e.ids.product, limit: 100 })) await stripe.prices.update(price.id, { active: false }); await stripe.products.update(e.ids.product, { active: false }) } })
    await clean("disposable database dropped", async () => { await closeApp?.(); await database?.close() })
    await save()
    console.log(JSON.stringify({ result: e.result, stage: e.stage, cleanup: e.cleanup }))
  }
}
main().catch(() => { console.error("Hosted acceptance preflight failed; secret-bearing details suppressed"); process.exitCode = 1 })
