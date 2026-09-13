import "server-only"
import { randomBytes } from "node:crypto"
import Stripe from "stripe"
import { getDatabase, nowIso, withImmediateTransaction, type DbExecutor } from "./db"
import { AppError } from "./errors"
import { BILLING_PLANS, type PaidBillingPlanSlug } from "./billing-catalog"
import { webhookVerificationTime } from "./maintenance/replay-clock"

export const billingEnabled = () => process.env.MCA_STRIPE_BILLING_ENABLED === "true"
// Historical Clerk migration scripts retain their original role mapping.
export const BILLING_ADMIN_ROLE = "org:mca_billing_admin"
export const BILLING_EMPLOYEE_ROLE = "org:mca_employee"
export const billingRole = (role: string) => ["admin", "super_admin"].includes(role) ? BILLING_ADMIN_ROLE : BILLING_EMPLOYEE_ROLE
export type StripeBillingClient = Pick<Stripe, "customers" | "subscriptions" | "prices" | "checkout" | "billingPortal" | "webhooks">

export function getStripeClient(): StripeBillingClient {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  // This migration deliberately cannot create live subscriptions, even with a misconfigured key.
  if (!key || !/^(sk|rk)_test_/.test(key)) throw new AppError(503, "billing_test_mode_required", "Company billing requires a Stripe test key.")
  return new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15_000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() })
}

function priceIds() {
  const starter = process.env.STRIPE_STARTER_PRICE_ID?.trim()
  const team = process.env.STRIPE_TEAM_PRICE_ID?.trim()
  if (!starter || !team || starter === team || ![starter, team].every(id => /^price_[A-Za-z0-9]+$/.test(id)))
    throw new AppError(503, "billing_catalog_unconfigured", "The company plan catalog needs administrator configuration.")
  return { mca_starter_test: starter, mca_team_test: team }
}

export interface BillingSubscription {
  id: string
  customer: string | { id: string }
  status: string
  livemode: boolean
  cancel_at_period_end?: boolean
  pause_collection?: unknown
  current_period_start?: number | null
  current_period_end?: number | null
  items: { data: Array<{ quantity?: number | null; current_period_start?: number; current_period_end?: number; price: { id: string } }> }
}
export interface BillingEntitlement {
  subscriptionId: string | null
  planId: string | null
  planSlug: string
  planName: string
  status: string
  periodStart: string | null
  periodEnd: string | null
  seatLimit: number
  paymentPastDue: boolean
}
const freeEntitlement = (): BillingEntitlement => ({ subscriptionId: null, planId: null, planSlug: "free_org", planName: "Free", status: "active", periodStart: null, periodEnd: null, seatLimit: 1, paymentPastDue: false })
const iso = (seconds: number | undefined | null) => seconds && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null

export function subscriptionEntitlement(subscription: BillingSubscription): BillingEntitlement {
  if (subscription.livemode !== false) throw new AppError(503, "billing_test_mode_required", "Only Stripe test subscriptions are supported.")
  // Scheduled cancellations remain active at Stripe until period end. Immediately canceled
  // subscriptions must not retain extra seats just because a future period_end remains set.
  if (["canceled", "incomplete_expired"].includes(subscription.status)) return freeEntitlement()
  if (!["active", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))
    throw new AppError(503, "billing_subscription_unavailable", "This subscription requires administrator review.")
  const ids = priceIds()
  const items = subscription.items?.data ?? []
  if (items.length !== 1 || items[0].quantity !== 1) throw new AppError(503, "billing_plan_unknown", "This company subscription needs administrator configuration.")
  const item = items[0]
  const slug = (Object.keys(ids) as PaidBillingPlanSlug[]).find(value => ids[value] === item.price?.id)
  if (!slug) throw new AppError(503, "billing_plan_unknown", "This company plan needs administrator configuration.")
  const plan = BILLING_PLANS.find(value => value.slug === slug)!
  if (subscription.status === "incomplete") return { ...freeEntitlement(), status: "incomplete", paymentPastDue: true }
  return { subscriptionId: subscription.id, planId: item.price.id, planSlug: plan.slug, planName: plan.name, status: subscription.status,
    periodStart: iso(item.current_period_start ?? subscription.current_period_start), periodEnd: iso(item.current_period_end ?? subscription.current_period_end),
    seatLimit: plan.seats, paymentPastDue: subscription.status !== "active" || Boolean(subscription.pause_collection) }
}

