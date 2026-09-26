import "server-only"
import Stripe from "stripe"
import { getDatabase, newId, nowIso, withImmediateTransaction, recordAuditEvent, type DbExecutor } from "./db"
import { AppError } from "./errors"
import { BILLING_CATALOG, monthlyPriceCents, TRIAL_DAYS } from "./billing-catalog"
import { getCompanyAccess, captureCompanyPauseBoundary, recordCompanyPauseBoundary } from "./company-access"
export { initializeCompanyTrial } from "./company-access"
import { enqueueBillingNotification, reconcileBillingInvoices } from "./billing-reconciliation"
import { webhookVerificationTime } from "./maintenance/replay-clock"
import { recordOperationalError } from "./operations/telemetry"
import { isStripeCheckoutTrialConfigured, readPriceIds, readStripeSecretKey, stripeSecretKeyPattern } from "./stripe-checkout-trial"
import { recordTrialGrant, releaseTrialReservation, reserveTrialForCheckout, trialAbuseLimitsEnabled, trialAllowedForOwner } from "./trial-abuse"
import { stripeTrialLifecycleEnabled } from "./billing-flags"
export { stripeCheckoutTrialConfiguration, isStripeCheckoutTrialConfigured } from "./stripe-checkout-trial"

export const billingEnabled = () => process.env.MCA_STRIPE_BILLING_ENABLED === "true"
const stripeTaxEnabled = () => process.env.MCA_STRIPE_TAX_ENABLED === "true"
const automaticTaxWhenEnabled = () => stripeTaxEnabled() ? { automatic_tax: { enabled: true } as const } : {}
export const missingBillingStateFailsClosed = () => process.env.MCA_BILLING_MISSING_STATE_FAIL_CLOSED === "true"
export { stripeTrialLifecycleEnabled } from "./billing-flags"
export const billingSeatSyncEnabled = () => process.env.MCA_BILLING_SEAT_SYNC_ENABLED === "true" && billingEnabled()
export const seatsCountPendingInvites = () => process.env.MCA_BILLING_SEATS_COUNT_PENDING_INVITES === "true"
/** The sole licensed-count definition for automatic synchronization. */
export async function licensedSeatCount(workspaceId: string, db: DbExecutor = getDatabase()) {
  const row = await db.prepare<{count:number}>(`SELECT count(*)::int count FROM memberships WHERE workspace_id=? AND (status='active' OR (status='pending' AND ?::boolean))`).get(workspaceId,seatsCountPendingInvites())
  return Math.max(1,row?.count ?? 0)
}

// Historical Clerk migration scripts retain their original role mapping.
export const BILLING_ADMIN_ROLE = "org:mca_billing_admin"
export const BILLING_EMPLOYEE_ROLE = "org:mca_employee"
export const billingRole = (role: string) => ["admin", "super_admin"].includes(role) ? BILLING_ADMIN_ROLE : BILLING_EMPLOYEE_ROLE
export type StripeBillingClient = Pick<Stripe, "customers" | "subscriptions" | "subscriptionSchedules" | "prices" | "checkout" | "billingPortal" | "webhooks" | "invoices" | "invoicePayments" | "paymentIntents" | "paymentMethods" | "setupIntents" | "charges" | "refunds" | "disputes">

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
  const key = readStripeSecretKey()
  if (!key || !stripeSecretKeyPattern(stripeLiveMode()).test(key)) throw new AppError(503, "billing_mode_mismatch", "Stripe credentials must match the configured billing mode.")
  return new Stripe(key, { apiVersion: "2026-08-26.dahlia", timeout: 15_000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() })
}

export function priceIds() {
  const ids = readPriceIds()
  if (!ids) throw new AppError(503, "billing_catalog_unconfigured", "The company plan catalog needs administrator configuration.")
  return ids
}

