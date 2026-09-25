import "server-only"
import Stripe from "stripe"
import { getDatabase, newId, nowIso, withImmediateTransaction, recordAuditEvent, type DbExecutor } from "./db"
import { AppError } from "./errors"
import { BILLING_CATALOG, monthlyPriceCents } from "./billing-catalog"
import { getCompanyAccess, captureCompanyPauseBoundary, recordCompanyPauseBoundary } from "./company-access"
export { initializeCompanyTrial } from "./company-access"
import { enqueueBillingNotification, reconcileBillingInvoices } from "./billing-reconciliation"
import { webhookVerificationTime } from "./maintenance/replay-clock"

export const billingEnabled = () => process.env.MCA_STRIPE_BILLING_ENABLED === "true"
// Historical Clerk migration scripts retain their original role mapping.
export const BILLING_ADMIN_ROLE = "org:mca_billing_admin"
export const BILLING_EMPLOYEE_ROLE = "org:mca_employee"
export const billingRole = (role: string) => ["admin", "super_admin"].includes(role) ? BILLING_ADMIN_ROLE : BILLING_EMPLOYEE_ROLE
export type StripeBillingClient = Pick<Stripe, "customers" | "subscriptions" | "subscriptionSchedules" | "prices" | "checkout" | "billingPortal" | "webhooks" | "invoices" | "invoicePayments" | "paymentIntents" | "charges" | "refunds" | "disputes">

export function assertBillingMappingMode(mapping: {livemode:number}) {
  if (Boolean(mapping.livemode) !== stripeLiveMode()) throw new AppError(409,"billing_mode_cutover_required","This company has a customer in the other Stripe mode. A platform operator must complete an explicit billing cutover; existing access and records are retained.")
}

export function stripeLiveMode() {
  const mode = process.env.MCA_STRIPE_MODE
  if (mode !== "test" && mode !== "live") throw new AppError(503, "billing_mode_unconfigured", "Set the explicit Stripe billing mode to test or live.")
  return mode === "live"
}

export function getStripeClient(): StripeBillingClient {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  const key = process.env.STRIPE_SECRET_KEY?.trim()
  if (!key || !(stripeLiveMode() ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/).test(key)) throw new AppError(503, "billing_mode_mismatch", "Stripe credentials must match the configured billing mode.")
  return new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15_000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() })
}

export function priceIds() {
  const base = process.env.STRIPE_BASE_PRICE_ID?.trim()
  const seats = process.env.STRIPE_ADDITIONAL_SEAT_PRICE_ID?.trim()
  if (!base || !seats || base === seats || ![base, seats].every(id => /^price_[A-Za-z0-9]+$/.test(id)))
    throw new AppError(503, "billing_catalog_unconfigured", "The company plan catalog needs administrator configuration.")
  return { base, seats }
}

export async function verifyBillingPrices(client: StripeBillingClient) {
  const ids = priceIds()
  const [base, seats] = await Promise.all([client.prices.retrieve(ids.base), client.prices.retrieve(ids.seats, { expand: ["tiers"] })])
  const common = (p: Stripe.Price) => p.livemode === stripeLiveMode() && p.active && p.currency === BILLING_CATALOG.currency && p.recurring?.interval === BILLING_CATALOG.interval && p.recurring.interval_count === 1 && p.recurring.usage_type === BILLING_CATALOG.usageType && !p.transform_quantity
  const tiers = seats.tiers ?? []
  if (!common(base) || base.billing_scheme !== BILLING_CATALOG.base.billingScheme || base.unit_amount !== BILLING_CATALOG.base.unitAmountCents || !common(seats) || seats.billing_scheme !== BILLING_CATALOG.additionalSeats.billingScheme || seats.tiers_mode !== BILLING_CATALOG.additionalSeats.tiersMode || tiers.length !== BILLING_CATALOG.additionalSeats.tiers.length ||
    tiers.some((t, i) => t.up_to !== BILLING_CATALOG.additionalSeats.tiers[i].upTo || t.unit_amount !== BILLING_CATALOG.additionalSeats.tiers[i].unitAmountCents || (t.flat_amount ?? 0) !== 0))
    throw new AppError(503, "billing_price_mismatch", "Stripe prices must match the monthly USD Fundlane graduated seat catalog.")
  return ids
}