function currentEntitlement(subscriptions: BillingSubscription[], customerId: string) {
  for (const subscription of subscriptions) {
    if ((typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id) !== customerId || subscription.livemode !== false)
      throw new AppError(503, "billing_customer_mismatch", "Company billing identity could not be verified.")
  }
  const eligible = subscriptions.filter(value => !["canceled", "incomplete_expired"].includes(value.status))
  if (eligible.length > 1) throw new AppError(503, "billing_multiple_subscriptions", "Multiple company subscriptions require administrator review.")
  return eligible.length ? subscriptionEntitlement(eligible[0]) : freeEntitlement()
}

/** Read the managed Supabase Stripe Sync Engine schema; never write provider tables. */
export async function readSyncedSubscriptions(customerId: string, db = getDatabase()): Promise<BillingSubscription[] | null> {
  const relations = await db.prepare<{ subscriptions: string | null; items: string | null }>("SELECT to_regclass('stripe.subscriptions')::text subscriptions, to_regclass('stripe.subscription_items')::text items").get()
  if (!relations?.subscriptions) return null
  const itemRows = relations.items ? "COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM stripe.subscription_items i WHERE i.subscription = s.id), '[]'::jsonb)" : "'[]'::jsonb"
  const rows = await db.prepare<{ subscription: Record<string, unknown>; items: Array<Record<string, unknown>> }>(`SELECT to_jsonb(s) subscription,
    ${itemRows} items FROM stripe.subscriptions s WHERE s.customer = ?`).all(customerId)
  // Current managed engine stores complete Stripe objects in _raw_data and exposes
  // generated columns. Older engine installations have materialized scalar columns.
  return rows.map(row => {
    const raw = (row.subscription._raw_data ?? row.subscription) as Record<string, unknown>
    const embedded = raw.items as { data?: unknown[] } | undefined
    const items = embedded?.data ?? row.items.map(item => (item._raw_data ?? item) as Record<string, unknown>).filter(item => !item.deleted).map(item => ({ ...item, price: typeof item.price === "string" ? { id: item.price } : item.price }))
    return { ...raw, items: { data: items } } as unknown as BillingSubscription
  })
}

async function persistEntitlement(workspaceId: string, current: BillingEntitlement, source: "free" | "stripe_api" | "sync_engine", db: DbExecutor) {
  const syncedAt = nowIso()
  await db.prepare(`INSERT INTO workspace_billing_entitlements (workspace_id, stripe_subscription_id, stripe_price_id, plan_slug, plan_name, status, period_start, period_end, seat_limit, payment_past_due, source, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id) DO UPDATE SET stripe_subscription_id=EXCLUDED.stripe_subscription_id, stripe_price_id=EXCLUDED.stripe_price_id, plan_slug=EXCLUDED.plan_slug, plan_name=EXCLUDED.plan_name, status=EXCLUDED.status, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, seat_limit=EXCLUDED.seat_limit, payment_past_due=EXCLUDED.payment_past_due, source=EXCLUDED.source, synced_at=EXCLUDED.synced_at`)
    .run(workspaceId, current.subscriptionId, current.planId, current.planSlug, current.planName, current.status, current.periodStart, current.periodEnd, current.seatLimit, current.paymentPastDue ? 1 : 0, source, syncedAt)
  await db.prepare("UPDATE workspaces SET seat_limit = ?, updated_at = ? WHERE id = ?").run(current.seatLimit, syncedAt, workspaceId)
  return { ...current, source, syncedAt }
}

export async function syncWorkspaceBilling(workspaceId: string, providedClient?: StripeBillingClient) {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    const mapping = await db.prepare<{ stripe_customer_id: string }>("SELECT stripe_customer_id FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
    if (!mapping) return persistEntitlement(workspaceId, freeEntitlement(), "free", db)
    const client = providedClient ?? getStripeClient()
    let live: BillingSubscription[]
    try {
      const result = await client.subscriptions.list({ customer: mapping.stripe_customer_id, status: "all", limit: 100 })
      if (result.has_more) throw new Error("Subscription pagination requires administrator review")
      live = result.data as BillingSubscription[]
    } catch { throw new AppError(503, "billing_unavailable", "Company billing verification is temporarily unavailable. Existing access is unchanged; please retry.") }
    const current = currentEntitlement(live, mapping.stripe_customer_id)
    // Read the synchronized data, but confirm it against live Stripe before any capacity
    // grant. A delayed, missing or out-of-order sync cannot issue unpaid seats.
    const snapshot = await readSyncedSubscriptions(mapping.stripe_customer_id, db)
    let matchingSnapshot = false
    if (snapshot) {
      try { matchingSnapshot = JSON.stringify(currentEntitlement(snapshot, mapping.stripe_customer_id)) === JSON.stringify(current) }
      catch { /* An outdated sync row cannot override verified provider state. */ }
    }
    return persistEntitlement(workspaceId, current, matchingSnapshot ? "sync_engine" : "stripe_api", db)
  })
}

