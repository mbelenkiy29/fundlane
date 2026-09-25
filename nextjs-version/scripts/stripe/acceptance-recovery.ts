#!/usr/bin/env -S node --conditions=react-server --import tsx
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { mock } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import Stripe from "stripe"
import { BILLING_CATALOG } from "../../src/lib/mca/billing-catalog"

const ACCOUNT = "acct_1UIDeIBP3qJwlwms"
const API_VERSION = "2026-08-26.dahlia"
const DAY = 86400
class RunnerError extends Error {}
function providerDiagnostic(error: Stripe.errors.StripeError) {
  return {
    type: error.type, code: error.code, status: error.statusCode, request: error.requestId,
    param: error.param, permissions: error.message.match(/rak_[a-z_]+/g) ?? [],
    message: error.message.replaceAll(process.env.STRIPE_SECRET_KEY ?? "[no-key]", "[redacted]")
      .replace(/(?:sk|rk)_(?:test|live)_\S+/g, "[redacted]")
      .replace(/https?:\/\/\S+/g, "[redacted-url]"),
  }
}
const help = `Run from nextjs-version with Node 24+:
  node --conditions=react-server --import tsx scripts/stripe/acceptance-recovery.ts --help
  ... --apply --provision-synthetic-prices --evidence=/private/path/recovery.json
  ... --cleanup=/private/path/recovery.json

Required: STRIPE_SECRET_KEY (explicit FundLane test SDK key), MCA_STRIPE_MODE=test.
Run also requires MCA_TEST_DATABASE_ADMIN_URL on a disposable loopback Postgres cluster.
Never reads Stripe CLI credentials or loads .env files. Account is fixed to ${ACCOUNT}.
Existing catalog: omit --provision-synthetic-prices and set STRIPE_BASE_PRICE_ID and
STRIPE_ADDITIONAL_SEAT_PRICE_ID; both are verified by the application's validator.
Resources are cleaned automatically, including on failure. --keep-resources retains
Stripe resources for inspection; the disposable database is always dropped.
Evidence contains IDs/statuses only, never keys, payment links, or customer payloads.
This core runner does not certify browser Checkout/Portal, SCA, or processing coverage.`