export interface BillingSubscription {
  id: string
  customer: string | { id: string }
  status: string
  livemode: boolean
  cancel_at_period_end?: boolean
  pause_collection?: unknown
  pending_update?: unknown
  schedule?: string | { id: string } | null
  start_date?: number
  ended_at?: number | null
  cancel_at?: number | null
  current_period_start?: number | null
  current_period_end?: number | null
  items: { data: Array<{ id?: string; quantity?: number | null; current_period_start?: number; current_period_end?: number; price: { id: string } }> }
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

function fundlaneSubscriptionItems(subscription: BillingSubscription) {
  const ids = priceIds()
  const items = subscription.items?.data ?? []
  const item = items.find(i => i.price.id === ids.base)
  const additional = items.find(i => i.price.id === ids.seats)
  if (!item || item.quantity !== 1 || items.length !== (additional ? 2 : 1) || (additional && (!Number.isSafeInteger(additional.quantity) || additional.quantity! < 1))) throw new AppError(503, "billing_plan_unknown", "This company subscription needs administrator configuration.")
  return { item, additional }
}

/** Verify ownership before selecting catalog subscriptions, including canceled debt. */
function fundlaneSubscriptions(subscriptions: BillingSubscription[], customerId: string) {
  const ids = priceIds()
  return subscriptions.filter(subscription => {
    if ((typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id) !== customerId || subscription.livemode !== stripeLiveMode())
      throw new AppError(503, "billing_customer_mismatch", "Company billing identity could not be verified.")
    if (!subscription.items?.data.some(item => item.price.id === ids.base || item.price.id === ids.seats)) return false
    fundlaneSubscriptionItems(subscription)
    return true
  })
}

export function subscriptionEntitlement(subscription: BillingSubscription): BillingEntitlement {
  if (subscription.livemode !== stripeLiveMode()) throw new AppError(503, "billing_mode_mismatch", "Subscription mode does not match configured billing mode.")
  // Scheduled cancellations remain active at Stripe until period end. Immediately canceled
  // subscriptions must not retain extra seats just because a future period_end remains set.
  if (["canceled", "incomplete_expired"].includes(subscription.status)) return { ...freeEntitlement(), status: subscription.status }
  if (!["active", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))
    throw new AppError(503, "billing_subscription_unavailable", "This subscription requires administrator review.")
  const { item, additional } = fundlaneSubscriptionItems(subscription)
  if (subscription.status === "incomplete") return { ...freeEntitlement(), status: "incomplete", paymentPastDue: true }
  return { subscriptionId: subscription.id, planId: item.price.id, planSlug: "fundlane", planName: "Fundlane", status: subscription.status,
    periodStart: iso(item.current_period_start ?? subscription.current_period_start), periodEnd: iso(item.current_period_end ?? subscription.current_period_end),
    seatLimit: 1 + (additional?.quantity ?? 0), paymentPastDue: subscription.status !== "active" || Boolean(subscription.pause_collection) }
}

function currentEntitlement(subscriptions: BillingSubscription[], customerId: string) {
  for (const subscription of subscriptions) {
    if ((typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id) !== customerId || subscription.livemode !== stripeLiveMode())
      throw new AppError(503, "billing_customer_mismatch", "Company billing identity could not be verified.")
  }
  const managed = fundlaneSubscriptions(subscriptions, customerId)
  const eligible = managed.filter(value => !["canceled", "incomplete_expired"].includes(value.status))
  if (eligible.length > 1) throw new AppError(503, "billing_multiple_subscriptions", "Multiple company subscriptions require administrator review.")
  return eligible.length ? subscriptionEntitlement(eligible[0]) : { ...freeEntitlement(), status: managed.some(s => s.status === "canceled") ? "canceled" : "none" }
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
  const previous = await db.prepare<{status:string;seat_limit:number;stripe_subscription_id:string|null;period_end:string|null;payment_past_due:number}>("SELECT status,seat_limit,stripe_subscription_id,period_end,payment_past_due FROM workspace_billing_entitlements WHERE workspace_id=?").get(workspaceId)
  await db.prepare(`INSERT INTO workspace_billing_entitlements (workspace_id, stripe_subscription_id, stripe_price_id, plan_slug, plan_name, status, period_start, period_end, seat_limit, payment_past_due, source, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id) DO UPDATE SET stripe_subscription_id=EXCLUDED.stripe_subscription_id, stripe_price_id=EXCLUDED.stripe_price_id, plan_slug=EXCLUDED.plan_slug, plan_name=EXCLUDED.plan_name, status=EXCLUDED.status, period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end, seat_limit=EXCLUDED.seat_limit, payment_past_due=EXCLUDED.payment_past_due, source=EXCLUDED.source, synced_at=EXCLUDED.synced_at`)
    .run(workspaceId, current.subscriptionId, current.planId, current.planSlug, current.planName, current.status, current.periodStart, current.periodEnd, current.seatLimit, current.paymentPastDue ? 1 : 0, source, syncedAt)
  await db.prepare("UPDATE workspaces SET seat_limit = ?, updated_at = ? WHERE id = ?").run(current.seatLimit, syncedAt, workspaceId)
  if (!previous || previous.status !== current.status || previous.seat_limit !== current.seatLimit || previous.stripe_subscription_id !== current.subscriptionId || previous.period_end !== current.periodEnd || Boolean(previous.payment_past_due)!==current.paymentPastDue) await recordAuditEvent({ context:{workspaceId,userId:null,source:"system"},action:"billing.entitlement_reconciled",resourceType:"workspace",resourceId:workspaceId,metadata:{before:previous??null,after:current},executor:db })
  return { ...current, source, syncedAt }
}

export async function syncWorkspaceBilling(workspaceId: string, providedClient?: StripeBillingClient) {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    const mapping = await db.prepare<{ stripe_customer_id: string; livemode:number }>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
    if (!mapping) {
      const access = await getCompanyAccess(workspaceId)
      return { ...freeEntitlement(), status: access.status, seatLimit: access.seatLimit, source: "free" as const, syncedAt: nowIso() }
    }
    assertBillingMappingMode(mapping)
    const client = providedClient ?? getStripeClient()
    let live: BillingSubscription[]
    try {
      const result = await client.subscriptions.list({ customer: mapping.stripe_customer_id, status: "all", limit: 100 })
      if (result.has_more) throw new Error("Subscription pagination requires administrator review")
      live = result.data as BillingSubscription[]
    } catch { throw new AppError(503, "billing_unavailable", "Company billing verification is temporarily unavailable. Existing access is unchanged; please retry.") }
    live = fundlaneSubscriptions(live, mapping.stripe_customer_id)
    let current = currentEntitlement(live, mapping.stripe_customer_id)
    await ensureBillingState(workspaceId, db)
    const accessHistory = await db.prepare<{legacy_exempt:number;access_extended_until:string|null}>("SELECT legacy_exempt,access_extended_until FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    const successor = live.find(s=>s.id===current.subscriptionId)
    if (!accessHistory?.legacy_exempt) for (const ended of live) {
      if (ended.status !== "canceled" || !ended.ended_at) continue
      const boundary = Math.max(ended.ended_at*1000,accessHistory?.access_extended_until?Date.parse(accessHistory.access_extended_until):0)
      // A canceled overlapping historical contract did not interrupt a successor already running.
      if (successor && (!successor.start_date || successor.start_date*1000<=boundary)) continue
      if (boundary<=Date.now()) await recordCompanyPauseBoundary(workspaceId,new Date(boundary).toISOString(),db)
    }
    if (!current.subscriptionId) current.seatLimit = (await getCompanyAccess(workspaceId)).seatLimit
    await verifyBillingPrices(client)
    const subscription = live.find(s => s.id === current.subscriptionId)
    const reconciled = await reconcileBillingInvoices(workspaceId, mapping.stripe_customer_id, subscription, live, client, db)
    if (reconciled.subscriptionChanged && subscription) {
      const refreshed = await client.subscriptions.retrieve(subscription.id)
      current = currentEntitlement([refreshed],mapping.stripe_customer_id)
    }
    // Only paid invoices may establish or enlarge capacity. Pending Stripe updates
    // leave the original items in place until their proration invoice is paid.
    const previous = await db.prepare<{ seat_limit: number }>("SELECT seat_limit FROM workspace_billing_entitlements WHERE workspace_id=?").get(workspaceId)
    const unpaid = reconciled.hasUnpaidInvoices
    const paid = current.subscriptionId ? await db.prepare<{paid_at:string|null}>("SELECT paid_at FROM company_billing_invoices WHERE workspace_id=? AND stripe_subscription_id=? AND status='paid' ORDER BY created_at LIMIT 1").get(workspaceId, current.subscriptionId) : null
    if (current.status === "active" && !paid) { current.status = "incomplete"; current.paymentPastDue = true; current.seatLimit = previous?.seat_limit ?? 1 }
    if (unpaid && current.seatLimit > (previous?.seat_limit ?? 1)) current.seatLimit = previous?.seat_limit ?? 1
    if (subscription && current.status === "active" && !unpaid) {
      await captureCompanyPauseBoundary(workspaceId,db,paid?.paid_at ? Date.parse(paid.paid_at) : Date.now())
      const converted = await db.prepare("UPDATE company_subscription_state SET legacy_exempt=0 WHERE workspace_id=? AND legacy_exempt=1").run(workspaceId)
      if (converted.changes) await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.legacy_exemption_converted",resourceType:"workspace",resourceId:workspaceId,metadata:{subscriptionId:current.subscriptionId},executor:db})
      await db.prepare("UPDATE company_subscription_state SET legacy_exempt=0, selected_seats=?, updated_at=? WHERE workspace_id=?").run(current.seatLimit, nowIso(), workspaceId)
      const reduction = await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL WHERE workspace_id=? AND pending_seats=? AND pending_seats_at<=?").run(workspaceId, current.seatLimit, nowIso())
      if (reduction.changes) await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.seat_reduction_applied",resourceType:"workspace",resourceId:workspaceId,metadata:{seatLimit:current.seatLimit},executor:db})
    }
    // Read the synchronized data, but confirm it against live Stripe before any capacity
    // grant. A delayed, missing or out-of-order sync cannot issue unpaid seats.
    const snapshot = await readSyncedSubscriptions(mapping.stripe_customer_id, db)
    let matchingSnapshot = false
    if (snapshot) {
      try { matchingSnapshot = JSON.stringify(currentEntitlement(snapshot, mapping.stripe_customer_id)) === JSON.stringify(current) }
      catch { /* An outdated sync row cannot override verified provider state. */ }
    }
    const recoveryMetadata = { customerId: mapping.stripe_customer_id, livemode: Boolean(mapping.livemode), recovery: reconciled.recovery }
    const previousRecovery = await db.prepare<{ action: string; metadata: string }>("SELECT action,metadata FROM audit_events WHERE workspace_id=? AND action IN ('billing.recovery_verified','billing.recovery_verification_failed') ORDER BY created_at DESC LIMIT 1").get(workspaceId)
    if (previousRecovery?.action !== "billing.recovery_verified" || JSON.stringify(JSON.parse(previousRecovery.metadata)) !== JSON.stringify(recoveryMetadata)) await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "billing.recovery_verified", resourceType: "workspace", resourceId: workspaceId, metadata: recoveryMetadata, executor: db })
    return persistEntitlement(workspaceId, current, matchingSnapshot ? "sync_engine" : "stripe_api", db)
  }, { onRollback: async () => {
    // The outermost caller may fail after this reconciliation succeeds. Record
    // incomplete verification only after that transaction releases its locks/client.
    await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "billing.recovery_verification_failed", resourceType: "workspace", resourceId: workspaceId, metadata: {} })
  } })
}