/** Call within the same workspace-locked transaction that inserts the seat reservation. */
export async function assertBillingCapacity(workspaceId: string, additionalSeats = 1, client?: StripeBillingClient) {
  if (!billingEnabled()) return
  if (!Number.isSafeInteger(additionalSeats) || additionalSeats < 0) throw new AppError(422, "invalid_seat_count", "Seat count must be a non-negative integer.")
  const plan = await syncWorkspaceBilling(workspaceId, client)
  if (plan.paymentPastDue) throw new AppError(409, "billing_payment_required", "Update the company payment method before sending invitations.")
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('active','pending')").get(workspaceId)
  if ((usage?.count ?? 0) + additionalSeats > plan.seatLimit) throw new AppError(409, "seat_limit_reached", "Your company has used its plan's seats. Upgrade in Plans & Billing or free a reserved seat.")
}

export async function getWorkspaceBilling(workspaceId: string) {
  const billing = await getDatabase().prepare(`SELECT stripe_subscription_id AS "subscriptionId", stripe_price_id AS "planId", plan_slug AS "planSlug", plan_name AS "planName", status, period_start AS "periodStart", period_end AS "periodEnd", seat_limit AS "seatLimit", payment_past_due AS "paymentPastDue", source, synced_at AS "syncedAt" FROM workspace_billing_entitlements WHERE workspace_id = ?`).get(workspaceId)
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('active','pending')").get(workspaceId)
  const customer = await getDatabase().prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
  return { enabled: billingEnabled(), testMode: true, billing: billing ?? null, occupiedSeats: usage?.count ?? 0, canManagePayment: Boolean(customer) }
}

function billingReturnUrl(onboarding: boolean) {
  const raw = process.env.MCA_APP_ORIGIN
  if (!raw) throw new AppError(503, "billing_origin_unconfigured", "The application origin is not configured.")
  const url = new URL(raw)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new AppError(503, "billing_origin_invalid", "The application origin requires HTTPS.")
  return `${url.origin}${onboarding ? "/onboarding?setup=1" : "/settings/billing"}`
}

export async function createBillingCheckout(workspaceId: string, slug: PaidBillingPlanSlug, onboarding = false, providedClient?: StripeBillingClient) {
  if (!["mca_starter_test", "mca_team_test"].includes(slug)) throw new AppError(422, "billing_plan_invalid", "Choose a supported paid company plan.")
  const client = providedClient ?? getStripeClient()
  const priceId = priceIds()[slug]
  const expected = BILLING_PLANS.find(plan => plan.slug === slug)!
  const price = await client.prices.retrieve(priceId)
  if (price.livemode !== false || !price.active || price.currency !== "usd" || price.unit_amount !== expected.monthlyUsd * 100 || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 || price.recurring.usage_type !== "licensed")
    throw new AppError(503, "billing_price_mismatch", "The Stripe test price does not match the company plan catalog.")
  const returnUrl = billingReturnUrl(onboarding)
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare<{ name: string }>("SELECT name FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    let mapping = await db.prepare<{ stripe_customer_id: string; checkout_session_id: string | null; checkout_plan_slug: string | null }>("SELECT stripe_customer_id, checkout_session_id, checkout_plan_slug FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
    if (!mapping) {
      const customer = await client.customers.create({ name: workspace.name, metadata: { workspace_id: workspaceId } }, { idempotencyKey: `fundlane-test-customer-${workspaceId}` })
      if (customer.livemode !== false) throw new AppError(503, "billing_test_mode_required", "Only test customers are supported.")
      await db.prepare("INSERT INTO workspace_stripe_customers (workspace_id, stripe_customer_id, created_at) VALUES (?, ?, ?)").run(workspaceId, customer.id, nowIso())
      mapping = { stripe_customer_id: customer.id, checkout_session_id: null, checkout_plan_slug: null }
    }
    const current = await syncWorkspaceBilling(workspaceId, client)
    if (current.subscriptionId || current.status === "incomplete") throw new AppError(409, "billing_subscription_exists", "Manage the existing subscription through Payment settings.")
    if (mapping.checkout_session_id) {
      const pending = await client.checkout.sessions.retrieve(mapping.checkout_session_id)
      if (pending.status === "open") {
        if (mapping.checkout_plan_slug === slug && pending.url) return { url: pending.url }
        await client.checkout.sessions.expire(pending.id)
      } else if (pending.status === "complete") {
        const subscriptionId = typeof pending.subscription === "string" ? pending.subscription : pending.subscription?.id
        const previous = subscriptionId ? await client.subscriptions.retrieve(subscriptionId) : null
        // Allow a new plan after a previous subscription actually ended. A completed
        // async checkout whose subscription is still propagating must be retried later.
        if (!previous || !["canceled", "incomplete_expired"].includes(previous.status))
          throw new AppError(409, "billing_checkout_pending", "Your checkout is being reconciled. Retry billing sync before starting another checkout.")
      }
    }
    const suffix = Array.from(randomBytes(8), byte => String.fromCharCode(97 + byte % 26)).join("")
    const session = await client.checkout.sessions.create({ mode: "subscription", customer: mapping.stripe_customer_id,
      client_reference_id: workspaceId, metadata: { workspace_id: workspaceId }, subscription_data: { metadata: { workspace_id: workspaceId } },
      line_items: [{ price: priceId, quantity: 1 }], integration_identifier: `fundlane_company_${suffix}`,
      success_url: returnUrl, cancel_url: returnUrl, expires_at: Math.floor(Date.now() / 1000) + 1800,
    }, { idempotencyKey: `fundlane-checkout-${workspaceId}-${slug}-${Math.floor(Date.now() / 1800000)}` })
    if (session.livemode !== false || !session.url) throw new AppError(503, "billing_checkout_unavailable", "Checkout is temporarily unavailable.")
    await db.prepare("UPDATE workspace_stripe_customers SET checkout_session_id = ?, checkout_plan_slug = ? WHERE workspace_id = ?").run(session.id, slug, workspaceId)
    return { url: session.url }
  })
}

