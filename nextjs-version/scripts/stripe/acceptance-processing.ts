#!/usr/bin/env -S node --conditions=react-server --import tsx
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { mock } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import Stripe from "stripe"

// Standalone provider acceptance. No application/provider responses are mocked.
const ACCOUNT = "acct_1UIDeIBP3qJwlwms"
async function main() {
  if (process.argv.includes("--help")) {
    console.log("Run from nextjs-version: node --conditions=react-server --import tsx scripts/stripe/acceptance-processing.ts --apply --evidence=/private/path/new.json\nRequires explicit STRIPE_SECRET_KEY, MCA_STRIPE_MODE=test, MCA_TEST_DATABASE_ADMIN_URL at loopback port 55439. Automatically cleans only run-owned resources."); return
  }
  const path = process.argv.find(a => a.startsWith("--evidence="))?.slice(11)
  const scenarios = (process.argv.find(a => a.startsWith("--scenarios="))?.slice(12) ?? "sca,processing,insufficient").split(",")
  assert.ok(scenarios.length > 0 && scenarios.every(s => ["sca", "processing", "processing-zero", "insufficient"].includes(s)))
  assert.ok(process.argv.includes("--apply") && path)
  const key = process.env.STRIPE_SECRET_KEY!
  assert.equal(process.env.MCA_STRIPE_MODE, "test"); assert.match(key ?? "", /^(sk|rk)_test_/)
  const url = new URL(process.env.MCA_TEST_DATABASE_ADMIN_URL ?? "invalid:")
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) && url.port === "55439" && !url.search)
  const stripe = new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15000, maxNetworkRetries: 1 })
  assert.equal((await stripe.accounts.retrieve(null)).id, ACCOUNT)
  const run = `fundlane-processing-${randomUUID()}`
  const evidence: { run: string; account: string; checks: Array<Record<string, unknown>>; clocks: string[]; intents: string[]; product?: string; configuration?: string; cleaned?: boolean } = { run, account: ACCOUNT, checks: [], clocks: [], intents: [] }
  await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx", mode: 0o600 })
  const save = () => writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 })
  const check = async (name: string, data: Record<string, unknown> = {}) => { evidence.checks.push({ name, ...data }); await save(); console.log(name) }
  const diagnostic = (error: unknown) => error instanceof Stripe.errors.StripeError ? { type: error.type, code: error.code, request: error.requestId, param: error.param, message: error.message.replaceAll(key, "[redacted]").replace(/https?:\/\/\S+/g, "[url]") } : { type: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.replaceAll(key, "[redacted]") : "unknown" }
  let database: Awaited<ReturnType<typeof import("../../tests/helpers/postgres-test-db.mjs").createPostgresTestDatabase>> | undefined
  let closeApp: (() => Promise<void>) | undefined
  try {
    const configuration = await stripe.paymentMethodConfigurations.create({ name: run, us_bank_account: { display_preference: { preference: "on" } } })
    evidence.configuration = configuration.id; await save()
    assert.equal(configuration.livemode, false)
    await check("isolated_payment_configuration", { configuration: configuration.id, bank: configuration.us_bank_account })
    const { createPostgresTestDatabase } = await import("../../tests/helpers/postgres-test-db.mjs")
    database = await createPostgresTestDatabase("stripe_processing")
    Object.assign(process.env, { DATABASE_URL: database.databaseUrl, DATABASE_URL_UNPOOLED: database.databaseUrlUnpooled, MCA_STRIPE_BILLING_ENABLED: "true" })
    const billing = await import("../../src/lib/mca/billing")
    const { getDatabase, closeDatabaseForTests, nowIso } = await import("../../src/lib/mca/db")
    closeApp = closeDatabaseForTests
    const { createWorkspaceWithAdmin } = await import("../../src/lib/mca/workspaces")
    const { getCompanyAccess } = await import("../../src/lib/mca/company-access")
    const metadata = { acceptance_run: run }
    const product = await stripe.products.create({ name: run, metadata }); evidence.product = product.id; await save()
    const base = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: 39900, recurring: { interval: "month" }, metadata })
    const seats = await stripe.prices.create({ product: product.id, currency: "usd", billing_scheme: "tiered", tiers_mode: "graduated", recurring: { interval: "month" }, tiers: [{ up_to: 9, unit_amount: 7900 }, { up_to: 19, unit_amount: 6900 }, { up_to: "inf", unit_amount: 5900 }], metadata })
    process.env.STRIPE_BASE_PRICE_ID = base.id; process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID = seats.id
    await billing.verifyBillingPrices(stripe)
    const start = Math.floor(Date.now() / 1000)
    mock.timers.enable({ apis: ["Date"], now: start * 1000 })
    for (const scenario of scenarios) {
      mock.timers.setTime(start * 1000)
      const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: `${run}-${scenario}` }); evidence.clocks.push(clock.id); await save()
      async function advance(target: number) {
        await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: target })
        for (let i = 0; i < 120; i++) {
          const current = await stripe.testHelpers.testClocks.retrieve(clock.id)
          if (current.status === "ready") { mock.timers.setTime(target * 1000); return }
          assert.notEqual(current.status, "internal_failure"); await sleep(1000)
        }
        throw new Error("Test clock timeout")
      }
      const local = await createWorkspaceWithAdmin({ workspaceName: `${run}-${scenario}`, adminName: "Synthetic owner", adminEmail: `${run}-${scenario}@example.test`, password: randomUUID() + "aA9!", role: "admin" })
      const customer = await stripe.customers.create({ name: `${run}-${scenario}`, test_clock: clock.id, metadata: { ...metadata, workspace_id: local.workspaceId } })
      await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,0,?)").run(local.workspaceId, customer.id, nowIso())
      const good = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } })
      const sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: base.id }], billing_mode: { type: "flexible" }, payment_behavior: "error_if_incomplete", metadata })
      const sync = () => billing.syncWorkspaceBilling(local.workspaceId, stripe)
      const access = () => getCompanyAccess(local.workspaceId)
      const state = async () => (await database!.query("SELECT grace_ends_at,processing_extension_until,processing_extension_granted_at FROM company_subscription_state WHERE workspace_id=$1", [local.workspaceId])).rows[0]
      await sync(); assert.equal((await access()).seatLimit, 1)
      const failing = await stripe.paymentMethods.attach(scenario === "sca" ? "pm_card_threeDSecure2Required" : "pm_card_chargeCustomerFail", { customer: customer.id })
      await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: failing.id } })
      if (scenario === "sca") {
        await billing.changeBillingSeats(local.workspaceId, 2, local.userId, stripe)
        await sync(); assert.equal((await access()).seatLimit, 1)
        const pendingSub = await stripe.subscriptions.retrieve(sub.id)
        assert.ok(pendingSub.pending_update)
        const seatInvoice = typeof pendingSub.latest_invoice === "string" ? pendingSub.latest_invoice : pendingSub.latest_invoice!.id
        const seatPayments = await stripe.invoicePayments.list({ invoice: seatInvoice })
        const seatIntent = seatPayments.data.find(p => p.payment.type === "payment_intent")?.payment.payment_intent
        assert.ok(seatIntent)
        const seatPi = await stripe.paymentIntents.retrieve(typeof seatIntent === "string" ? seatIntent : seatIntent.id)
        assert.equal(seatPi.status, "requires_action")
        await check("sca_unpaid_seat_increase_not_granted", { subscription: sub.id, invoice: seatInvoice, paymentIntent: seatPi.id, status: seatPi.status, seatLimit: (await access()).seatLimit })
      }
      if (scenario === "processing-zero") await stripe.subscriptions.update(sub.id, { pause_collection: { behavior: "keep_as_draft" } })
      await advance(sub.items.data[0].current_period_end + 3600)
      let invoice = (await stripe.invoices.list({ subscription: sub.id, customer: customer.id, limit: 100 })).data.find(i => i.billing_reason === "subscription_cycle")!
      assert.ok(invoice)
      if (invoice.status === "draft") invoice = await stripe.invoices.finalizeInvoice(invoice.id, scenario === "processing-zero" ? { auto_advance: false } : {})
      if (scenario === "processing-zero") await stripe.subscriptions.update(sub.id, { pause_collection: "" })
      else {
        try { await stripe.invoices.pay(invoice.id, { payment_method: failing.id, off_session: false }) } catch (error) { if (!(error instanceof Stripe.errors.StripeCardError)) throw error }
        await sync()
      }
      const before = await state()
      const observed = await stripe.invoices.retrieve(invoice.id)
      await check(`${scenario}_renewal_observed`, { invoice: invoice.id, state: before, providerStatus: observed.status, attemptCount: observed.attempt_count, finalizedAt: observed.status_transitions.finalized_at })
      if (scenario !== "processing-zero") assert.ok(before.grace_ends_at)
      else assert.equal(observed.attempt_count, 0)
      if (scenario === "sca") {
        const payments = await stripe.invoicePayments.list({ invoice: invoice.id })
        const id = payments.data.find(p => p.payment.type === "payment_intent")?.payment.payment_intent
        assert.ok(id)
        const pi = await stripe.paymentIntents.retrieve(typeof id === "string" ? id : id.id)
        assert.equal(pi.status, "requires_action")
        assert.equal(observed.attempt_count, 0)
        assert.equal(Date.parse(before.grace_ends_at), observed.status_transitions.finalized_at! * 1000 + 7 * 86400000)
        assert.equal(before.processing_extension_until, null); assert.equal(before.processing_extension_granted_at, null)
        await check("sca_real_invoice_requires_action_no_extension", { invoice: invoice.id, paymentIntent: pi.id, status: pi.status, state: before })
        await advance(Date.parse(before.grace_ends_at) / 1000); await sync(); assert.equal((await access()).allowed, false)
        await check("sca_cutoff_rejected", { state: await state() })
        continue
      }
      try {
        if (scenario === "insufficient") {
          // A real unpaid proration alongside the failed renewal, not a fabricated invoice.
          const updated = await stripe.subscriptions.update(sub.id, { items: [{ price: seats.id, quantity: 1 }], proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete" })
          assert.ok(updated.pending_update)
          const prorationId = typeof updated.latest_invoice === "string" ? updated.latest_invoice : updated.latest_invoice!.id
          const proration = await stripe.invoices.retrieve(prorationId)
          assert.notEqual(proration.id, invoice.id); assert.equal(proration.status, "open"); assert.ok(proration.amount_remaining > 0)
          assert.equal(proration.billing_reason, "subscription_update")
          await sync()
          assert.equal((await access()).seatLimit, 1)
          await check("insufficient_total_debt_two_genuine_open_invoices", { renewal: invoice.id, renewalRemaining: invoice.amount_remaining, proration: proration.id, prorationRemaining: proration.amount_remaining, subscription: sub.id })
        }
        const bank = await stripe.paymentMethods.attach("pm_usBankAccount_processing", { customer: customer.id })
        const pi = await stripe.paymentIntents.create({ customer: customer.id, amount: invoice.amount_remaining, currency: "usd", payment_method: bank.id, payment_method_configuration: configuration.id, automatic_payment_methods: { enabled: true, allow_redirects: "never" }, confirm: true, mandate_data: { customer_acceptance: { type: "offline" } }, metadata })
        evidence.intents.push(pi.id); await save()
        assert.equal(pi.status, "processing")
        await stripe.invoices.attachPayment(invoice.id, { payment_intent: pi.id })
        const allocations = await stripe.invoicePayments.list({ invoice: invoice.id })
        await check(`${scenario}_provider_allocation`, { paymentIntent: pi.id, status: pi.status, amount: pi.amount, invoice: invoice.id, payments: allocations.data.map(p => ({ id: p.id, amountRequested: p.amount_requested, status: p.status, payment: p.payment })) })
        await sync()
        const after = await state()
        if (scenario === "processing" || scenario === "processing-zero") {
          if (scenario === "processing-zero") {
            const current = await stripe.invoices.retrieve(invoice.id)
            assert.equal(current.attempt_count, 0)
            assert.equal(Date.parse(after.grace_ends_at), current.status_transitions.finalized_at! * 1000 + 7 * 86400000)
          }
          assert.ok(after.processing_extension_until); assert.ok(after.processing_extension_granted_at)
          assert.equal(Date.parse(after.processing_extension_until) - Date.parse(after.grace_ends_at), 2 * 86400000)
          await advance(Date.parse(after.grace_ends_at) / 1000); await sync(); assert.equal((await access()).allowed, true)
          assert.deepEqual(await state(), after)
        } else {
          assert.equal(after.processing_extension_until, null); assert.equal(after.processing_extension_granted_at, null)
          // Observe the live unpaid proration immediately; pending updates may expire before grace.
          assert.equal((await access()).seatLimit, 1)
        }
        await check(`${scenario}_real_invoice_payment`, { invoice: invoice.id, paymentIntent: pi.id, amount: pi.amount, status: pi.status, state: after, accessAllowed: (await access()).allowed })
        if (scenario === "processing" || scenario === "processing-zero") {
          const canceled = await stripe.paymentIntents.cancel(pi.id)
          assert.equal(canceled.status, "canceled")
          await sync()
          const revoked = await state()
          assert.equal(revoked.processing_extension_until, null)
          assert.equal(revoked.processing_extension_granted_at, after.processing_extension_granted_at)
          assert.equal((await access()).allowed, false)
          await check("processing_canceled_revokes_extension_retains_grant_marker", { paymentIntent: pi.id, status: canceled.status, state: revoked })
        }
      } catch (error) {
        if (!(error instanceof Stripe.errors.StripeError)) throw error
        await check(`${scenario}_provider_blocker`, diagnostic(error))
        process.exitCode = 2
      }
    }
  } catch (error) { await check("failure", diagnostic(error)); process.exitCode = 1 }
  finally {
    mock.timers.reset()
    try { await closeApp?.(); await database?.close() } finally {
      for (const id of evidence.intents) {
        const intent = await stripe.paymentIntents.retrieve(id)
        assert.equal(intent.livemode, false); assert.equal(intent.metadata.acceptance_run, run)
        if (!["canceled", "succeeded"].includes(intent.status)) await stripe.paymentIntents.cancel(id)
      }
      for (const id of evidence.clocks) { const clock = await stripe.testHelpers.testClocks.retrieve(id); assert.equal(clock.livemode, false); assert.ok(clock.name?.startsWith(run)); await stripe.testHelpers.testClocks.del(id) }
      if (evidence.product) {
        const product = await stripe.products.retrieve(evidence.product); assert.equal(product.metadata.acceptance_run, run)
        for await (const price of stripe.prices.list({ product: product.id })) await stripe.prices.update(price.id, { active: false })
        await stripe.products.update(product.id, { active: false })
      }
      if (evidence.configuration) {
        const configuration = await stripe.paymentMethodConfigurations.retrieve(evidence.configuration)
        assert.equal(configuration.name, run); assert.equal(configuration.livemode, false)
        await stripe.paymentMethodConfigurations.update(configuration.id, { active: false })
        await check("isolated_payment_configuration_archived", { configuration: configuration.id })
      }
      evidence.cleaned = true; await save()
    }
  }
}
main().catch(() => { console.error("Processing runner prerequisite or cleanup failure; raw error suppressed."); process.exitCode = 1 })