/** Call within the same workspace-locked transaction that inserts the seat reservation. */
export async function assertBillingCapacity(workspaceId: string, additionalSeats = 1, client?: StripeBillingClient) {
  if (!Number.isSafeInteger(additionalSeats) || additionalSeats < 0) throw new AppError(422, "invalid_seat_count", "Seat count must be a non-negative integer.")
  const mapping = await getDatabase().prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
  if (mapping && billingEnabled()) await syncWorkspaceBilling(workspaceId, client)
  const plan = await getCompanyAccess(workspaceId)
  if (!plan.allowed) throw new AppError(402, "company_paused", "Recover company access in Plans & Billing before inviting users.")
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('active','pending')").get(workspaceId)
  if ((usage?.count ?? 0) + additionalSeats > plan.seatLimit) throw new AppError(409, "seat_limit_reached", "Your company has used its plan's seats. Upgrade in Plans & Billing or free a reserved seat.")
}

export async function getWorkspaceBilling(workspaceId: string) {
  const billing = await getDatabase().prepare(`SELECT stripe_subscription_id AS "subscriptionId", stripe_price_id AS "planId", plan_slug AS "planSlug", plan_name AS "planName", status, period_start AS "periodStart", period_end AS "periodEnd", seat_limit AS "seatLimit", payment_past_due AS "paymentPastDue", source, synced_at AS "syncedAt" FROM workspace_billing_entitlements WHERE workspace_id = ?`).get(workspaceId)
  const usage = await getDatabase().prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id = ? AND status IN ('active','pending')").get(workspaceId)
  const customer = await getDatabase().prepare<{livemode:number;stripe_customer_id:string}>("SELECT livemode,stripe_customer_id FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
  const state = await getDatabase().prepare("SELECT * FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
  const recovery = await readBillingRecovery(workspaceId, customer)
  return { enabled: billingEnabled(), testMode: process.env.MCA_STRIPE_MODE !== "live", billing: billing ?? null, occupiedSeats: usage?.count ?? 0, canManagePayment: Boolean(customer), modeCutoverRequired: !!customer && Boolean(customer.livemode) !== (process.env.MCA_STRIPE_MODE === "live"), access: await getCompanyAccess(workspaceId), state, recovery }
}

async function readBillingRecovery(workspaceId: string, customer: { livemode: number; stripe_customer_id: string } | undefined): Promise<import("./billing-display").BillingRecovery> {
  const empty = { overdueAmount: 0, paymentRequired: false, verificationPending: !!customer, invoices: [] }
  if (!customer || Boolean(customer.livemode) !== (process.env.MCA_STRIPE_MODE === "live")) return empty
  const db = getDatabase()
  const snapshot = await db.prepare<{ metadata: string; created_at: string }>(`SELECT metadata,created_at FROM audit_events WHERE workspace_id=? AND action='billing.recovery_verified' AND metadata::jsonb->>'customerId'=? AND metadata::jsonb->>'livemode'=? ORDER BY created_at DESC LIMIT 1`).get(workspaceId, customer.stripe_customer_id, String(Boolean(customer.livemode)))
  if (!snapshot) return empty
  const { recovery } = JSON.parse(snapshot.metadata) as { recovery: import("./billing-display").BillingRecovery }
  const failure = await db.prepare("SELECT id FROM audit_events WHERE workspace_id=? AND action='billing.recovery_verification_failed' AND created_at>=? LIMIT 1").get(workspaceId, snapshot.created_at)
  return { ...recovery, verificationPending: recovery.verificationPending || !!failure }
}

function billingReturnUrl(onboarding: boolean) {
  const raw = process.env.MCA_APP_ORIGIN
  if (!raw) throw new AppError(503, "billing_origin_unconfigured", "The application origin is not configured.")
  const url = new URL(raw)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new AppError(503, "billing_origin_invalid", "The application origin requires HTTPS.")
  return `${url.origin}${onboarding ? "/onboarding?setup=1" : "/settings/billing"}`
}

// One company-subscription flow across onboarding/settings. The eight-letter suffix
// was randomly generated once; keep it stable across sessions, retries and releases.
const COMPANY_CHECKOUT_INTEGRATION_IDENTIFIER = "fundlane_company_subscription_ndmotxpw"

export async function createBillingCheckout(workspaceId: string, selectedSeats: number, onboarding = false, providedClient?: StripeBillingClient) {
  monthlyPriceCents(selectedSeats)
  const client = providedClient ?? getStripeClient()
  const ids = await verifyBillingPrices(client)
  const slug = `fundlane:${selectedSeats}`
  const returnUrl = billingReturnUrl(onboarding)
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare<{ name: string }>("SELECT name FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    await assertOccupiedSeats(workspaceId, selectedSeats, db)
    await ensureBillingState(workspaceId, db)
    let mapping = await db.prepare<{ stripe_customer_id: string; livemode:number; checkout_session_id: string | null; checkout_plan_slug: string | null }>("SELECT stripe_customer_id, livemode, checkout_session_id, checkout_plan_slug FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
    if (mapping) assertBillingMappingMode(mapping)
    if (!mapping) {
      const customer = await client.customers.create({ name: workspace.name, metadata: { workspace_id: workspaceId } }, { idempotencyKey: `fundlane-${stripeLiveMode() ? "live" : "test"}-customer-${workspaceId}` })
      if (customer.livemode !== stripeLiveMode()) throw new AppError(503, "billing_mode_mismatch", "Customer mode mismatch.")
      await db.prepare("INSERT INTO workspace_stripe_customers (workspace_id, stripe_customer_id, livemode, created_at) VALUES (?, ?, ?, ?)").run(workspaceId, customer.id, stripeLiveMode()?1:0, nowIso())
      mapping = { stripe_customer_id: customer.id, livemode:stripeLiveMode()?1:0, checkout_session_id: null, checkout_plan_slug: null }
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
    const slot = Math.floor(Date.now() / 1800000)
    const session = await client.checkout.sessions.create({ mode: "subscription", customer: mapping.stripe_customer_id,
      integration_identifier: COMPANY_CHECKOUT_INTEGRATION_IDENTIFIER,
      client_reference_id: workspaceId, metadata: { workspace_id: workspaceId }, subscription_data: { metadata: { workspace_id: workspaceId }, billing_mode: { type: "flexible" } },
      line_items: [{ price: ids.base, quantity: 1 }, ...(selectedSeats > 1 ? [{ price: ids.seats, quantity: selectedSeats - 1 }] : [])],
      success_url: returnUrl, cancel_url: returnUrl, expires_at: (slot + 2) * 1800,
    }, { idempotencyKey: `fundlane-checkout-${workspaceId}-${slug}-${mapping.checkout_session_id ?? "initial"}-${slot}` })
    if (session.livemode !== stripeLiveMode() || !session.url) throw new AppError(503, "billing_checkout_unavailable", "Checkout is temporarily unavailable.")
    await db.prepare("UPDATE workspace_stripe_customers SET checkout_session_id = ?, checkout_plan_slug = ? WHERE workspace_id = ?").run(session.id, slug, workspaceId)
    return { url: session.url }
  })
}

export async function createBillingPortal(workspaceId: string, onboarding = false, providedClient?: StripeBillingClient) {
  const client = providedClient ?? getStripeClient()
  const configuration = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION
  if (!configuration) throw new AppError(503,"billing_portal_unconfigured","Configure the payment and cancellation portal.")
  const settings = await client.billingPortal.configurations.retrieve(configuration)
  if (!settings.active || settings.livemode !== stripeLiveMode() || settings.features.subscription_update.enabled || !settings.features.payment_method_update.enabled || !settings.features.invoice_history.enabled || !settings.features.subscription_cancel.enabled || settings.features.subscription_cancel.mode !== "at_period_end") throw new AppError(503,"billing_portal_configuration_invalid","Portal must allow payment methods, invoices and cancellation at period end; seat changes use application billing.")
  const mapping = await getDatabase().prepare<{ stripe_customer_id: string;livemode:number }>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
  if (!mapping) throw new AppError(409, "billing_customer_required", "Choose a paid plan before opening payment settings.")
  assertBillingMappingMode(mapping)
  const customer = await client.customers.retrieve(mapping.stripe_customer_id)
   if (customer.deleted || customer.livemode !== stripeLiveMode() || customer.metadata.workspace_id !== workspaceId) throw new AppError(503, "billing_customer_mismatch", "Company billing identity could not be verified.")
  const portal = await client.billingPortal.sessions.create({ customer: mapping.stripe_customer_id, return_url: billingReturnUrl(onboarding), configuration })
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
  if (event.livemode !== stripeLiveMode()) throw new AppError(400, "billing_mode_mismatch", "Webhook mode mismatch.")
  if (!/^(customer\.subscription\.|invoice\.|charge\.(refunded|dispute\.)|refund\.|checkout\.session\.(completed|async_payment_succeeded|async_payment_failed|expired)$)/.test(event.type)) return { ignored: true }
  const object = event.data.object as unknown as { id?: string; customer?: string | { id: string }; charge?:string|{id:string}; hosted_invoice_url?:string|null }
  let customerId = typeof object.customer === "string" ? object.customer : object.customer?.id
  if (!customerId && object.charge) {
    const charge = await (providedClient??getStripeClient()).charges.retrieve(typeof object.charge==="string"?object.charge:object.charge.id)
    if (charge.livemode !== stripeLiveMode()) throw new AppError(400,"billing_mode_mismatch","Charge mode mismatch.")
    customerId = typeof charge.customer==="string"?charge.customer:charge.customer?.id
  }
  if (!customerId) return { ignored: true }
  return withImmediateTransaction(async db => {
    const mapping = await db.prepare<{ workspace_id: string; livemode: number }>("SELECT workspace_id,livemode FROM workspace_stripe_customers WHERE stripe_customer_id = ?").get(customerId)
    if (!mapping) return { ignored: true }
    if (Boolean(mapping.livemode) !== event.livemode) throw new AppError(400,"billing_mode_mismatch","Webhook customer mode mismatch.")
    const receipt = await db.prepare("INSERT INTO stripe_billing_events (event_id, event_type, stripe_customer_id, workspace_id, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING").run(event.id, event.type, customerId, mapping.workspace_id, nowIso())
    if (!receipt.changes) return { duplicate: true }
    if (object.id && event.type === "invoice.payment_action_required") {
      await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:action-required:${object.id}`,"payment_action_required",{invoiceId:object.id,invoiceUrl:object.hosted_invoice_url??null})
    } else if (object.id && event.type === "invoice.payment_failed") {
      await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:payment-failed:${object.id}`,"payment_failed",{invoiceId:object.id})
    }
    await db.prepare(`INSERT INTO mca_background_jobs
      (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,available_at,created_at,updated_at)
      VALUES (?,?,'billing_reconcile',?,?,'{}','{}','billing_reconcile','queued',?,?,?)`).run(newId(),mapping.workspace_id,event.id,event.id,nowIso(),nowIso(),nowIso())
    // The cron claims this durable job and re-reads Stripe. Signed event fields
    // are notification context, never an entitlement source.
    return { queued: true }
  })
}

async function ensureBillingState(workspaceId: string, db: DbExecutor) {
  await db.prepare(`INSERT INTO company_subscription_state (workspace_id,legacy_exempt,selected_seats,updated_at)
    SELECT id,1,seat_limit,? FROM workspaces WHERE id=? ON CONFLICT(workspace_id) DO NOTHING`).run(nowIso(), workspaceId)
}
async function assertOccupiedSeats(workspaceId: string, seats: number, db: DbExecutor) {
  const used = await db.prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id=? AND status IN ('active','pending')").get(workspaceId)
  if ((used?.count ?? 0) > seats) throw new AppError(409, "billing_seats_occupied", "Remove active users or revoke pending invitations before reducing seats.")
}

/** Copy writable phase settings, retaining discounts/tax/payment settings as well as seats. */
function cancellationPhase(phase: Stripe.SubscriptionSchedule.Phase, end: number): Stripe.SubscriptionScheduleUpdateParams.Phase {
  // Response-only fields and nulls aren't accepted as update parameters. Expanded
  // Stripe resources become IDs; metadata is opaque and must not be transformed.
  function writable(value: unknown, key = ""): unknown {
    if (key === "metadata") return value
    if (key === "discounts" && Array.isArray(value)) return value.map(discount => {
      const field = discount.discount ? "discount" : discount.promotion_code ? "promotion_code" : "coupon"
      const resource = discount[field]
      return { [field]: typeof resource === "string" ? resource : resource.id }
    })
    if (Array.isArray(value)) return value.map(v => writable(v))
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>
      if (typeof object.object === "string" && typeof object.id === "string") return object.id
      return Object.fromEntries(Object.entries(object).filter(([k,v]) => v != null && k !== "plan" && k !== "disabled_reason").map(([k,v]) => [k,writable(v,k)]))
    }
    return value
  }
  return { ...(writable(phase) as Stripe.SubscriptionScheduleUpdateParams.Phase), end_date: end, proration_behavior: "none" }
}

/** Recovery action: deliberately does not require paid access or successful invoice reconciliation. */
export async function cancelBillingSubscription(workspaceId: string, actorUserId: string, providedClient?: StripeBillingClient) {
  const client = providedClient ?? getStripeClient()
  return withImmediateTransaction(async db => {
    if (!await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)) throw new AppError(404,"workspace_not_found","Company not found.")
    const mapping = await db.prepare<{stripe_customer_id:string;livemode:number}>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
    if (!mapping) throw new AppError(409,"billing_subscription_missing","There is no company subscription to cancel.")
    assertBillingMappingMode(mapping)
    const listed = await client.subscriptions.list({customer:mapping.stripe_customer_id,status:"all",limit:100})
    if (listed.has_more) throw new AppError(503,"billing_multiple_subscriptions","Company subscriptions require administrator review.")
    const subscriptions = fundlaneSubscriptions(listed.data,mapping.stripe_customer_id)
    const active = subscriptions.filter(s=>!["canceled","incomplete_expired"].includes(s.status))
    if (active.length > 1) throw new AppError(409,"billing_multiple_subscriptions","Multiple company subscriptions require administrator review.")
    if (!active.length) {
      if (subscriptions.some(s=>s.status==="canceled")) {
        await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
        return {cancelAt:null,alreadyCanceled:true}
      }
      throw new AppError(409,"billing_subscription_missing","There is no company subscription to cancel.")
    }
    let sub: BillingSubscription = await client.subscriptions.retrieve(active[0].id)
    if (fundlaneSubscriptions([sub],mapping.stripe_customer_id).length!==1) throw new AppError(409,"billing_plan_unknown","The company subscription could not be verified.")
    if (sub.status === "canceled") return {cancelAt:iso(sub.ended_at),alreadyCanceled:true}
    const {item} = fundlaneSubscriptionItems(sub)
    const periodEnd = item.current_period_end ?? sub.current_period_end
    if (!periodEnd || periodEnd <= Date.now()/1000) throw new AppError(409,"billing_period_unavailable","Refresh billing and retry cancellation once the current billing period is verified.")
    // Never postpone an earlier cancellation already requested at Stripe.
    const end = sub.cancel_at ? Math.min(sub.cancel_at,periodEnd) : periodEnd
    const previous = await db.prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action='billing.cancellation_scheduled' AND resource_id=?").get(workspaceId,sub.id)
    // A later cancellation after a Portal/operator reversal needs a new key;
    // failures before local commit keep the same generation on retry.
    const generation = previous?.count ?? 0
    if (sub.schedule) {
      const schedule = await client.subscriptionSchedules.retrieve(typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id)
      const id = (value:string|{id:string}|null) => typeof value === "string" ? value : value?.id
      if (id(schedule.customer)!==mapping.stripe_customer_id || id(schedule.subscription)!==sub.id || schedule.livemode!==stripeLiveMode() || schedule.status!=="active") throw new AppError(409,"billing_schedule_unverified","The subscription schedule could not be verified. Refresh billing and retry.")
      const phase = schedule.phases.find(p=>p.start_date===schedule.current_phase?.start_date)
      if (!phase || phase.start_date>=end) throw new AppError(409,"billing_schedule_unverified","The current billing phase could not be verified. Refresh billing and retry.")
      // Atomic provider operation: there is never a released, renewing subscription
      // between two mutations. No future reduction phase can renew the contract.
      if (schedule.end_behavior!=="cancel" || schedule.phases.at(-1)?.end_date!==end) {
        await client.subscriptionSchedules.update(schedule.id,{end_behavior:"cancel",proration_behavior:"none",phases:[cancellationPhase(phase,end)]},{idempotencyKey:`fundlane-cancel-schedule-${schedule.id}-${end}-${generation}`})
      }
    } else if (!(sub.cancel_at && sub.cancel_at<=periodEnd) && !sub.cancel_at_period_end) {
      await client.subscriptions.update(sub.id,{cancel_at_period_end:true,proration_behavior:"none"},{idempotencyKey:`fundlane-cancel-${sub.id}-${end}-${generation}`})
    }
    // A lost response or DB rollback is repaired by re-reading provider state on
    // retry. Never report success based on the mutation response alone.
    sub = await client.subscriptions.retrieve(sub.id)
    fundlaneSubscriptions([sub],mapping.stripe_customer_id)
    if (sub.status!=="canceled" && sub.cancel_at!==end && !(sub.cancel_at_period_end && (sub.items.data.find(i=>i.price.id===priceIds().base)?.current_period_end ?? sub.current_period_end)===end)) throw new AppError(503,"billing_cancellation_unverified","Cancellation could not yet be verified. Retry cancellation to confirm; existing invoices remain due.")
    await ensureBillingState(workspaceId,db)
    await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
    await recordAuditEvent({context:{workspaceId,userId:actorUserId},action:"billing.cancellation_scheduled",resourceType:"subscription",resourceId:sub.id,metadata:{cancelAt:iso(end)},executor:db})
    return {cancelAt:iso(end),alreadyCanceled:sub.status==="canceled"}
  }).catch(error => {
    if (error instanceof AppError) throw error
    throw new AppError(503,"billing_cancellation_unavailable","Cancellation could not yet be confirmed. Retry cancellation to verify the effective date; outstanding invoices remain due.")
  })
}