export async function createBillingPortal(workspaceId: string, onboarding = false, providedClient?: StripeBillingClient) {
  const client = providedClient ?? getStripeClient()
  const mapping = await getDatabase().prepare<{ stripe_customer_id: string }>("SELECT stripe_customer_id FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
  if (!mapping) throw new AppError(409, "billing_customer_required", "Choose a paid plan before opening payment settings.")
  const customer = await client.customers.retrieve(mapping.stripe_customer_id)
  if (customer.deleted || customer.livemode !== false || customer.metadata.workspace_id !== workspaceId) throw new AppError(503, "billing_customer_mismatch", "Company billing identity could not be verified.")
  const portal = await client.billingPortal.sessions.create({ customer: mapping.stripe_customer_id, return_url: billingReturnUrl(onboarding), ...(process.env.STRIPE_BILLING_PORTAL_CONFIGURATION ? { configuration: process.env.STRIPE_BILLING_PORTAL_CONFIGURATION } : {}) })
  return { url: portal.url }
}

export function verifyStripeBillingEvent(body: string, signature: string | null, client = getStripeClient()): Stripe.Event {
  const secret = process.env.STRIPE_BILLING_WEBHOOK_SECRET
  if (!secret) throw new AppError(503, "billing_webhook_unconfigured", "The billing webhook is not configured.")
  if (!signature) throw new AppError(400, "billing_webhook_signature_invalid", "Invalid webhook signature.")
  try { return client.webhooks.constructEvent(body, signature, secret, undefined, undefined, webhookVerificationTime()) }
  catch { throw new AppError(400, "billing_webhook_signature_invalid", "Invalid webhook signature.") }
}

export async function processStripeBillingEvent(event: Stripe.Event, providedClient?: StripeBillingClient) {
  if (event.livemode !== false) throw new AppError(400, "billing_test_mode_required", "Live billing events are not accepted.")
  if (!/^(customer\.subscription\.|invoice\.(paid|payment_failed|payment_action_required|updated)$|checkout\.session\.(completed|async_payment_succeeded|async_payment_failed|expired)$)/.test(event.type)) return { ignored: true }
  const object = event.data.object as unknown as { customer?: string | { id: string } }
  const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id
  if (!customerId) return { ignored: true }
  return withImmediateTransaction(async db => {
    const mapping = await db.prepare<{ workspace_id: string }>("SELECT workspace_id FROM workspace_stripe_customers WHERE stripe_customer_id = ?").get(customerId)
    if (!mapping) return { ignored: true }
    await db.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(mapping.workspace_id)
    const receipt = await db.prepare("INSERT INTO stripe_billing_events (event_id, event_type, stripe_customer_id, workspace_id, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING").run(event.id, event.type, customerId, mapping.workspace_id, nowIso())
    if (!receipt.changes) return { duplicate: true }
    // Read current provider state, never trust the order or entitlement fields of an event.
    await syncWorkspaceBilling(mapping.workspace_id, providedClient)
    return { reconciled: true }
  })
}