export async function verifyBillingPrices(client: StripeBillingClient) {
  const ids = priceIds()
  const taxBehavior = process.env.MCA_STRIPE_TAX_BEHAVIOR
  if (taxBehavior && taxBehavior !== "exclusive" && taxBehavior !== "inclusive") throw new AppError(503, "billing_tax_behavior_invalid", "Stripe tax behavior must be exclusive or inclusive.")
  const [base, seats] = await Promise.all([client.prices.retrieve(ids.base), client.prices.retrieve(ids.seats, { expand: ["tiers"] })])
  const common = (p: Stripe.Price) => p.livemode === stripeLiveMode() && p.active && p.currency === BILLING_CATALOG.currency && p.recurring?.interval === BILLING_CATALOG.interval && p.recurring.interval_count === 1 && p.recurring.usage_type === BILLING_CATALOG.usageType && !p.transform_quantity
  const tiers = seats.tiers ?? []
  if (!common(base) || base.billing_scheme !== BILLING_CATALOG.base.billingScheme || base.unit_amount !== BILLING_CATALOG.base.unitAmountCents || !common(seats) || seats.billing_scheme !== BILLING_CATALOG.additionalSeats.billingScheme || seats.tiers_mode !== BILLING_CATALOG.additionalSeats.tiersMode || tiers.length !== BILLING_CATALOG.additionalSeats.tiers.length ||
    tiers.some((t, i) => t.up_to !== BILLING_CATALOG.additionalSeats.tiers[i].upTo || t.unit_amount !== BILLING_CATALOG.additionalSeats.tiers[i].unitAmountCents || (t.flat_amount ?? 0) !== 0) ||
    (taxBehavior && (base.tax_behavior !== taxBehavior || seats.tax_behavior !== taxBehavior)))
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
  automatic_tax?: { enabled: boolean } | null
  start_date?: number
  ended_at?: number | null
  cancel_at?: number | null
  current_period_start?: number | null
  current_period_end?: number | null
  trial_start?: number | null
  trial_end?: number | null
  default_payment_method?: string | Stripe.PaymentMethod | null
  pending_setup_intent?: string | Stripe.SetupIntent | null
  trial_settings?: { end_behavior?: { missing_payment_method?: string } } | null
  collection_method?: string
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

async function resumePausedTrial(subscription: BillingSubscription, customerId: string, client: StripeBillingClient, beforeProviderWrite: () => void) {
  if (!stripeTrialLifecycleEnabled() || subscription.status !== "paused" || subscription.trial_settings?.end_behavior?.missing_payment_method !== "pause" ||
    !subscription.trial_end || subscription.trial_end * 1000 > Date.now() || subscription.collection_method !== "charge_automatically" || subscription.pause_collection) return subscription
  const customer = await client.customers.retrieve(customerId)
  if (customer.deleted || customer.livemode !== stripeLiveMode()) throw new AppError(503,"billing_customer_mismatch","Company billing identity could not be verified.")
  const now = new Date()
  const defaults = [subscription.default_payment_method, customer.invoice_settings?.default_payment_method]
  let methodId: string | null = null
  const checked = new Set<string>()
  for (const method of defaults) {
    if (!method) continue
    const candidateId = typeof method === "string" ? method : method.id
    if (!candidateId || checked.has(candidateId)) continue
    checked.add(candidateId)
    let paymentMethod: Awaited<ReturnType<StripeBillingClient["paymentMethods"]["retrieve"]>>
    try { paymentMethod = await client.paymentMethods.retrieve(candidateId) }
    catch (error) {
      if ((error as { code?: string })?.code === "resource_missing") continue
      throw error
    }
    if ((typeof paymentMethod.customer === "string" ? paymentMethod.customer : paymentMethod.customer?.id) !== customerId || paymentMethod.livemode !== stripeLiveMode() ||
      paymentMethod.type !== "card" || !paymentMethod.card || paymentMethod.card.exp_year < now.getUTCFullYear() ||
      (paymentMethod.card.exp_year === now.getUTCFullYear() && paymentMethod.card.exp_month < now.getUTCMonth() + 1)) continue
    methodId = candidateId
    break
  }
  if (!methodId) return subscription
  if (!stripeTrialLifecycleEnabled()) return subscription
  const subscriptionMethodId = typeof subscription.default_payment_method === "string" ? subscription.default_payment_method : subscription.default_payment_method?.id
  let currentSubscription = subscription
  if (subscriptionMethodId !== methodId) {
    beforeProviderWrite()
    const updated = await client.subscriptions.update(subscription.id, { default_payment_method: methodId },
      { idempotencyKey: `fundlane:trial-resume-method:${subscription.id}:${subscription.trial_end}:${methodId}` }) as BillingSubscription
    const updatedMethodId = typeof updated.default_payment_method === "string" ? updated.default_payment_method : updated.default_payment_method?.id
    if (updated.id !== subscription.id || fundlaneSubscriptions([updated],customerId).length !== 1 || updatedMethodId !== methodId)
      throw new AppError(503,"billing_customer_mismatch","Company billing identity could not be verified.")
    currentSubscription = updated
  }
  if (!stripeTrialLifecycleEnabled()) return currentSubscription
  beforeProviderWrite()
  const resumed = await client.subscriptions.resume(subscription.id, { billing_cycle_anchor: "now" }, { idempotencyKey: `fundlane:trial-resume:${subscription.id}:${subscription.trial_end}:${methodId}` }) as BillingSubscription
  if (resumed.id !== subscription.id || fundlaneSubscriptions([resumed],customerId).length !== 1) throw new AppError(503,"billing_customer_mismatch","Company billing identity could not be verified.")
  return resumed
}

function trialInvoicePreview(invoice: Stripe.Invoice, subscription: BillingSubscription, customerId: string) {
  if (invoice.livemode !== stripeLiveMode() || (typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id) !== customerId ||
    !Number.isSafeInteger(invoice.total) || invoice.total < 0 || invoice.currency !== "usd" || invoice.lines.has_more !== false) return null
  const expected = subscription.items.data
  const lines = invoice.lines.data.filter(line => line.parent?.type === "subscription_item_details" &&
    line.parent.subscription_item_details?.subscription === subscription.id && !line.parent.subscription_item_details.proration)
  if (lines.length !== expected.length || expected.some(item => {
    if (!item.id || !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1) return true
    const matches = lines.filter(line => line.parent?.subscription_item_details?.subscription_item === item.id &&
      (typeof line.pricing?.price_details?.price === "string" ? line.pricing.price_details.price : line.pricing?.price_details?.price?.id) === item.price.id)
    return matches.length !== 1 || matches[0].quantity !== item.quantity
  })) return null
  const quantity = expected.reduce((sum, item) => sum + (item.quantity ?? 0), 0)
  return Number.isSafeInteger(quantity) && quantity > 0 ? { amount: invoice.total, currency: invoice.currency, quantity } : null
}

export function subscriptionEntitlement(subscription: BillingSubscription): BillingEntitlement {
  if (subscription.livemode !== stripeLiveMode()) throw new AppError(503, "billing_mode_mismatch", "Subscription mode does not match configured billing mode.")
  // Scheduled cancellations remain active at Stripe until period end. Immediately canceled
  // subscriptions must not retain extra seats just because a future period_end remains set.
  if (["canceled", "incomplete_expired"].includes(subscription.status)) return { ...freeEntitlement(), status: subscription.status }
  if (!["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))
    throw new AppError(503, "billing_subscription_unavailable", "This subscription requires administrator review.")
  const { item, additional } = fundlaneSubscriptionItems(subscription)
  if (subscription.status === "incomplete") return { ...freeEntitlement(), status: "incomplete", paymentPastDue: true }
  return { subscriptionId: subscription.id, planId: item.price.id, planSlug: "fundlane", planName: "Fundlane", status: subscription.status,
    periodStart: iso(subscription.status === "trialing" ? subscription.trial_start : item.current_period_start ?? subscription.current_period_start), periodEnd: iso(subscription.status === "trialing" ? subscription.trial_end : item.current_period_end ?? subscription.current_period_end),
    seatLimit: 1 + (additional?.quantity ?? 0), paymentPastDue: !["active", "trialing"].includes(subscription.status) || Boolean(subscription.pause_collection) }
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

export async function syncWorkspaceBilling(workspaceId: string, providedClient?: StripeBillingClient, allowTrialResume = true) {
  if (!billingEnabled()) throw new AppError(503, "billing_disabled", "Company billing is not enabled in this environment.")
  let providerWriteAttempted = false
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE id = ? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404, "workspace_not_found", "Company not found.")
    const mapping = await db.prepare<{ stripe_customer_id: string; livemode:number }>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id = ?").get(workspaceId)
    if (!mapping) {
      const access = await getCompanyAccess(workspaceId)
      return { ...freeEntitlement(), status: access.status, seatLimit: access.seatLimit, source: "free" as const, syncedAt: nowIso() }
    }
    if (missingBillingStateFailsClosed()) await requireBillingState(workspaceId,db)
    assertBillingMappingMode(mapping)
    const client = providedClient ?? getStripeClient()
    let live: BillingSubscription[]
    try {
      const result = await client.subscriptions.list({ customer: mapping.stripe_customer_id, status: "all", limit: 100 })
      if (result.has_more) throw new Error("Subscription pagination requires administrator review")
      live = result.data as BillingSubscription[]
    } catch { throw new AppError(503, "billing_unavailable", "Company billing verification is temporarily unavailable. Existing access is unchanged; please retry.") }
    live = fundlaneSubscriptions(live, mapping.stripe_customer_id)
    // A delayed webhook may first reconcile a trial after it has ended.
    const grantedTrial = live.find(s => s.trial_start && s.trial_end)
    if (grantedTrial) await recordTrialGrant(workspaceId,grantedTrial as Stripe.Subscription,client,db)
    if (trialAbuseLimitsEnabled() && !grantedTrial) {
      const reservation = await db.prepare<{checkout_session_id:string}>("SELECT checkout_session_id FROM company_trial_reservations WHERE workspace_id=?").get(workspaceId)
      if (reservation) {
        // A completed Checkout can arrive before its subscription is visible in a
        // subscription list. Keep the claim until that subscription can be checked.
        const session = await client.checkout.sessions.retrieve(reservation.checkout_session_id)
        if (session.status === "expired") await releaseTrialReservation(workspaceId,session.id,db)
        else if (session.status === "complete" && session.subscription) {
          const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id
          const completed = live.find(s => s.id === subscriptionId) ?? await client.subscriptions.retrieve(subscriptionId)
          if (completed) {
            const [managed] = fundlaneSubscriptions([completed], mapping.stripe_customer_id)
            if (managed?.trial_start && managed.trial_end) await recordTrialGrant(workspaceId,managed as Stripe.Subscription,client,db)
            else if (managed) await releaseTrialReservation(workspaceId,session.id,db)
          }
        }
      }
    }
    let current = currentEntitlement(live, mapping.stripe_customer_id)
    const currentIndex = live.findIndex(subscription => subscription.id === current.subscriptionId)
    if (currentIndex >= 0 && allowTrialResume && stripeTrialLifecycleEnabled() && live[currentIndex].status === "paused") {
      live[currentIndex] = await resumePausedTrial(live[currentIndex], mapping.stripe_customer_id, client, () => { providerWriteAttempted = true })
      current = currentEntitlement(live, mapping.stripe_customer_id)
    }
    if (!missingBillingStateFailsClosed()) await ensureBillingState(workspaceId,db)
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
    const excludeTrialStartZero = Boolean(subscription?.trial_start || subscription?.trial_end)
    const paid = current.subscriptionId ? await db.prepare<{paid_at:string|null}>(excludeTrialStartZero
      ? "SELECT paid_at FROM company_billing_invoices WHERE workspace_id=? AND stripe_subscription_id=? AND status='paid' AND NOT (amount_due=0 AND billing_reason='subscription_create') ORDER BY created_at LIMIT 1"
      : "SELECT paid_at FROM company_billing_invoices WHERE workspace_id=? AND stripe_subscription_id=? AND status='paid' ORDER BY created_at LIMIT 1").get(workspaceId, current.subscriptionId) : null
    if (current.status === "active" && !paid) { current.status = "incomplete"; current.paymentPastDue = true; current.seatLimit = previous?.seat_limit ?? 1 }
    if (unpaid && current.status !== "trialing" && current.seatLimit > (previous?.seat_limit ?? 1)) current.seatLimit = previous?.seat_limit ?? 1
    if (subscription?.status === "trialing") await db.prepare("UPDATE company_subscription_state SET selected_seats=?, updated_at=? WHERE workspace_id=?").run(current.seatLimit, nowIso(), workspaceId)
    if (subscription && current.status === "active" && !unpaid) {
      await captureCompanyPauseBoundary(workspaceId,db,paid?.paid_at ? Date.parse(paid.paid_at) : Date.now())
      const converted = await db.prepare("UPDATE company_subscription_state SET legacy_exempt=0,state_kind='customer' WHERE workspace_id=? AND legacy_exempt=1").run(workspaceId)
      if (converted.changes) await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.legacy_exemption_converted",resourceType:"workspace",resourceId:workspaceId,metadata:{subscriptionId:current.subscriptionId},executor:db})
      await db.prepare("UPDATE company_subscription_state SET legacy_exempt=0,state_kind='customer', selected_seats=?, updated_at=? WHERE workspace_id=?").run(current.seatLimit, nowIso(), workspaceId)
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
    try {
      await recordAuditEvent({ context: { workspaceId, userId: null, source: "system" }, action: "billing.recovery_verification_failed", resourceType: "workspace", resourceId: workspaceId, metadata: {} })
    } finally {
      // A provider mutation cannot roll back with Postgres. Read Stripe again after
      // the transaction releases its lock, including when the provider response was lost.
      if (providerWriteAttempted) {
        try { await syncWorkspaceBilling(workspaceId, providedClient, false) }
        catch {
          const jobId = newId(), availableAt = nowIso()
          await getDatabase().prepare(`INSERT INTO mca_background_jobs
            (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,available_at,created_at,updated_at)
            VALUES (?,?,'billing_reconcile',?,?,'{}','{}','billing_reconcile','queued',?,?,?)`)
            .run(jobId, workspaceId, jobId, jobId, availableAt, availableAt, availableAt)
          await recordOperationalError("billing", "trial_resume_rollback_reconciliation_deferred")
        }
      }
    }
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
  return { enabled: billingEnabled(), seatSyncEnabled: billingSeatSyncEnabled(), seatsCountPendingInvites: seatsCountPendingInvites(), testMode: process.env.MCA_STRIPE_MODE !== "live", billing: billing ?? null, occupiedSeats: usage?.count ?? 0, canManagePayment: Boolean(customer), modeCutoverRequired: !!customer && Boolean(customer.livemode) !== (process.env.MCA_STRIPE_MODE === "live"), access: await getCompanyAccess(workspaceId), state, recovery, cardRequiredTrial: isStripeCheckoutTrialConfigured() }
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
export const MISSING_TRIAL_PAYMENT_METHOD: "pause" | "cancel" = "pause"
export function billingTrialDays() {
  const raw = process.env.MCA_BILLING_TRIAL_DAYS
  if (raw === undefined || raw === "") return TRIAL_DAYS
  const days = Number(raw)
  if (!Number.isSafeInteger(days) || days < 1 || days > 730) throw new AppError(503, "billing_trial_days_invalid", "Trial days must be an integer between 1 and 730.")
  return days
}
function liveTrialHistory(list: Stripe.ApiList<Stripe.Subscription>) {
  if (list.has_more) throw new AppError(503, "billing_subscription_unavailable", "Subscription history requires administrator review.")
  return list.data.some(subscription => Boolean(subscription.trial_start || subscription.trial_end))
}

export async function createOnboardingCheckoutUrl(workspaceId: string, role: string, selectedSeats: number, providedClient?: StripeBillingClient) {
  if (!isStripeCheckoutTrialConfigured()) return undefined
  const access = await getCompanyAccess(workspaceId)
  if (!access.allowed && ["admin","super_admin"].includes(role) && access.reason === "finish_setup") {
    const state = await getDatabase().prepare<{selected_seats:number}>("SELECT selected_seats FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    return (await createBillingCheckout(workspaceId,state?.selected_seats??selectedSeats,true,providedClient)).url
  }
}

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
    if (missingBillingStateFailsClosed()) await requireBillingState(workspaceId, db)
    else await ensureBillingState(workspaceId, db)
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
        if (mapping.checkout_plan_slug === slug && pending.url && (pending.automatic_tax?.enabled === true) === stripeTaxEnabled()) return { url: pending.url }
        await client.checkout.sessions.expire(pending.id)
        await releaseTrialReservation(workspaceId,pending.id,db)
      } else if (pending.status === "complete") {
        const subscriptionId = typeof pending.subscription === "string" ? pending.subscription : pending.subscription?.id
        const previous = subscriptionId ? await client.subscriptions.retrieve(subscriptionId) : null
        // Allow a new plan after a previous subscription actually ended. A completed
        // async checkout whose subscription is still propagating must be retried later.
        if (!previous || !["canceled", "incomplete_expired"].includes(previous.status))
          throw new AppError(409, "billing_checkout_pending", "Your checkout is being reconciled. Retry billing sync before starting another checkout.")
      }
      if (pending.status === "expired") await releaseTrialReservation(workspaceId,pending.id,db)
    }
    // Subscription history and the original trial marker prevent a second trial after
    // a canceled subscription or an expired Checkout. Neither is reset by retrying.
    const history = await db.prepare<{trial_started_at:string|null}>("SELECT trial_started_at FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    const trialDays = !history?.trial_started_at && !liveTrialHistory(await client.subscriptions.list({customer:mapping.stripe_customer_id,status:"all",limit:100})) && await trialAllowedForOwner(workspaceId,db) ? billingTrialDays() : null
    const slot = Math.floor(Date.now() / 1800000)
    const expiresAt = (slot + 2) * 1800
    const session = await client.checkout.sessions.create({ mode: "subscription", customer: mapping.stripe_customer_id,
      ...(stripeTaxEnabled() ? { automatic_tax: { enabled: true }, billing_address_collection: "required" as const, tax_id_collection: { enabled: true }, customer_update: { address: "auto" as const, name: "auto" as const } } : {}),
      integration_identifier: COMPANY_CHECKOUT_INTEGRATION_IDENTIFIER,
      client_reference_id: workspaceId, metadata: { workspace_id: workspaceId }, payment_method_collection: "always",
      subscription_data: { metadata: { workspace_id: workspaceId }, billing_mode: { type: "flexible" }, ...(trialDays ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: MISSING_TRIAL_PAYMENT_METHOD } } } : {}) },
      line_items: [{ price: ids.base, quantity: 1 }, ...(selectedSeats > 1 ? [{ price: ids.seats, quantity: selectedSeats - 1 }] : [])],
      success_url: returnUrl, cancel_url: returnUrl, expires_at: expiresAt,
    }, { idempotencyKey: `fundlane-checkout-${workspaceId}-${slug}-${mapping.checkout_session_id ?? "initial"}-${slot}` })
    if (session.livemode !== stripeLiveMode() || !session.url) throw new AppError(503, "billing_checkout_unavailable", "Checkout is temporarily unavailable.")
    if (trialDays) await reserveTrialForCheckout(workspaceId,session.id,expiresAt,db)
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

export function stripeTrialReminderEligible(subscription: BillingSubscription, customerId: string, trialEndsAt: string) {
  return fundlaneSubscriptions([subscription],customerId).length === 1 &&
    subscription.status === "trialing" && !subscription.cancel_at_period_end && !subscription.cancel_at &&
    iso(subscription.trial_end) === trialEndsAt
}

export function stripePausedTrialEligible(subscription: BillingSubscription, customerId: string) {
  return fundlaneSubscriptions([subscription],customerId).length === 1 && subscription.status === "paused" &&
    !subscription.cancel_at_period_end && !subscription.cancel_at &&
    subscription.trial_settings?.end_behavior?.missing_payment_method === "pause" &&
    Boolean(subscription.trial_end && subscription.trial_end * 1000 <= Date.now()) &&
    subscription.collection_method === "charge_automatically" && !subscription.pause_collection
}

export const BILLING_WEBHOOK_EVENTS = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.trial_will_end",
  "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required", "invoice.finalized", "invoice.upcoming",
  "charge.refunded", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated",
  "refund.created", "refund.updated", "refund.failed",
])