/** Paid increases use Stripe pending updates, so failed payment cannot grant seats. */
export async function changeBillingSeats(workspaceId: string, selectedSeats: number, actorUserId: string, providedClient?: StripeBillingClient) {
  monthlyPriceCents(selectedSeats)
  const client = providedClient ?? getStripeClient()
  const ids = await verifyBillingPrices(client)
  return withImmediateTransaction(async db => {
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    await assertOccupiedSeats(workspaceId, selectedSeats, db)
    const current = await syncWorkspaceBilling(workspaceId, client)
    if (!current.subscriptionId || current.status !== "active" || current.paymentPastDue) throw new AppError(409, "billing_payment_required", "An active paid subscription is required to change purchased seats.")
    const state = await db.prepare<{ pending_seats: number | null; stripe_schedule_id: string | null }>("SELECT pending_seats,stripe_schedule_id FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    if (state?.pending_seats) {
      if (state.pending_seats === selectedSeats) return getWorkspaceBilling(workspaceId)
      throw new AppError(409, "billing_change_pending", "A seat reduction is already scheduled. Wait for renewal before requesting another change.")
    }
    const sub = await client.subscriptions.retrieve(current.subscriptionId)
    if (sub.pending_update || sub.cancel_at_period_end || sub.cancel_at) throw new AppError(409, "billing_change_pending", "Resolve the pending subscription change before changing seats.")
    if (selectedSeats === current.seatLimit) return getWorkspaceBilling(workspaceId)
    const additional = sub.items.data.find(i => i.price.id === ids.seats)
    if (selectedSeats > current.seatLimit) {
      if (sub.schedule) throw new AppError(409,"billing_change_pending","A subscription schedule must finish before increasing seats.")
      await client.subscriptions.update(sub.id, {
        payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice",
        items: [{ ...(additional ? { id: additional.id } : { price: ids.seats }), quantity: selectedSeats - 1 }],
      }, { idempotencyKey: `fundlane-seats-${sub.id}-${current.periodStart}-${current.seatLimit}-${selectedSeats}` })
    } else {
      // Stripe forbids metadata (and every other parameter) with from_subscription.
      // Replay the exact creation request to prove ownership after create succeeded
      // but metadata/update or local commit failed. Metadata alone isn't proof.
      const creation = () => client.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `fundlane-schedule-${sub.id}-${current.periodStart}` })
      let schedule: Stripe.SubscriptionSchedule
      if (sub.schedule) {
        const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id
        schedule = await client.subscriptionSchedules.retrieve(scheduleId)
        let replay: Stripe.SubscriptionSchedule
        try { replay = await creation() }
        catch { throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review; its creation could not be verified.") }
        if (replay.id !== scheduleId) throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review; its creation does not match this request.")
        // Use the fresh retrieval, not the cached creation response: an update may
        // already have succeeded, or an operator may have changed this schedule.
      } else schedule = await creation()
      const resourceId = (value: string | {id:string} | null) => typeof value === "string" ? value : value?.id
      if (resourceId(schedule.customer)!==resourceId(sub.customer) || resourceId(schedule.subscription)!==sub.id || schedule.livemode!==stripeLiveMode() || schedule.status!=="active" || schedule.end_behavior==="cancel" ||
        (schedule.metadata?.workspace_id && schedule.metadata.workspace_id!==workspaceId) || (schedule.metadata?.selected_seats && schedule.metadata.selected_seats!==String(selectedSeats))) throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review.")
      const phase = schedule.phases[0]
      await client.subscriptionSchedules.update(schedule.id, { metadata: { workspace_id: workspaceId, selected_seats: String(selectedSeats) }, end_behavior: "release", proration_behavior: "none", phases: [
        { start_date: phase.start_date, end_date: phase.end_date, items: sub.items.data.map(i => ({ price: i.price.id, quantity: i.quantity ?? 1 })), proration_behavior: "none" },
        { start_date: phase.end_date, items: [{ price: ids.base, quantity: 1 }, ...(selectedSeats > 1 ? [{ price: ids.seats, quantity: selectedSeats - 1 }] : [])], proration_behavior: "none", duration: { interval: "month", interval_count: 1 } },
      ] }, { idempotencyKey: `fundlane-reduce-${schedule.id}-${selectedSeats}` })
      await db.prepare("UPDATE company_subscription_state SET pending_seats=?,pending_seats_at=?,stripe_schedule_id=?,updated_at=? WHERE workspace_id=?").run(selectedSeats, new Date(phase.end_date * 1000).toISOString(), schedule.id, nowIso(), workspaceId)
    }
    await recordAuditEvent({ context: { workspaceId, userId: actorUserId }, action: "billing.seats_changed", resourceType: "workspace", resourceId: workspaceId, metadata: { from: current.seatLimit, to: selectedSeats, effective: selectedSeats > current.seatLimit ? "after_payment" : "renewal" }, executor: db })
    await syncWorkspaceBilling(workspaceId, client)
    return getWorkspaceBilling(workspaceId)
  })
}