type Evidence = {
  account: string; run: string; apiVersion: string; clock?: string; product?: string
  prices: string[]; customer?: string; subscription?: string; database?: string
  portalConfiguration?: string; checkoutSessions?: string[]
  cleanupWarnings?: string[]
  checks: Array<{ name: string; data?: Record<string, unknown> }>
  result: "running" | "passed-core" | "failed"; cleaned?: boolean
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) { console.log(help); return }
  for (const arg of args) if (!/^(--apply|--provision-synthetic-prices|--keep-resources|--evidence=.+|--cleanup=.+)$/.test(arg)) throw new RunnerError("Unknown argument; see --help.")
  const cleanupPath = args.find(v => v.startsWith("--cleanup="))?.slice(10)
  const evidencePath = args.find(v => v.startsWith("--evidence="))?.slice(11)
  const key = process.env.STRIPE_SECRET_KEY
  if (process.env.MCA_STRIPE_MODE !== "test" || !key || !/^(sk|rk)_test_/.test(key)) throw new RunnerError("Explicit test-mode SDK credentials required.")
  if (!cleanupPath && (!args.includes("--apply") || !evidencePath)) throw new RunnerError("Run requires --apply and a new --evidence file.")
  // Reject libpq query overrides as well as hosted endpoints; never fall back to DATABASE_URL.
  if (!cleanupPath) {
    const url = new URL(process.env.MCA_TEST_DATABASE_ADMIN_URL ?? "invalid:")
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.search) throw new RunnerError("Use a disposable literal loopback Postgres admin URL without query parameters.")
  }
  const stripe = new Stripe(key, { apiVersion: API_VERSION, timeout: 15000, maxNetworkRetries: 1 })
  if ((await stripe.accounts.retrieve(null)).id !== ACCOUNT) throw new RunnerError("Wrong Stripe account; no mutations performed.")

  async function cleanup(e: Evidence) {
    assert.equal(e.account, ACCOUNT)
    assert.match(e.run, /^fundlane-recovery-[a-f0-9-]{36}$/)
    for (const id of e.checkoutSessions ?? []) {
      const session = await stripe.checkout.sessions.retrieve(id)
      assert.equal(session.livemode, false)
      if (session.status === "open") await stripe.checkout.sessions.expire(id)
    }
    if (e.portalConfiguration) {
      const configuration = await stripe.billingPortal.configurations.retrieve(e.portalConfiguration)
      assert.equal(configuration.livemode, false)
      assert.equal(configuration.metadata?.acceptance_run, e.run)
      if (configuration.is_default) {
        e.cleanupWarnings = ["Stripe made this first Portal configuration the account default; provider forbids deactivation. Retained configuration requires owner review."]
      } else await stripe.billingPortal.configurations.update(configuration.id, { active: false })
    }
    if (e.clock) {
      try {
        const clock = await stripe.testHelpers.testClocks.retrieve(e.clock)
        assert.equal(clock.livemode, false)
        assert.equal(clock.name, e.run, "Clock is not owned by this run")
        await stripe.testHelpers.testClocks.del(clock.id)
      } catch (error) { if (!(error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing")) throw error }
    }
    if (e.product) {
      const product = await stripe.products.retrieve(e.product)
      assert.equal(product.livemode, false)
      assert.equal(product.metadata.acceptance_run, e.run)
      // Discover prices as well, covering interruption between creation and evidence write.
      for await (const price of stripe.prices.list({ product: product.id, limit: 100 })) {
        assert.equal(price.livemode, false)
        await stripe.prices.update(price.id, { active: false })
      }
      await stripe.products.update(product.id, { active: false })
    }
    e.cleaned = !e.cleanupWarnings?.length
  }
  if (cleanupPath) {
    const evidence = JSON.parse(await readFile(cleanupPath, "utf8")) as Evidence
    await cleanup(evidence)
    await writeFile(cleanupPath, JSON.stringify(evidence, null, 2), { mode: 0o600 })
    if (!evidence.cleaned) throw new RunnerError("Disposable billing resources cleaned; retained default Portal configuration requires owner review.")
    console.log("Synthetic Stripe resources cleaned; catalog prices archived.")
    return
  }

  const e: Evidence = { account: ACCOUNT, run: `fundlane-recovery-${randomUUID()}`, apiVersion: API_VERSION, prices: [], checks: [], result: "running" }
  await writeFile(evidencePath!, JSON.stringify(e, null, 2), { flag: "wx", mode: 0o600 })
  const save = () => writeFile(evidencePath!, JSON.stringify(e, null, 2), { mode: 0o600 })
  const check = async (name: string, data?: Record<string, unknown>) => { e.checks.push({ name, data }); await save(); console.log(name) }
  const metadata = { application: "fundlane", acceptance_run: e.run }
  let database: Awaited<ReturnType<typeof import("../../tests/helpers/postgres-test-db.mjs").createPostgresTestDatabase>> | undefined
  let closeApp: (() => Promise<void>) | undefined
  let stage = "setup"
  try {
    // App imports happen only after the local database gate and account verification.
    const { createPostgresTestDatabase } = await import("../../tests/helpers/postgres-test-db.mjs")
    database = await createPostgresTestDatabase("stripe_recovery")
    e.database = database.databaseName
    Object.assign(process.env, { DATABASE_URL: database.databaseUrl, DATABASE_URL_UNPOOLED: database.databaseUrlUnpooled, MCA_STRIPE_BILLING_ENABLED: "true", MCA_APP_ORIGIN: "http://127.0.0.1:3000" })
    const billing = await import("../../src/lib/mca/billing")
    const { getDatabase, closeDatabaseForTests, nowIso } = await import("../../src/lib/mca/db")
    closeApp = closeDatabaseForTests
    const { createWorkspaceWithAdmin } = await import("../../src/lib/mca/workspaces")
    const { getCompanyAccess, assertCompanyOutboundAllowed } = await import("../../src/lib/mca/company-access")
    const { setPlatformCompanyAccess } = await import("../../src/lib/mca/billing-operations")
    if (args.includes("--provision-synthetic-prices")) {
      // This sandbox defaults Checkout to Managed Payments, requiring a tax code.
      const product = await stripe.products.create({ name: e.run, metadata, tax_code: "txcd_10103001" }, { idempotencyKey: `${e.run}-product` })
      e.product = product.id; await save()
      const base = await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: BILLING_CATALOG.base.unitAmountCents, recurring: { interval: "month", usage_type: "licensed" }, metadata }, { idempotencyKey: `${e.run}-base` })
      e.prices.push(base.id); await save()
      const seats = await stripe.prices.create({ product: product.id, currency: "usd", billing_scheme: "tiered", tiers_mode: "graduated", recurring: { interval: "month", usage_type: "licensed" }, tiers: BILLING_CATALOG.additionalSeats.tiers.map(tier => ({ up_to: tier.upTo ?? "inf", unit_amount: tier.unitAmountCents })), metadata }, { idempotencyKey: `${e.run}-seats` })
      e.prices.push(seats.id); await save()
      process.env.STRIPE_BASE_PRICE_ID = base.id
      process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID = seats.id
    }
    await billing.verifyBillingPrices(stripe)
    const start = Math.floor(Date.now() / 1000)
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start, name: e.run }, { idempotencyKey: `${e.run}-clock` })
    assert.equal(clock.livemode, false)
    e.clock = clock.id; await save()
    // Only Date is mocked, exclusively in this standalone process. Network/poll timers stay real.
    mock.timers.enable({ apis: ["Date"], now: start * 1000 })
    let frozen = start
    async function advance(target: number) {
      assert.ok(target > frozen)
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: target })
      for (let attempt = 0; attempt < 120; attempt++) {
        const current = await stripe.testHelpers.testClocks.retrieve(clock.id)
        if (current.status === "ready" && current.frozen_time === target) {
          frozen = target; mock.timers.setTime(target * 1000); return
        }
        if (current.status === "internal_failure") throw new Error("Stripe test clock failed")
        await sleep(2000)
      }
      throw new Error("Stripe test clock readiness timeout")
    }
    const local = await createWorkspaceWithAdmin({ workspaceName: e.run, adminName: "Synthetic owner", adminEmail: `${e.run}@example.test`, password: randomUUID() + "aA9!", role: "admin" })
    const customer = await stripe.customers.create({ name: e.run, test_clock: clock.id, metadata: { ...metadata, workspace_id: local.workspaceId } }, { idempotencyKey: `${e.run}-customer` })
    assert.equal(customer.livemode, false)
    e.customer = customer.id; await save()
    await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,0,?)").run(local.workspaceId, customer.id, nowIso())
    const good = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } })
    let sub = await stripe.subscriptions.create({ customer: customer.id, items: [{ price: billing.priceIds().base, quantity: 1 }], billing_mode: { type: "flexible" }, payment_behavior: "error_if_incomplete", metadata: { ...metadata, workspace_id: local.workspaceId } }, { idempotencyKey: `${e.run}-subscription` })
    e.subscription = sub.id; await save()
    const sync = () => billing.syncWorkspaceBilling(local.workspaceId, stripe)
    const access = () => getCompanyAccess(local.workspaceId)
    await sync(); assert.equal((await access()).status, "active")
    await check("initial_paid_subscription", { subscription: sub.id })
    const originalApproval = nowIso()
    await assertCompanyOutboundAllowed(local.workspaceId, originalApproval)

    async function fixture(label: string) {
      const workspace = await createWorkspaceWithAdmin({ workspaceName: `${e.run}-${label}`, adminName: "Synthetic owner", adminEmail: `${e.run}-${label}@example.test`, password: randomUUID() + "aA9!", role: "admin" })
      const customer = await stripe.customers.create({ name: `${e.run}-${label}`, test_clock: clock.id, metadata: { ...metadata, workspace_id: workspace.workspaceId } })
      await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,0,?)").run(workspace.workspaceId, customer.id, nowIso())
      return { ...workspace, customer }
    }
    // Run Checkout before advancing Date: its expiration uses provider wall time.
    stage = "Checkout SDK serialization"
    const checkout = await fixture("checkout")
    const checkoutResult = await billing.createBillingCheckout(checkout.workspaceId, 2, false, stripe)
    assert.ok(checkoutResult.url)
    const checkoutSessions = await stripe.checkout.sessions.list({ customer: checkout.customer.id, limit: 10 })
    e.checkoutSessions = checkoutSessions.data.map(session => session.id); await save()
    const session = checkoutSessions.data.find(value => value.status === "open")
    assert.ok(session); assert.equal(session.livemode, false); assert.equal(session.mode, "subscription")
    const lines = await stripe.checkout.sessions.listLineItems(session.id)
    assert.deepEqual(lines.data.map(line => [line.price?.id, line.quantity]), [[billing.priceIds().base, 1], [billing.priceIds().seats, 1]])
    assert.equal((await billing.createBillingCheckout(checkout.workspaceId, 2, false, stripe)).url, checkoutResult.url)
    await stripe.checkout.sessions.expire(session.id)
    await check("application_checkout_provider_serialization_and_reuse", { session: session.id, completed: false })

    stage = "Portal configuration and session"
    // Stripe makes the first configuration the undeactivatable default. Never
    // implicitly establish that shared account setting in an acceptance run.
    if (!(await stripe.billingPortal.configurations.list({ limit: 1 })).data.length) throw new RunnerError("Owner must configure the sandbox's default Portal before acceptance can create a disposable configuration.")
    const portalConfiguration = await stripe.billingPortal.configurations.create({ metadata, business_profile: { headline: "Synthetic Fundlane acceptance" }, features: {
      payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: "at_period_end" },
    } })
    e.portalConfiguration = portalConfiguration.id; await save()
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION = portalConfiguration.id
    assert.ok((await billing.createBillingPortal(local.workspaceId, false, stripe)).url)
    await check("application_portal_configuration_and_session", { configuration: portalConfiguration.id, browserFlow: false })

    stage = "paused cancellation fixture"
    const paused = await fixture("paused-cancel")
    const pausedGood = await stripe.paymentMethods.attach("pm_card_visa", { customer: paused.customer.id })
    await stripe.customers.update(paused.customer.id, { invoice_settings: { default_payment_method: pausedGood.id } })
    const pausedSub = await stripe.subscriptions.create({ customer: paused.customer.id, items: [{ price: billing.priceIds().base, quantity: 1 }], billing_mode: { type: "flexible" }, payment_behavior: "error_if_incomplete", metadata: { ...metadata, workspace_id: paused.workspaceId } })
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)
    const pausedFailing = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: paused.customer.id })
    await stripe.customers.update(paused.customer.id, { invoice_settings: { default_payment_method: pausedFailing.id } })

    stage = "failed renewal"
    const failing = await stripe.paymentMethods.attach("pm_card_chargeCustomerFail", { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: failing.id } })
    await advance(sub.items.data[0].current_period_end + 3600)
    const invoices = () => stripe.invoices.list({ customer: customer.id, subscription: sub.id, limit: 100 })
    let renewal = (await invoices()).data.find(i => i.billing_reason === "subscription_cycle")
    assert.ok(renewal, "Clock must generate a renewal")
    // Some sandbox webhook settings delay automatic finalization. Finalize the normal
    // renewal explicitly, then attempt collection using the failing test method.
    if (renewal.status === "draft") renewal = await stripe.invoices.finalizeInvoice(renewal.id)
    if (renewal.status === "open") {
      try { await stripe.invoices.pay(renewal.id, { payment_method: failing.id }) }
      catch (error) { if (!(error instanceof Stripe.errors.StripeCardError)) throw error }
    }
    renewal = await stripe.invoices.retrieve(renewal.id)
    assert.equal(renewal.status, "open"); assert.ok(renewal.attempt_count > 0)
    await sync()
    const grace = (await access()).graceEndsAt
    assert.ok(grace); assert.equal((await access()).status, "grace")
    await check("failed_renewal_grace", { invoice: renewal.id, graceEndsAt: grace })
    let pausedRenewal = (await stripe.invoices.list({ customer: paused.customer.id, subscription: pausedSub.id, limit: 100 })).data.find(invoice => invoice.billing_reason === "subscription_cycle")
    assert.ok(pausedRenewal)
    if (pausedRenewal.status === "draft") pausedRenewal = await stripe.invoices.finalizeInvoice(pausedRenewal.id)
    if (pausedRenewal.status === "open") {
      try { await stripe.invoices.pay(pausedRenewal.id, { payment_method: pausedFailing.id }) }
      catch (error) { if (!(error instanceof Stripe.errors.StripeCardError)) throw error }
    }
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)

    stage = "cutoff"
    await advance(Date.parse(grace) / 1000)
    await sync(); assert.equal((await access()).allowed, false)
    await assert.rejects(assertCompanyOutboundAllowed(local.workspaceId, originalApproval), { code: "company_paused" })
    assert.equal((await stripe.invoices.retrieve(renewal.id)).auto_advance, false)
    sub = await stripe.subscriptions.retrieve(sub.id)
    assert.equal(sub.pause_collection?.behavior, "keep_as_draft")
    await sync(); assert.equal((await access()).graceEndsAt, grace)
    await check("cutoff_stops_retries_and_collection", { invoice: renewal.id })

    stage = "application paused cancellation"
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)
    assert.equal((await getCompanyAccess(paused.workspaceId)).allowed, false)
    assert.equal((await stripe.subscriptions.retrieve(pausedSub.id)).pause_collection?.behavior, "keep_as_draft")
    assert.ok((await billing.createBillingPortal(paused.workspaceId, false, stripe)).url)
    const pausedInvoiceCount = (await stripe.invoices.list({ customer: paused.customer.id, subscription: pausedSub.id, limit: 100 })).data.length
    const pausedCancellation = await billing.cancelBillingSubscription(paused.workspaceId, paused.userId, stripe)
    assert.ok(pausedCancellation.cancelAt)
    assert.equal((await billing.cancelBillingSubscription(paused.workspaceId, paused.userId, stripe)).cancelAt, pausedCancellation.cancelAt)
    await check("application_paused_cancellation_scheduled", { subscription: pausedSub.id, cancelAt: pausedCancellation.cancelAt })

    stage = "missed month"
    await advance(sub.items.data[0].current_period_end + 3600)
    const missed = (await invoices()).data.find(i => i.id !== renewal.id && i.status === "draft" && i.billing_reason === "subscription_cycle")
    assert.ok(missed, "Paused subscription must generate a missed-month draft")
    await sync()
    const finalized = await stripe.invoices.retrieve(missed.id)
    assert.equal(finalized.status, "open"); assert.equal(finalized.auto_advance, false)
    assert.equal(finalized.amount_paid, 0); assert.ok(finalized.hosted_invoice_url)
    assert.equal(finalized.amount_due, missed.amount_due)
    await advance(frozen + DAY)
    const uncharged = await stripe.invoices.retrieve(missed.id)
    assert.equal(uncharged.amount_paid, 0); assert.equal(uncharged.attempt_count, finalized.attempt_count)
    await check("missed_month_finalized_without_auto_charge", { invoice: missed.id, amountDue: finalized.amount_due, autoAdvance: finalized.auto_advance, attempts: uncharged.attempt_count })
    stage = "paused cancellation effective without renewal"
    assert.equal((await stripe.subscriptions.retrieve(pausedSub.id)).status, "canceled")
    assert.equal((await stripe.invoices.list({ customer: paused.customer.id, subscription: pausedSub.id, limit: 100 })).data.length, pausedInvoiceCount)
    await stripe.invoices.pay(pausedRenewal.id, { payment_method: pausedGood.id })
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)
    assert.equal((await getCompanyAccess(paused.workspaceId)).allowed, false)
    await check("paused_cancellation_no_renewal_or_debt_revival", { subscription: pausedSub.id })

    stage = "settlement"
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } })
    await stripe.invoices.pay(renewal.id, { payment_method: good.id })
    await sync(); assert.equal((await access()).allowed, false)
    assert.equal((await access()).graceEndsAt, grace)
    await check("original_invoice_paid_but_missed_month_blocks_access")
    await setPlatformCompanyAccess(local.workspaceId, local.userId, { manualPaused: true, reason: "Synthetic recovery acceptance" })
    await stripe.invoices.pay(missed.id, { payment_method: good.id })
    await sync(); assert.equal((await access()).allowed, false)
    assert.equal((await access()).reason, "manual_suspension")
    await assert.rejects(assertCompanyOutboundAllowed(local.workspaceId, originalApproval), { code: "company_paused" })
    await check("full_provider_settlement_preserves_manual_suspension_and_outbound_block")
    await setPlatformCompanyAccess(local.workspaceId, local.userId, { manualPaused: false, reason: "Synthetic acceptance resume" })
    await sync(); assert.equal((await access()).allowed, true)
    assert.equal((await stripe.subscriptions.retrieve(sub.id)).pause_collection, null)
    await check("all_required_invoices_paid_restores_access")
    await assert.rejects(assertCompanyOutboundAllowed(local.workspaceId, originalApproval), { code: "company_outbound_reapproval_required" })
    await advance(frozen + 1)
    const freshApproval = nowIso()
    await assertCompanyOutboundAllowed(local.workspaceId, freshApproval)
    await sync()
    await assertCompanyOutboundAllowed(local.workspaceId, freshApproval)
    await check("recovery_rejects_pre_pause_approval_and_preserves_new_approval_after_sync")

    stage = "SCA pending seat increase"
    const authenticationRequired = await stripe.paymentMethods.attach("pm_card_authenticationRequired", { customer: customer.id })
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: authenticationRequired.id } })
    await billing.changeBillingSeats(local.workspaceId, 2, local.userId, stripe)
    sub = await stripe.subscriptions.retrieve(sub.id)
    assert.ok(sub.pending_update)
    const actionInvoiceId = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id
    assert.ok(actionInvoiceId)
    const actionPayments = await stripe.invoicePayments.list({ invoice: actionInvoiceId, limit: 100 })
    const actionPayment = actionPayments.data.find(payment => payment.payment.type === "payment_intent")
    assert.ok(actionPayment?.payment.payment_intent)
    const actionIntent = await stripe.paymentIntents.retrieve(typeof actionPayment.payment.payment_intent === "string" ? actionPayment.payment.payment_intent : actionPayment.payment.payment_intent.id)
    assert.equal(actionIntent.status, "requires_action")
    await sync(); assert.equal((await access()).seatLimit, 1)
    await check("real_sca_requires_action_does_not_grant_unpaid_seats", { invoice: actionInvoiceId, paymentIntent: actionIntent.id, status: actionIntent.status })
    // Replacing the method is a recovery check, not a claim of hosted 3DS completion.
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } })
    await stripe.invoices.pay(actionInvoiceId, { payment_method: good.id })
    await sync(); assert.equal((await access()).seatLimit, 2)
    await check("paid_seat_increase")

    stage = "classic paid seat increase"
    // Reuse the canceled and fully settled company's clock-backed customer.
    await stripe.customers.update(paused.customer.id, { invoice_settings: { default_payment_method: pausedGood.id } })
    const classic = await stripe.subscriptions.create({ customer: paused.customer.id, items: [{ price: billing.priceIds().base, quantity: 1 }], billing_mode: { type: "classic" }, payment_behavior: "error_if_incomplete", metadata: { ...metadata, workspace_id: paused.workspaceId } })
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)
    await billing.changeBillingSeats(paused.workspaceId, 2, paused.userId, stripe)
    assert.equal((await getCompanyAccess(paused.workspaceId)).seatLimit, 2)
    assert.equal((await stripe.subscriptions.retrieve(classic.id)).billing_mode.type, "classic")
    await check("classic_paid_seat_increase_preserves_mode", { subscription: classic.id })
    await billing.changeBillingSeats(paused.workspaceId, 1, paused.userId, stripe)

    stage = "schedule seat reduction"
    await billing.changeBillingSeats(local.workspaceId, 1, local.userId, stripe)
    sub = await stripe.subscriptions.retrieve(sub.id)
    assert.ok(sub.schedule)
    stage = "pending reduction cancellation fixture"
    // Stripe permits only three customers per clock; reuse the expired Checkout's
    // still-unsubscribed synthetic company for the independent schedule scenario.
    const scheduled = checkout
    const scheduledGood = await stripe.paymentMethods.attach("pm_card_visa", { customer: scheduled.customer.id })
    await stripe.customers.update(scheduled.customer.id, { invoice_settings: { default_payment_method: scheduledGood.id } })
    const scheduledSub = await stripe.subscriptions.create({ customer: scheduled.customer.id, items: [{ price: billing.priceIds().base, quantity: 1 }, { price: billing.priceIds().seats, quantity: 1 }], billing_mode: { type: "flexible" }, payment_behavior: "error_if_incomplete", metadata: { ...metadata, workspace_id: scheduled.workspaceId } })
    await billing.syncWorkspaceBilling(scheduled.workspaceId, stripe)
    await billing.changeBillingSeats(scheduled.workspaceId, 1, scheduled.userId, stripe)
    const pendingSchedule = (await stripe.subscriptions.retrieve(scheduledSub.id)).schedule
    assert.ok(pendingSchedule)
    const scheduledCancellation = await billing.cancelBillingSubscription(scheduled.workspaceId, scheduled.userId, stripe)
    const canceledSchedule = await stripe.subscriptionSchedules.retrieve(typeof pendingSchedule === "string" ? pendingSchedule : pendingSchedule.id)
    assert.equal(canceledSchedule.end_behavior, "cancel"); assert.equal(canceledSchedule.phases.length, 1)
    assert.equal((await billing.cancelBillingSubscription(scheduled.workspaceId, scheduled.userId, stripe)).cancelAt, scheduledCancellation.cancelAt)
    await check("application_cancellation_with_pending_reduction", { subscription: scheduledSub.id, schedule: canceledSchedule.id, cancelAt: scheduledCancellation.cancelAt })
    stage = "apply renewal seat reduction"
    await advance(sub.items.data[0].current_period_end + 3600)
    await sync(); assert.equal((await access()).seatLimit, 1)
    assert.equal((await stripe.subscriptions.retrieve(sub.id)).items.data.some(i => i.price.id === billing.priceIds().seats && (i.quantity ?? 0) > 0), false)
    await check("renewal_seat_reduction")
    stage = "cancel subscription"
    // Application cancellation retains the effective date even with a schedule.
    sub = await stripe.subscriptions.retrieve(sub.id)
    const cancellation = await billing.cancelBillingSubscription(local.workspaceId, local.userId, stripe)
    assert.ok(cancellation.cancelAt)
    const invoiceCount = (await invoices()).data.length
    await advance(Math.max(Date.parse(cancellation.cancelAt), Date.parse(scheduledCancellation.cancelAt!)) / 1000 + 3600)
    assert.equal((await stripe.subscriptions.retrieve(sub.id)).status, "canceled")
    assert.equal((await invoices()).data.length, invoiceCount)
    assert.equal((await stripe.subscriptions.retrieve(scheduledSub.id)).status, "canceled")
    assert.equal((await stripe.invoices.list({ customer: scheduled.customer.id, subscription: scheduledSub.id, limit: 100 })).data.length, 1)
    await billing.syncWorkspaceBilling(paused.workspaceId, stripe)
    const reducedClassic = await stripe.subscriptions.retrieve(classic.id)
    assert.equal(reducedClassic.billing_mode.type, "classic")
    assert.equal((await getCompanyAccess(paused.workspaceId)).seatLimit, 1)
    assert.equal(reducedClassic.items.data.some(item => item.price.id === billing.priceIds().seats && (item.quantity ?? 0) > 0), false)
    await check("classic_renewal_seat_reduction_preserves_mode", { subscription: classic.id })
    await billing.syncWorkspaceBilling(scheduled.workspaceId, stripe)
    assert.equal((await getCompanyAccess(scheduled.workspaceId)).allowed, false)
    await check("application_cancellations_effective_without_renewal")
    await sync(); assert.equal((await access()).allowed, false)
    await check("canceled_subscription_not_revived_by_paid_debt")

    stage = "provider event replay"
    let event: Stripe.Event | undefined
    for (let attempt = 0; attempt < 30 && !event; attempt++) {
      const events = await stripe.events.list({ type: "customer.subscription.deleted", limit: 100 })
      event = events.data.find(value => value.type === "customer.subscription.deleted" && value.data.object.id === sub.id)
      if (!event) await sleep(2000)
    }
    assert.ok(event, "Cancellation event must become visible for real-provider replay")
    assert.equal(event.livemode, false)
    await billing.processStripeBillingEvent(event, stripe)
    await billing.processStripeBillingEvent(event, stripe)
    const receipts = await getDatabase().prepare<{ count: string }>("SELECT count(*) AS count FROM stripe_billing_events WHERE event_id=?").get(event.id)
    assert.equal(Number(receipts?.count), 1)
    assert.equal((await access()).allowed, false)
    await check("real_provider_event_replayed_once", { event: event.id })
    e.result = "passed-core"
  } catch (error) {
    e.result = "failed"
    // Never log raw errors: permission messages can echo the credential. Keep only
    // structured identifiers and primitive assertion values, never request payloads.
    const diagnostic: Record<string, unknown> = { stage }
    if (error instanceof Stripe.errors.StripeError) {
      Object.assign(diagnostic, providerDiagnostic(error))
    } else if (error instanceof assert.AssertionError) {
      diagnostic.type = "AssertionError"
      diagnostic.operator = error.operator
      for (const name of ["actual", "expected"] as const) {
        if (["boolean", "number"].includes(typeof error[name]) || error[name] === null) diagnostic[name] = error[name]
      }
    }
    e.checks.push({ name: "failure", data: diagnostic })
    console.error(JSON.stringify(diagnostic))
    throw new RunnerError(`Acceptance failed at ${stage}; inspect scoped resources and evidence privately.`)
  } finally {
    mock.timers.reset()
    try { await closeApp?.() } finally {
      try { await database?.close() } finally {
        try { if (!args.includes("--keep-resources")) await cleanup(e) }
        finally { await save() }
      }
    }
  }
  if (!e.cleaned && !args.includes("--keep-resources")) throw new RunnerError("Core checks finished, but retained resources require owner review; inspect cleanupWarnings.")
  console.log("Core recovery acceptance passed; supplemental acceptance remains required. Evidence saved.")
}

main().catch(error => { console.error(error instanceof RunnerError ? error.message : error instanceof Stripe.errors.StripeError ? JSON.stringify(providerDiagnostic(error)) : "Recovery runner failed. Check prerequisites, account, evidence stage and --help; raw provider errors are intentionally suppressed."); process.exitCode = 1 })