export async function processStripeBillingEvent(event: Stripe.Event, providedClient?: StripeBillingClient) {
  if (event.livemode !== stripeLiveMode()) throw new AppError(400, "billing_mode_mismatch", "Webhook mode mismatch.")
  if (event.type === "customer.updated" && !stripeTrialLifecycleEnabled()) return { ignored: true }
  if (event.type !== "customer.updated" && !BILLING_WEBHOOK_EVENTS.has(event.type)) return { ignored: true }
  const object = event.data.object as unknown as { id?: string; customer?: string | { id: string }; charge?:string|{id:string}; hosted_invoice_url?:string|null; trial_end?:number|null }
  let customerId = typeof object.customer === "string" ? object.customer : object.customer?.id
  if (event.type === "customer.updated") customerId = object.id
  if (!customerId && object.charge) {
    // Refund/dispute events may need a provider lookup; skip it for a known receipt.
    const existing = await getDatabase().prepare("SELECT event_id FROM stripe_billing_events WHERE event_id=?").get(event.id)
    if (existing) return { duplicate: true }
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
      await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:action-required:${object.id}`,"payment_action_required",{invoiceId:object.id,invoiceUrl:object.hosted_invoice_url??null,receivedAt:nowIso()})
    } else if (object.id && event.type === "invoice.payment_failed") {
      await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:payment-failed:${object.id}`,"payment_failed",{invoiceId:object.id,receivedAt:nowIso()})
    }
    if (stripeTrialLifecycleEnabled() && object.id && ["customer.subscription.trial_will_end","customer.subscription.paused"].includes(event.type)) {
      const candidate = await (providedClient ?? getStripeClient()).subscriptions.retrieve(object.id) as BillingSubscription
      const owned = candidate.id === object.id && fundlaneSubscriptions([candidate],customerId).length === 1
      if (owned && event.type === "customer.subscription.trial_will_end" && object.trial_end && Number.isSafeInteger(object.trial_end) && object.trial_end < 8640000000000 && stripeTrialReminderEligible(candidate,customerId,new Date(object.trial_end*1000).toISOString())) {
        let preview: { amount: number; currency: string; quantity: number } | null = null
        try {
          const invoice = await (providedClient ?? getStripeClient()).invoices.createPreview({ customer: customerId, subscription: object.id })
          preview = trialInvoicePreview(invoice,candidate,customerId)
        } catch { /* A preview outage must not suppress the trial reminder. */ }
        await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:stripe-trial-ending:${object.id}:${object.trial_end}`,"trial_ending",{stripeTrial:true,subscriptionId:object.id,trialEndsAt:new Date(object.trial_end*1000).toISOString(),...preview})
      }
      if (owned && event.type === "customer.subscription.paused" && stripePausedTrialEligible(candidate,customerId))
        await enqueueBillingNotification(db,mapping.workspace_id,`billing:${mapping.workspace_id}:stripe-trial-paused:${object.id}`,"trial_paused",{subscriptionId:object.id})
    }
    const jobId = newId()
    await db.prepare(`INSERT INTO mca_background_jobs
      (id,workspace_id,kind,resource_id,idempotency_key,actor_json,payload_json,payload_hash,state,available_at,created_at,updated_at)
      VALUES (?,?,'billing_reconcile',?,?,'{}','{}','billing_reconcile','queued',?,?,?)`).run(jobId,mapping.workspace_id,event.id,event.id,nowIso(),nowIso(),nowIso())
    // The route starts a best-effort sync after commit; cron retains the durable fallback.
    // Signed event fields are notification context, never an entitlement source.
    return { queued: true, workspaceId: mapping.workspace_id, jobId }
  })
}

export const IMMEDIATE_BILLING_RECONCILE_TIMEOUT_MS = 5_000

/** A timed-out sync may still finish; only a sync observed before the deadline completes the job. */
export async function runImmediateBillingReconcile(
  workspaceId: string,
  jobId: string,
  options: { timeoutMs?: number; client?: StripeBillingClient } = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      syncWorkspaceBilling(workspaceId, options.client),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("billing_reconciliation_timeout")), options.timeoutMs ?? IMMEDIATE_BILLING_RECONCILE_TIMEOUT_MS)
      }),
    ])
    await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete',updated_at=? WHERE id=? AND workspace_id=? AND kind='billing_reconcile' AND state='queued'")
      .run(nowIso(), jobId, workspaceId)
  } catch {
    try { await recordOperationalError("billing", "immediate_reconciliation_failed") }
    catch { /* Telemetry must not turn a best-effort sync into a webhook failure. */ }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function requireBillingState(workspaceId: string, db: DbExecutor) {
  if (!await db.prepare("SELECT workspace_id FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)) throw new AppError(409,"billing_state_missing","Resolve the missing billing state before this billing operation.")
}
async function ensureBillingState(workspaceId: string, db: DbExecutor) {
  await db.prepare(`INSERT INTO company_subscription_state (workspace_id,legacy_exempt,selected_seats,updated_at)
    SELECT id,1,seat_limit,? FROM workspaces WHERE id=? ON CONFLICT(workspace_id) DO NOTHING`).run(nowIso(), workspaceId)
}
async function assertOccupiedSeats(workspaceId: string, seats: number, db: DbExecutor, automatic = false) {
  const used = automatic || billingSeatSyncEnabled() ? await licensedSeatCount(workspaceId,db) : (await db.prepare<{ count: number }>("SELECT count(*)::int count FROM memberships WHERE workspace_id=? AND status IN ('active','pending')").get(workspaceId))?.count ?? 0
  if (used > seats) throw new AppError(409, "billing_seats_occupied", billingSeatSyncEnabled() && !seatsCountPendingInvites() ? "Remove active users before reducing seats." : "Remove active users or revoke pending invitations before reducing seats.")
}

/** Serialize capacity checks with membership reservations and seat changes. */
export async function ensureSyncedSeatCapacity(workspaceId:string, actorUserId:string|null, additional:number, client?:StripeBillingClient) {
  if (!billingSeatSyncEnabled()) return assertBillingCapacity(workspaceId,additional,client)
  return withImmediateTransaction(async db => {
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    const mapping=await db.prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
    const current=mapping ? await syncWorkspaceBilling(workspaceId,client) : null
    const plan=await getCompanyAccess(workspaceId)
    if (!plan.allowed) throw new AppError(402,"company_paused","Recover company access in Plans & Billing before inviting users.")
    const count=await licensedSeatCount(workspaceId,db)
    const target=count+additional
    if (current?.subscriptionId && target<=current.seatLimit) {
      const pending=await db.prepare<{pending_seats:number|null}>("SELECT pending_seats FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
      if (pending?.pending_seats && pending.pending_seats!==target) {
        await changeBillingSeats(workspaceId,target,actorUserId,client,true)
        return
      }
    }
    if (target<=plan.seatLimit) return
    if (!mapping) throw new AppError(409,"seat_limit_reached","Your company has used its trial seats.")
    try { await changeBillingSeats(workspaceId,target,actorUserId,client,true) }
    catch (error) { if (error instanceof AppError && error.code==="billing_change_pending") throw new AppError(402,"billing_seat_payment_required","The additional seat requires payment. Complete payment in Plans & Billing, then retry."); throw error }
    const refreshed=await getCompanyAccess(workspaceId)
    if (target>refreshed.seatLimit) throw new AppError(402,"billing_seat_payment_required","The additional seat requires payment. Complete payment in Plans & Billing, then retry.")
  })
}

/** Called after a deactivation commits; reconciliation takes the workspace lock. */
export async function syncSeatsAfterRemoval(workspaceId:string, actorUserId:string, client?:StripeBillingClient) {
  await reconcileLicensedSeats(workspaceId,client,actorUserId)
}

function scheduledRenewalSeats(schedule: Stripe.SubscriptionSchedule): number | null {
  const renewal = schedule.phases[1]
  if (schedule.phases.length !== 2 || !renewal || renewal.start_date !== schedule.phases[0].end_date || schedule.end_behavior !== "release") return null
  const ids = priceIds()
  const base = renewal.items.filter(item => (typeof item.price === "string" ? item.price : item.price?.id) === ids.base)
  const additional = renewal.items.filter(item => (typeof item.price === "string" ? item.price : item.price?.id) === ids.seats)
  if (base.length !== 1 || base[0].quantity !== 1 || additional.length > 1 || base.length + additional.length !== renewal.items.length) return null
  if (additional.length && (!Number.isSafeInteger(additional[0].quantity) || (additional[0].quantity ?? 0) < 1)) return null
  return 1 + (additional[0]?.quantity ?? 0)
}

/** Repair provider quantity drift during periodic billing maintenance. */
export async function reconcileLicensedSeats(workspaceId:string, client?:StripeBillingClient, actorUserId:string|null=null) {
  if (!billingSeatSyncEnabled()) return
  await withImmediateTransaction(async db=>{
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    const mapping=await db.prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
    if (!mapping) return
    const count=await licensedSeatCount(workspaceId,db)
    const current=await syncWorkspaceBilling(workspaceId,client)
    if (!current.subscriptionId || !["active","trialing"].includes(current.status)) return
    const pending=await db.prepare<{pending_seats:number|null;stripe_schedule_id:string|null}>("SELECT pending_seats,stripe_schedule_id FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    const stripe = client??getStripeClient()
    let repairReduction = false
    if (pending?.pending_seats) {
      const sub=await stripe.subscriptions.retrieve(current.subscriptionId)
      const attached=typeof sub.schedule==="string"?sub.schedule:sub.schedule?.id
      if (!attached) {
        await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
        pending.pending_seats=null
      } else if (attached!==pending.stripe_schedule_id) throw new AppError(409,"billing_change_pending","An unexpected subscription schedule requires review.")
      else {
        const schedule = await stripe.subscriptionSchedules.retrieve(attached)
        if (schedule.id !== attached || schedule.status !== "active" || schedule.livemode !== stripeLiveMode() ||
          (typeof schedule.subscription === "string" ? schedule.subscription : schedule.subscription?.id) !== sub.id ||
          schedule.metadata?.workspace_id !== workspaceId) throw new AppError(409,"billing_change_pending","The scheduled reduction requires review.")
        const renewalSeats = scheduledRenewalSeats(schedule)
        if (renewalSeats === null) throw new AppError(409,"billing_change_pending","The scheduled reduction requires review.")
        repairReduction = renewalSeats !== pending.pending_seats || schedule.metadata.selected_seats !== String(pending.pending_seats)
      }
    } else if (current.status === "active") {
      const sub = await stripe.subscriptions.retrieve(current.subscriptionId)
      const attached = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id
      if (attached) {
        const schedule = await stripe.subscriptionSchedules.retrieve(attached)
        const id = (value:string|{id:string}|null) => typeof value === "string" ? value : value?.id
        if (schedule.id !== attached || id(schedule.customer) !== id(sub.customer) || id(schedule.subscription) !== sub.id ||
          schedule.livemode !== stripeLiveMode() || schedule.status !== "active" || schedule.end_behavior === "cancel" ||
          (schedule.metadata?.workspace_id && schedule.metadata.workspace_id !== workspaceId))
          throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review.")
        const renewal = schedule.phases[1]
        if (renewal && schedule.current_phase?.start_date === renewal.start_date &&
          scheduledRenewalSeats(schedule) === current.seatLimit && count === current.seatLimit) return
        // A schedule created before an outer transaction rolled back has no local
        // pending row. Replay the original creation key to prove it is ours.
        const prior = (await db.prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action='billing.seats_changed' AND metadata::jsonb->>'effective'='renewal'").get(workspaceId))?.count ?? 0
        const keys = [...new Set([`fundlane-schedule-${sub.id}-${current.periodStart}`,`fundlane-schedule-${sub.id}-${current.periodStart}-${prior}`])]
        let owned = false
        for (const key of keys) {
          try { if ((await stripe.subscriptionSchedules.create({from_subscription:sub.id},{idempotencyKey:key})).id === attached) { owned = true; break } }
          catch { /* A different key may own this schedule. */ }
        }
        if (!owned) throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review.")
        await stripe.subscriptionSchedules.release(attached,{preserve_cancel_date:true},{idempotencyKey:`fundlane-release-orphan-reduction-${attached}`})
      }
    }
    if (count>current.seatLimit) await ensureSyncedSeatCapacity(workspaceId,actorUserId,0,client)
    else if (pending?.pending_seats===count && !repairReduction) return
    else if (count===current.seatLimit && !pending?.pending_seats) return
    else await changeBillingSeats(workspaceId,count,actorUserId,client,true,repairReduction)
  })
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
  return { ...(writable(phase) as Stripe.SubscriptionScheduleUpdateParams.Phase), ...automaticTaxWhenEnabled(), end_date: end, proration_behavior: "none" }
}

/** Recovery action: deliberately does not require paid access or successful invoice reconciliation. */
export async function cancelBillingSubscription(workspaceId: string, actorUserId: string, providedClient?: StripeBillingClient) {
  const client = providedClient ?? getStripeClient()
  return withImmediateTransaction(async db => {
    if (!await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)) throw new AppError(404,"workspace_not_found","Company not found.")
    const mapping = await db.prepare<{stripe_customer_id:string;livemode:number}>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
    if (!mapping) throw new AppError(409,"billing_subscription_missing","There is no company subscription to cancel.")
    if (missingBillingStateFailsClosed()) await requireBillingState(workspaceId,db)
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
      await client.subscriptions.update(sub.id,{cancel_at_period_end:true,proration_behavior:"none",...automaticTaxWhenEnabled()},{idempotencyKey:`fundlane-cancel-${sub.id}-${end}-${generation}`})
    }
    // A lost response or DB rollback is repaired by re-reading provider state on
    // retry. Never report success based on the mutation response alone.
    sub = await client.subscriptions.retrieve(sub.id)
    fundlaneSubscriptions([sub],mapping.stripe_customer_id)
    if (sub.status!=="canceled" && sub.cancel_at!==end && !(sub.cancel_at_period_end && (sub.items.data.find(i=>i.price.id===priceIds().base)?.current_period_end ?? sub.current_period_end)===end)) throw new AppError(503,"billing_cancellation_unverified","Cancellation could not yet be verified. Retry cancellation to confirm; existing invoices remain due.")
    if (!missingBillingStateFailsClosed()) await ensureBillingState(workspaceId,db)
    await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
    await recordAuditEvent({context:{workspaceId,userId:actorUserId},action:"billing.cancellation_scheduled",resourceType:"subscription",resourceId:sub.id,metadata:{cancelAt:iso(end)},executor:db})
    return {cancelAt:iso(end),alreadyCanceled:sub.status==="canceled"}
  }).catch(error => {
    if (error instanceof AppError) throw error
    throw new AppError(503,"billing_cancellation_unavailable","Cancellation could not yet be confirmed. Retry cancellation to verify the effective date; outstanding invoices remain due.")
  })
}

/** Paid increases use Stripe pending updates, so failed payment cannot grant seats. */
export async function changeBillingSeats(workspaceId: string, selectedSeats: number, actorUserId: string|null, providedClient?: StripeBillingClient, automatic = false, repairReduction = false) {
  monthlyPriceCents(selectedSeats)
  const client = providedClient ?? getStripeClient()
  const ids = await verifyBillingPrices(client)
  let releasedSchedule = false
  try { return await withImmediateTransaction(async db => {
    await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    await assertOccupiedSeats(workspaceId, selectedSeats, db, automatic)
    const current = await syncWorkspaceBilling(workspaceId, client)
    if (current.status === "trialing" && current.subscriptionId) {
      const sub = await client.subscriptions.retrieve(current.subscriptionId)
      if (sub.status !== "trialing" || sub.pending_update || sub.cancel_at_period_end || sub.cancel_at || sub.schedule) throw new AppError(409,"billing_change_pending","Resolve the pending subscription change before changing seats.")
      if (selectedSeats === current.seatLimit) return getWorkspaceBilling(workspaceId)
      const additional = sub.items.data.find(i => i.price.id === ids.seats)
      await client.subscriptions.update(sub.id, { proration_behavior: "none", ...automaticTaxWhenEnabled(), items: selectedSeats === 1
        ? additional?.id ? [{ id: additional.id, deleted: true }] : []
        : [{ ...(additional?.id ? { id: additional.id } : { price: ids.seats }), quantity: selectedSeats - 1 }] },
      { idempotencyKey: `fundlane-trial-seats-${sub.id}-${current.seatLimit}-${selectedSeats}` })
      await recordAuditEvent({context:{workspaceId,userId:actorUserId},action:"billing.seats_changed",resourceType:"workspace",resourceId:workspaceId,metadata:{from:current.seatLimit,to:selectedSeats,effective:"trial_immediate"},executor:db})
      await syncWorkspaceBilling(workspaceId,client)
      return getWorkspaceBilling(workspaceId)
    }
    if (!current.subscriptionId || current.status !== "active" || current.paymentPastDue) throw new AppError(409, "billing_payment_required", "An active paid subscription is required to change purchased seats.")
    const state = await db.prepare<{ pending_seats: number | null; stripe_schedule_id: string | null }>("SELECT pending_seats,stripe_schedule_id FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
    const reviseReduction = !!state?.pending_seats && (automatic || billingSeatSyncEnabled()) && (selectedSeats !== state.pending_seats || repairReduction) && (automatic ? selectedSeats <= current.seatLimit : selectedSeats < current.seatLimit)
    const cancelReduction = !!state?.pending_seats && !automatic && billingSeatSyncEnabled() && selectedSeats >= current.seatLimit
    if (automatic && state?.pending_seats && selectedSeats > current.seatLimit) throw new AppError(409,"billing_scheduled_reduction_pending","Cancel the scheduled seat reduction in Plans & Billing before adding a paid seat.")
    if (state?.pending_seats && !reviseReduction && !cancelReduction) {
      if (state.pending_seats === selectedSeats) return getWorkspaceBilling(workspaceId)
      throw new AppError(409, "billing_change_pending", "A seat reduction is already scheduled. Wait for renewal before requesting another change.")
    }
    const sub = await client.subscriptions.retrieve(current.subscriptionId)
    if (sub.pending_update || sub.cancel_at_period_end || sub.cancel_at) throw new AppError(409, "billing_change_pending", "Resolve the pending subscription change before changing seats.")
    if (selectedSeats === current.seatLimit && !cancelReduction && !reviseReduction) return getWorkspaceBilling(workspaceId)
    const additional = sub.items.data.find(i => i.price.id === ids.seats)
    if (cancelReduction) {
      if (sub.schedule) {
        const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id
        if (state?.stripe_schedule_id !== scheduleId) throw new AppError(409,"billing_change_pending","A subscription schedule must finish before changing seats.")
        const schedule = await client.subscriptionSchedules.retrieve(scheduleId)
        const resourceId = (value: string | {id:string} | null) => typeof value === "string" ? value : value?.id
        if (resourceId(schedule.customer)!==resourceId(sub.customer) || resourceId(schedule.subscription)!==sub.id || schedule.livemode!==stripeLiveMode() || schedule.status!=="active" || schedule.end_behavior==="cancel" ||
          schedule.metadata?.workspace_id!==workspaceId || schedule.metadata?.selected_seats!==String(state.pending_seats) || scheduledRenewalSeats(schedule)!==state.pending_seats)
          throw new AppError(409,"billing_change_pending","The scheduled reduction requires review before changing seats.")
        await client.subscriptionSchedules.release(scheduleId,{preserve_cancel_date:true},{idempotencyKey:`fundlane-release-reduction-${scheduleId}-${selectedSeats}`})
        releasedSchedule = true
      } else if (state?.pending_seats) {
        // A previous attempt may have released Stripe's schedule before its DB transaction rolled back.
        if (!state.stripe_schedule_id) throw new AppError(409,"billing_change_pending","The scheduled reduction requires review before changing seats.")
        const schedule = await client.subscriptionSchedules.retrieve(state.stripe_schedule_id)
        const resourceId = (value: string | {id:string} | null) => typeof value === "string" ? value : value?.id
        if (schedule.status!=="released" || resourceId(schedule.customer)!==resourceId(sub.customer) || resourceId(schedule.subscription)!==sub.id || schedule.livemode!==stripeLiveMode() || schedule.metadata?.workspace_id!==workspaceId || schedule.metadata?.selected_seats!==String(state.pending_seats))
          throw new AppError(409,"billing_change_pending","The scheduled reduction requires review before changing seats.")
      }
      const confirmed = await client.subscriptions.retrieve(sub.id)
      if (confirmed.schedule) throw new AppError(503,"billing_schedule_unverified","The scheduled reduction could not yet be canceled. Refresh billing and retry.")
      await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
      if (selectedSeats === current.seatLimit) {
        await recordAuditEvent({context:{workspaceId,userId:actorUserId},action:"billing.seat_reduction_canceled",resourceType:"workspace",resourceId:workspaceId,metadata:{seats:current.seatLimit},executor:db})
        return getWorkspaceBilling(workspaceId)
      }
    }
    if (selectedSeats > current.seatLimit) {
      if (sub.schedule && !cancelReduction) throw new AppError(409,"billing_change_pending","A subscription schedule must finish before increasing seats.")
      // Stripe pending updates do not accept automatic_tax. Enable it separately
      // before invoicing the proration when the feature is activated on an older subscription.
      if (stripeTaxEnabled() && !sub.automatic_tax?.enabled) await client.subscriptions.update(sub.id,
        { automatic_tax: { enabled: true }, proration_behavior: "none" },
        { idempotencyKey: `fundlane-tax-${sub.id}` })
      await client.subscriptions.update(sub.id, {
        payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice",
        items: [{ ...(additional ? { id: additional.id } : { price: ids.seats }), quantity: selectedSeats - 1 }],
      }, { idempotencyKey: `fundlane-seats-${sub.id}-${current.periodStart}-${current.seatLimit}-${selectedSeats}` })
    } else {
      // Stripe forbids metadata (and every other parameter) with from_subscription.
      // Replay the exact creation request to prove ownership after create succeeded
      // but metadata/update or local commit failed. Metadata alone isn't proof.
      const priorReductions = automatic && !state?.pending_seats ? (await db.prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action='billing.seats_changed' AND metadata::jsonb->>'effective'='renewal'").get(workspaceId))?.count ?? 0 : 0
      const creation = () => client.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `fundlane-schedule-${sub.id}-${current.periodStart}${priorReductions ? `-${priorReductions}` : ""}` })
      let schedule: Stripe.SubscriptionSchedule
      if (sub.schedule) {
        const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id
        schedule = await client.subscriptionSchedules.retrieve(scheduleId)
        if (state?.stripe_schedule_id !== scheduleId) {
          let replay: Stripe.SubscriptionSchedule
          try { replay = await creation() }
          catch { throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review; its creation could not be verified.") }
          if (replay.id !== scheduleId) throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review; its creation does not match this request.")
        } else if (schedule.metadata?.workspace_id !== workspaceId) {
          throw new AppError(409,"billing_change_pending","The scheduled reduction requires review.")
        }
        // Use the fresh retrieval, not the cached creation response: an update may
        // already have succeeded, or an operator may have changed this schedule.
      } else schedule = await creation()
      const resourceId = (value: string | {id:string} | null) => typeof value === "string" ? value : value?.id
      if (resourceId(schedule.customer)!==resourceId(sub.customer) || resourceId(schedule.subscription)!==sub.id || schedule.livemode!==stripeLiveMode() || schedule.status!=="active" || schedule.end_behavior==="cancel" ||
        (schedule.metadata?.workspace_id && schedule.metadata.workspace_id!==workspaceId) || (!reviseReduction && schedule.metadata?.selected_seats && schedule.metadata.selected_seats!==String(selectedSeats))) throw new AppError(409,"billing_change_pending","An existing subscription schedule requires review.")
      const phase = schedule.phases[0]
      const generation = reviseReduction ? (await db.prepare<{count:number}>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action='billing.seats_changed'").get(workspaceId))?.count ?? 0 : null
      await client.subscriptionSchedules.update(schedule.id, { metadata: { workspace_id: workspaceId, selected_seats: String(selectedSeats) }, end_behavior: "release", proration_behavior: "none", phases: [
        { start_date: phase.start_date, end_date: phase.end_date, items: sub.items.data.map(i => ({ price: i.price.id, quantity: i.quantity ?? 1 })), proration_behavior: "none", ...automaticTaxWhenEnabled() },
        { start_date: phase.end_date, items: [{ price: ids.base, quantity: 1 }, ...(selectedSeats > 1 ? [{ price: ids.seats, quantity: selectedSeats - 1 }] : [])], proration_behavior: "none", duration: { interval: "month", interval_count: 1 }, ...automaticTaxWhenEnabled() },
      ] }, { idempotencyKey: `fundlane-reduce-${schedule.id}-${selectedSeats}${generation===null?"":`-${generation}`}` })
      await db.prepare("UPDATE company_subscription_state SET pending_seats=?,pending_seats_at=?,stripe_schedule_id=?,updated_at=? WHERE workspace_id=?").run(selectedSeats, new Date(phase.end_date * 1000).toISOString(), schedule.id, nowIso(), workspaceId)
    }
    await recordAuditEvent({ context: { workspaceId, userId: actorUserId }, action: "billing.seats_changed", resourceType: "workspace", resourceId: workspaceId, metadata: { from: current.seatLimit, to: selectedSeats, effective: selectedSeats > current.seatLimit ? "after_payment" : "renewal" }, executor: db })
    await syncWorkspaceBilling(workspaceId, client)
    return getWorkspaceBilling(workspaceId)
  }) } catch (error) {
    if (releasedSchedule) {
      // Stripe release survives a failed paid update. Remove stale local pending state
      // so the next reconciliation can restore the reduction for the licensed count.
      try { await withImmediateTransaction(async db => {
        await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
        const current = await client.subscriptions.list({customer:(await db.prepare<{stripe_customer_id:string}>("SELECT stripe_customer_id FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId))!.stripe_customer_id,status:"all",limit:100})
        if (current.data.some(subscription => subscription.schedule)) return
        await db.prepare("UPDATE company_subscription_state SET pending_seats=NULL,pending_seats_at=NULL,stripe_schedule_id=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(),workspaceId)
      }) } catch { /* The next retry can inspect Stripe and repair this state. */ }
    }
    throw error
  }
}

/** Read-only Stripe proration estimate for a manual paid seat increase. */
export async function previewBillingSeatIncrease(workspaceId:string, selectedSeats:number, providedClient?:StripeBillingClient) {
  monthlyPriceCents(selectedSeats)
  const client=providedClient??getStripeClient()
  const mapping=await getDatabase().prepare<{stripe_customer_id:string;livemode:number}>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId)
  if (!mapping) throw new AppError(409,"billing_customer_required","Choose a paid plan first.")
  assertBillingMappingMode(mapping)
  const listed=await client.subscriptions.list({customer:mapping.stripe_customer_id,status:"all",limit:100})
  if (listed.has_more) throw new AppError(503,"billing_multiple_subscriptions","Company subscriptions require administrator review.")
  const eligible=fundlaneSubscriptions(listed.data as BillingSubscription[],mapping.stripe_customer_id).filter(s=>s.status==="active")
  if (eligible.length!==1) throw new AppError(409,"billing_payment_required","An active paid subscription is required.")
  const sub=await client.subscriptions.retrieve(eligible[0].id) as BillingSubscription
  const current=subscriptionEntitlement(sub)
  if (selectedSeats<=current.seatLimit || sub.pending_update || sub.schedule || sub.cancel_at || sub.cancel_at_period_end) throw new AppError(409,"billing_change_pending","Choose an increase on an unchanged subscription.")
  const ids=priceIds(),additional=sub.items.data.find(i=>i.price.id===ids.seats)
  const prorationDate=Math.floor(Date.now()/1000)
  const preview=await client.invoices.createPreview({customer:mapping.stripe_customer_id,subscription:sub.id,subscription_details:{proration_behavior:"always_invoice",proration_date:prorationDate,items:[{...(additional?.id?{id:additional.id}:{price:ids.seats}),quantity:selectedSeats-1}]}})
  if (preview.livemode!==stripeLiveMode() || preview.currency!==BILLING_CATALOG.currency) throw new AppError(503,"billing_preview_unavailable","Seat price preview is unavailable. Retry before confirming.")
  if (preview.lines.has_more) throw new AppError(503,"billing_preview_unavailable","Seat price preview is incomplete. Retry before confirming.")
  // A preview can include older prorations and changes to other subscription items.
  // An unidentified proration at this timestamp could be part of this seat change.
  const prorations=preview.lines.data.filter(line=>line.parent?.subscription_item_details?.proration===true)
  const seatLines=prorations.filter(line=>{
    const details=line.parent?.subscription_item_details
    const price=line.pricing?.price_details?.price
    return line.period?.start===prorationDate && details?.subscription===sub.id &&
      (additional?.id ? details.subscription_item===additional.id : (typeof price==="string" ? price : price?.id)===ids.seats) &&
      (!price || (typeof price==="string" ? price : price.id)===ids.seats)
  })
  const ambiguous=prorations.some(line=>{
    if (seatLines.includes(line)) return false
    if (line.period && line.period.start!==prorationDate) return false
    const details=line.parent?.subscription_item_details
    const price=line.pricing?.price_details?.price
    const priceId=typeof price==="string" ? price : price?.id
    if (details?.subscription===sub.id && additional?.id && details.subscription_item===additional.id && priceId && priceId!==ids.seats) return true
    return !(details?.subscription && details.subscription!==sub.id) &&
      !(additional?.id && details?.subscription_item && details.subscription_item!==additional.id) &&
      !(priceId && priceId!==ids.seats)
  })
  const prorationAmount=ambiguous || seatLines.length===0 ? null : seatLines.reduce((total,line)=>total+line.amount,0)
  return {prorationAmount,currency:preview.currency,selectedSeats}
}
