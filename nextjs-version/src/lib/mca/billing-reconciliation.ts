import "server-only"
import { nowIso, recordAuditEvent, type DbExecutor } from "./db"
import { captureCompanyPauseBoundary, recordCompanyPauseBoundary } from "./company-access"
import { AppError } from "./errors"
import type { BillingSubscription, StripeBillingClient } from "./billing"
import type Stripe from "stripe"
import type { BillingRecovery } from "./billing-display"

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
const DAY = 86400000

export async function enqueueBillingNotification(db: DbExecutor, workspaceId: string, key: string, kind: string, data: Record<string, unknown>) {
  await db.prepare(`INSERT INTO company_billing_notifications (id,workspace_id,kind,data,available_at,created_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(key, workspaceId, kind, JSON.stringify(data), nowIso(), nowIso())
}

/** Called with the workspace locked. Provider state, rather than event payloads, is authoritative. */
export async function reconcileBillingInvoices(workspaceId: string, customerId: string, subscription: BillingSubscription | undefined, verifiedSubscriptions: BillingSubscription[], client: StripeBillingClient, db: DbExecutor) {
  let subscriptionChanged = false
  const newlyPaidInvoices = new Set<string>()
  let state = await db.prepare<{ delinquent_since: string | null; delinquent_invoice_id: string | null; grace_ends_at: string | null; processing_extension_until: string | null; processing_extension_granted_at: string | null; collection_paused: number; last_paused_at: string | null }>("SELECT delinquent_since,delinquent_invoice_id,grace_ends_at,processing_extension_until,processing_extension_granted_at,collection_paused,last_paused_at FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
  if (!state) throw new Error("Company billing state missing")
  let invoices = await readBillingInvoices(customerId, client)
  const subscriptionIds = new Set(verifiedSubscriptions.map(value => value.id))
  const belongsToFundlane = (invoice: Stripe.Invoice) => {
    const parent = invoice.parent?.subscription_details?.subscription
    return subscriptionIds.has(typeof parent === "string" ? parent : parent?.id ?? "")
  }
  const pauseBoundary = state.processing_extension_until ?? state.grace_ends_at
  const pausedSubscriptions = new Set<string>()
  if (pauseBoundary) for (const managed of verifiedSubscriptions) {
    const pause = managed.pause_collection as { behavior?: string } | null | undefined
    const recorded = await db.prepare("SELECT id FROM audit_events WHERE workspace_id=? AND action='billing.collection_paused' AND resource_id=? AND metadata::jsonb->>'deadline'=? LIMIT 1").get(workspaceId, managed.id, pauseBoundary)
    if (pause?.behavior === "keep_as_draft" || recorded) pausedSubscriptions.add(managed.id)
  }
  const classifyDrafts = async (values: Stripe.Invoice[]) => {
    const eligible: Stripe.Invoice[] = [], unresolved: Stripe.Invoice[] = []
    for (const invoice of values) {
      if (invoice.status !== "draft" || invoice.billing_reason !== "subscription_cycle" || !belongsToFundlane(invoice) || !pauseBoundary || invoice.created * 1000 < Date.parse(pauseBoundary)) continue
      const parent = invoice.parent!.subscription_details!.subscription
      const managed = verifiedSubscriptions.find(s => s.id === (typeof parent === "string" ? parent : parent.id))!
      if (!pausedSubscriptions.has(managed.id)) continue
      const period = await renewalServicePeriod(invoice, managed.id, client)
      // Unknown service dates cannot authorize a monetary mutation or paid recovery.
      if (!period) { unresolved.push(invoice); continue }
      const cancellation = managed.ended_at ?? managed.cancel_at
      if (period.start * 1000 < Date.parse(pauseBoundary) || period.start * 1000 > Date.now() || (cancellation != null && period.start >= cancellation)) continue
      unresolved.push(invoice)
      if (managed.status === "canceled" && !managed.ended_at) continue
      eligible.push(invoice)
    }
    return { eligible, unresolved }
  }
  const initialDrafts = await classifyDrafts(invoices)
  let finalizationFailure: unknown
  for (const invoice of initialDrafts.eligible) {
    try {
      await client.invoices.finalizeInvoice(invoice.id, { auto_advance: false }, { idempotencyKey: `fundlane-finalize-recovery-${invoice.id}` })
      await billingSystemAudit(db, workspaceId, "billing.recovery_invoice_finalized", invoice.id, { autoAdvance: false })
    } catch (error) { finalizationFailure ??= error }
  }
  // Never use a finalization response (or a pre-mutation snapshot) as settlement
  // evidence. Repeat the complete provider read even after partial mutation failure.
  if (state.delinquent_since || initialDrafts.unresolved.length) invoices = await readBillingInvoices(customerId, client)
  if (initialDrafts.unresolved.some(i => !invoices.some(fresh => fresh.id === i.id))) throw new AppError(503, "billing_invoice_unverified", "Recovery invoice could not be verified.")
  const missedPeriodDrafts = (await classifyDrafts(invoices)).unresolved
  const invoicePayments = new Map<string, Stripe.InvoicePayment[]>()
  const currentIntents = new Map<string, Stripe.PaymentIntent | null>()
  const pendingInvoiceVerification = new Set<string>()
  let paymentsVerified = true
  for (const invoice of invoices) {
    if (invoice.livemode !== (process.env.MCA_STRIPE_MODE === "live") || (typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id) !== customerId) throw new AppError(503, "billing_customer_mismatch", "Invoice identity could not be verified.")
    const sub = invoice.parent?.subscription_details?.subscription
    const previous = await db.prepare<{status:string;amount_paid:number;amount_remaining:number}>("SELECT status,amount_paid,amount_remaining FROM company_billing_invoices WHERE stripe_invoice_id=?").get(invoice.id)
    if (invoice.status === "paid" && previous?.status !== "paid") newlyPaidInvoices.add(invoice.id)
    await db.prepare(`INSERT INTO company_billing_invoices (stripe_invoice_id,workspace_id,stripe_subscription_id,status,billing_reason,currency,amount_due,amount_paid,amount_remaining,invoice_url,paid_at,period_start,period_end,created_at,synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stripe_invoice_id) DO UPDATE SET status=EXCLUDED.status,amount_due=EXCLUDED.amount_due,amount_paid=EXCLUDED.amount_paid,amount_remaining=EXCLUDED.amount_remaining,invoice_url=EXCLUDED.invoice_url,paid_at=EXCLUDED.paid_at,synced_at=EXCLUDED.synced_at`)
      .run(invoice.id, workspaceId, typeof sub === "string" ? sub : sub?.id ?? null, invoice.status ?? "draft", invoice.billing_reason, invoice.currency, invoice.amount_due, invoice.amount_paid, invoice.amount_remaining, invoice.hosted_invoice_url, invoice.status_transitions.paid_at ? iso(invoice.status_transitions.paid_at) : null, iso(invoice.period_start), iso(invoice.period_end), iso(invoice.created), nowIso())
    if (!previous || previous.status !== invoice.status || Number(previous.amount_paid) !== invoice.amount_paid || Number(previous.amount_remaining) !== invoice.amount_remaining) await billingSystemAudit(db,workspaceId,"billing.invoice_reconciled",invoice.id,{before:previous??null,status:invoice.status,amountPaid:invoice.amount_paid,amountRemaining:invoice.amount_remaining})
    let paymentCursor: string | undefined
    for (let page = 0; ; page++) {
      if (page >= 100) { paymentsVerified = false; pendingInvoiceVerification.add(invoice.id); break }
      let payments: Stripe.ApiList<Stripe.InvoicePayment>
      try { payments = await client.invoicePayments.list({ invoice: invoice.id, limit: 100, ...(paymentCursor ? { starting_after: paymentCursor } : {}) }) }
      catch { paymentsVerified = false; pendingInvoiceVerification.add(invoice.id); break }
      invoicePayments.set(invoice.id, [...(invoicePayments.get(invoice.id) ?? []), ...payments.data])
      for (const payment of payments.data) {
        let status: string = payment.status
        const intent = payment.payment?.payment_intent
        if (intent && payment.status !== "paid") {
          const id = typeof intent === "string" ? intent : intent.id
          if (!currentIntents.has(id)) {
            // Expanded objects can be stale too. Always retrieve the current intent.
            try { currentIntents.set(id, await client.paymentIntents.retrieve(id)) }
            catch { currentIntents.set(id, null) }
          }
          status = currentIntents.get(id)?.status ?? "unverified"
          if (status === "unverified" || status === "processing") pendingInvoiceVerification.add(invoice.id)
        }
        const previousPayment = await db.prepare<{status:string;amount_paid:number}>("SELECT status,amount_paid FROM company_billing_payments WHERE stripe_payment_id=?").get(payment.id)
        await db.prepare(`INSERT INTO company_billing_payments (stripe_payment_id,stripe_payment_intent_id,stripe_invoice_id,workspace_id,status,amount_paid,currency,synced_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(stripe_payment_id) DO UPDATE SET stripe_payment_intent_id=EXCLUDED.stripe_payment_intent_id,status=EXCLUDED.status,amount_paid=EXCLUDED.amount_paid,synced_at=EXCLUDED.synced_at`)
          .run(payment.id, typeof intent==="string"?intent:intent?.id??null, invoice.id, workspaceId, status, payment.amount_paid ?? 0, payment.currency, nowIso())
        if (!previousPayment || previousPayment.status !== status || Number(previousPayment.amount_paid) !== (payment.amount_paid??0)) await billingSystemAudit(db,workspaceId,"billing.payment_reconciled",payment.id,{invoiceId:invoice.id,status,amountPaid:payment.amount_paid??0})
      }
      if (!payments.has_more) break
      const next = payments.data.at(-1)?.id
      if (!next || next === paymentCursor) { paymentsVerified = false; pendingInvoiceVerification.add(invoice.id); break }
      paymentCursor = next
    }
  }
  const managedInvoices = invoices.filter(belongsToFundlane)
  // Normal pre-renewal drafts are not arrears. Paused-period invoices are debt even
  // before finalization and must not disappear from the recovery decision.
  const arrears = managedInvoices.filter(i => ["open", "uncollectible"].includes(i.status ?? "") || (i.status !== "draft" && i.amount_remaining > 0))
  const hasUnpaidInvoices = arrears.length > 0 || missedPeriodDrafts.length > 0
  const delinquentInvoiceId = state.delinquent_invoice_id
  const originalInvoiceVerified = !delinquentInvoiceId || managedInvoices.some(i => i.id === delinquentInvoiceId && (i.status === "open" || (i.status === "paid" && i.amount_remaining === 0)))
  const processing = originalInvoiceVerified && paymentsVerified && missedPeriodDrafts.length === 0 && arrears.length > 0 &&
    await fullyCoveredProcessingDebt(arrears, invoices, invoicePayments, currentIntents, customerId, client)
  const renewal = arrears.filter(i => i.billing_reason === "subscription_cycle" && (i.attempt_count > 0 || i.status === "uncollectible" || (i.due_date && i.due_date * 1000 < Date.now()) || hasPendingRenewalPayment(i, invoicePayments.get(i.id) ?? [], currentIntents, customerId))).sort((a,b) => a.created - b.created)[0]
  if (renewal && !state.delinquent_since) {
    // Anchor to the original invoice, never a retry or webhook delivery time.
    const since = iso(renewal.due_date ?? renewal.status_transitions.finalized_at ?? renewal.created)
    const end = new Date(Date.parse(since) + 7 * DAY).toISOString()
    await db.prepare("UPDATE company_subscription_state SET delinquent_since=?,delinquent_invoice_id=?,grace_ends_at=?,updated_at=? WHERE workspace_id=?").run(since, renewal.id, end, nowIso(), workspaceId)
    await billingSystemAudit(db,workspaceId,"billing.grace_started",renewal.id,{since,graceEndsAt:end})
    await enqueueBillingNotification(db, workspaceId, `billing:${workspaceId}:overdue:${renewal.id}`, "renewal_payment_failed", { invoiceId: renewal.id, graceEndsAt: end, invoiceUrl: renewal.hosted_invoice_url })
    state = { ...state, delinquent_since: since, delinquent_invoice_id: renewal.id, grace_ends_at: end }
  }
  const episodePaused = !!state.collection_paused || verifiedSubscriptions.some(s => !!s.pause_collection) ||
    !!(state.last_paused_at && state.delinquent_since && Date.parse(state.last_paused_at) >= Date.parse(state.delinquent_since))
  if (state.grace_ends_at && Date.now() < Date.parse(state.grace_ends_at) && processing && !state.processing_extension_until && !state.processing_extension_granted_at && !episodePaused) {
    const until = new Date(Date.parse(state.grace_ends_at) + 2 * DAY).toISOString()
    const grantedAt = nowIso()
    await db.prepare("UPDATE company_subscription_state SET processing_extension_until=?,processing_extension_granted_at=?,updated_at=? WHERE workspace_id=?").run(until, grantedAt, grantedAt, workspaceId)
    await billingSystemAudit(db,workspaceId,"billing.processing_extension",workspaceId,{until})
    state.processing_extension_until = until
    state.processing_extension_granted_at = grantedAt
  }
  const originalDebt = managedInvoices.find(i=>i.id===state.delinquent_invoice_id)
  const unresolved = !originalDebt || originalDebt.status !== "paid" || originalDebt.amount_remaining !== 0 || managedInvoices.some(i => i.billing_reason === "subscription_cycle" && i.created >= originalDebt.created && i.status !== "paid" && i.status !== "draft")
  if (!processing && state.processing_extension_until && (hasUnpaidInvoices || unresolved)) {
    await db.prepare("UPDATE company_subscription_state SET processing_extension_until=NULL,updated_at=? WHERE workspace_id=?").run(nowIso(), workspaceId)
    await billingSystemAudit(db,workspaceId,"billing.processing_extension_ended",workspaceId,{previousUntil:state.processing_extension_until,reason:"payment_no_longer_processing"})
    state.processing_extension_until = null
  }
  const deadline = state.processing_extension_until ?? state.grace_ends_at
  // Persist the real deadline even when the first observation is recovery, not a worker run.
  const paidThrough = !hasUnpaidInvoices && originalDebt?.status === "paid" && originalDebt.status_transitions.paid_at
    ? Math.max(...managedInvoices.filter(i=>i.created>=originalDebt.created && i.status==="paid").map(i=>(i.status_transitions.paid_at??0)*1000)) : Date.now()
  if (state.grace_ends_at) await captureCompanyPauseBoundary(workspaceId,db,paidThrough)
  if (deadline && Date.parse(deadline) <= Date.now() && (hasUnpaidInvoices || unresolved)) {
    // These controls are independent: a failed subscription pause must not leave
    // existing invoices retrying (and one failed invoice must not stop the others).
    const operations: Array<() => Promise<void>> = managedInvoices.filter(i => i.status === "open" && i.auto_advance !== false).map(invoice => async () => {
      const action = "billing.invoice_collection_paused"
      const key = await collectionOperationKey(db, workspaceId, action, invoice.id, state.delinquent_since)
      await client.invoices.update(invoice.id, { auto_advance: false }, { idempotencyKey: key })
      await billingSystemAudit(db, workspaceId, action, invoice.id, { autoAdvance: false, deadline })
    })
    const pause = subscription?.pause_collection as { behavior?: string; resumes_at?: number | null } | undefined
    if (subscription && (pause?.behavior !== "keep_as_draft" || pause.resumes_at)) operations.push(async () => {
      const action = "billing.collection_paused"
      const key = await collectionOperationKey(db, workspaceId, action, subscription.id, state.delinquent_since)
      await client.subscriptions.update(subscription.id, { pause_collection: { behavior: "keep_as_draft" } }, { idempotencyKey: key })
      subscriptionChanged = true
      await billingSystemAudit(db, workspaceId, action, subscription.id, { deadline, behavior: "keep_as_draft" })
    })
    // Finish every provider control before surfacing a failure and rolling back.
    // Reconciliation reads fresh provider state even when the local flag is set.
    let failure: unknown
    for (const operation of operations) {
      try { await operation() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
    await db.prepare("UPDATE company_subscription_state SET collection_paused=1,updated_at=? WHERE workspace_id=?").run(nowIso(), workspaceId)
    await enqueueBillingNotification(db, workspaceId, `billing:${workspaceId}:paused:${state.delinquent_since}`, "billing_paused", { graceEndsAt: deadline })
    state.collection_paused = 1
  }
  if (finalizationFailure) throw finalizationFailure
  if (state.delinquent_since && !hasUnpaidInvoices) {
    // An operator marking an invoice void/uncollectible is not proof of paid arrears.
    if (!unresolved) {
      if (subscription && (state.collection_paused || subscription.pause_collection)) {
        await client.subscriptions.update(subscription.id, { pause_collection: "" }, { idempotencyKey: `fundlane-resume-${subscription.id}-${state.delinquent_since}` })
        subscriptionChanged = true
      }
      await db.prepare("UPDATE company_subscription_state SET delinquent_since=NULL,delinquent_invoice_id=NULL,grace_ends_at=NULL,processing_extension_until=NULL,processing_extension_granted_at=NULL,collection_paused=0,updated_at=? WHERE workspace_id=?").run(nowIso(), workspaceId)
      await enqueueBillingNotification(db, workspaceId, `billing:${workspaceId}:recovered:${state.delinquent_since}`, "billing_recovered", {})
      await billingSystemAudit(db,workspaceId,"billing.recovered",workspaceId,{delinquentInvoiceId:state.delinquent_invoice_id,collectionResumed:!!state.collection_paused})
    }
  }
  // A paid late renewal can be the first event seen after an entirely offline interval.
  const historical = await db.prepare<{legacy_exempt:number;access_extended_until:string|null}>("SELECT legacy_exempt,access_extended_until FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
  if (!historical?.legacy_exempt) for (const invoice of managedInvoices) {
    if (!newlyPaidInvoices.has(invoice.id) || invoice.billing_reason !== "subscription_cycle" || invoice.status !== "paid" || !invoice.status_transitions.paid_at) continue
    const originalEnd = new Date((invoice.due_date ?? invoice.status_transitions.finalized_at ?? invoice.created)*1000+7*DAY).toISOString()
    const effective = [invoice.id===state.delinquent_invoice_id ? (state.processing_extension_until??originalEnd) : originalEnd,historical?.access_extended_until].filter((v):v is string=>!!v).sort().at(-1)!
    if (Date.parse(effective) < invoice.status_transitions.paid_at*1000) await recordCompanyPauseBoundary(workspaceId,effective,db)
  }
  await reconcileBillingAdjustments(workspaceId,customerId,client,db)
  const debt = [...arrears, ...missedPeriodDrafts]
  const usdDebt = debt.filter(i => i.currency === "usd" && Number.isSafeInteger(i.amount_remaining) && i.amount_remaining >= 0)
  const recovery: BillingRecovery = {
    overdueAmount: usdDebt.reduce((total, invoice) => total + invoice.amount_remaining, 0),
    paymentRequired: hasUnpaidInvoices,
    verificationPending: usdDebt.length !== debt.length || missedPeriodDrafts.length > 0 || !originalInvoiceVerified || (!!state.delinquent_since && unresolved && !hasUnpaidInvoices) || managedInvoices.some(i => pendingInvoiceVerification.has(i.id)),
    invoices: usdDebt.map(i => ({ id: i.id, status: i.status ?? "draft", amountRemaining: i.amount_remaining, periodStart: iso(i.period_start), periodEnd: iso(i.period_end), hostedInvoiceUrl: i.hosted_invoice_url ?? null })).sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id)),
  }
  // Open debt is verified even though it is not paid; unknown/void original debt
  // still needs verification, rather than implying a zero balance is settlement.
  if (recovery.invoices.some(i => i.status === "open" && !i.hostedInvoiceUrl)) recovery.verificationPending = true
  return { subscriptionChanged, hasUnpaidInvoices, recovery }
}

const stripeId = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id

/** Stripe can leave attempt_count at zero while authentication or asynchronous
 * settlement is pending. Only a current intent allocated to this invoice proves
 * payment has begun; merely creating an open invoice does not start this grace.
 * This is not extension eligibility, which still requires full debt coverage. */
export function hasPendingRenewalPayment(invoice: Stripe.Invoice, payments: Stripe.InvoicePayment[], intents: Map<string, Stripe.PaymentIntent | null>, customerId: string) {
  if (invoice.status !== "open" || invoice.amount_remaining <= 0) return false
  return payments.some(payment => {
    if (payment.status !== "open" || payment.payment?.type !== "payment_intent" || stripeId(payment.invoice) !== invoice.id ||
      payment.livemode !== invoice.livemode || payment.currency !== invoice.currency ||
      !Number.isSafeInteger(payment.amount_requested) || payment.amount_requested <= 0) return false
    const id = stripeId(payment.payment.payment_intent)
    const intent = id ? intents.get(id) : null
    return !!intent && intent.id === id && stripeId(intent.customer) === customerId && intent.livemode === invoice.livemode &&
      intent.currency === invoice.currency && Number.isSafeInteger(intent.amount) && intent.amount >= payment.amount_requested &&
      (intent.status === "requires_action" || intent.status === "processing")
  })
}

/** amount_requested is an invoice allocation, never the whole intent amount.
 * Read ALL allocations for each intent: even unrelated invoices can consume it.
 * Unsupported or inconsistent provider evidence cannot authorize extra access. */
export async function fullyCoveredProcessingDebt(debt: Stripe.Invoice[], invoices: Stripe.Invoice[], payments: Map<string, Stripe.InvoicePayment[]>, intents: Map<string, Stripe.PaymentIntent | null>, customerId: string, client: StripeBillingClient) {
  const candidates = new Set<string>()
  for (const invoice of debt) {
    if (invoice.status !== "open" || !Number.isSafeInteger(invoice.amount_remaining) || invoice.amount_remaining <= 0) return false
    for (const payment of payments.get(invoice.id) ?? []) {
      if (payment.status !== "open" || payment.payment?.type !== "payment_intent") continue
      if (stripeId(payment.invoice) !== invoice.id) return false
      const id = stripeId(payment.payment.payment_intent)
      if (id && intents.get(id)?.status === "processing") candidates.add(id)
    }
  }
  const coverage = new Map<string, number>()
  for (const id of candidates) {
    const intent = intents.get(id)!
    if (!intent || intent.id !== id || stripeId(intent.customer) !== customerId || intent.livemode !== (process.env.MCA_STRIPE_MODE === "live") ||
      !Number.isSafeInteger(intent.amount) || intent.amount <= 0 || intent.amount_received !== 0) continue
    const allocations = new Map<string, Stripe.InvoicePayment>()
    let cursor: string | undefined, verified = true
    try {
      for (let page = 0; ; page++) {
        if (page >= 100) { verified = false; break }
        const batch = await client.invoicePayments.list({ payment: { type: "payment_intent", payment_intent: id }, limit: 100, ...(cursor ? { starting_after: cursor } : {}) })
        for (const payment of batch.data) {
          const previous = allocations.get(payment.id)
          if (previous && allocationSignature(previous) !== allocationSignature(payment)) verified = false
          allocations.set(payment.id, payment)
        }
        if (!batch.has_more) break
        const next = batch.data.at(-1)?.id
        if (!next || next === cursor) { verified = false; break }
        cursor = next
      }
    } catch { verified = false }
    let total = 0
    const byInvoice = new Map<string, number>()
    for (const payment of allocations.values()) {
      if (payment.status === "canceled") continue
      const invoiceId = stripeId(payment.invoice)
      const invoice = invoices.find(i => i.id === invoiceId)
      if (!payment.id || !invoice || payment.status !== "open" || payment.payment?.type !== "payment_intent" || stripeId(payment.payment.payment_intent) !== id ||
        payment.livemode !== intent.livemode || payment.currency !== intent.currency || invoice.currency !== intent.currency ||
        !Number.isSafeInteger(payment.amount_requested) || payment.amount_requested <= 0 || (payment.amount_paid !== null && payment.amount_paid !== 0) || byInvoice.has(invoice.id)) {
        verified = false; break
      }
      total += payment.amount_requested
      byInvoice.set(invoice.id, payment.amount_requested)
    }
    // Both independently fetched views must agree; omissions and allocation changes fail closed.
    for (const invoice of debt) for (const payment of payments.get(invoice.id) ?? []) {
      if (stripeId(payment.payment?.payment_intent) !== id || payment.status !== "open") continue
      const allocation = allocations.get(payment.id)
      if (!allocation || allocationSignature(allocation) !== allocationSignature(payment)) verified = false
    }
    if (!verified || !Number.isSafeInteger(total) || total > intent.amount) continue
    for (const [invoiceId, amount] of byInvoice) coverage.set(invoiceId, (coverage.get(invoiceId) ?? 0) + amount)
  }
  return debt.every(invoice => Number.isSafeInteger(coverage.get(invoice.id)) && coverage.get(invoice.id)! >= invoice.amount_remaining)
}

function allocationSignature(payment: Stripe.InvoicePayment) {
  return JSON.stringify([stripeId(payment.invoice), payment.status, payment.currency, payment.livemode, payment.amount_requested, payment.amount_paid, payment.payment?.type, stripeId(payment.payment?.payment_intent)])
}

export async function readBillingInvoices(customerId: string, client: StripeBillingClient) {
  const invoices: Stripe.Invoice[] = []
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    if (page >= 100) throw new AppError(503, "billing_history_limit", "Billing history requires administrator reconciliation.")
    const batch = await client.invoices.list({ customer: customerId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) })
    for (const invoice of batch.data) {
      if (invoice.livemode !== (process.env.MCA_STRIPE_MODE === "live") || (typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id) !== customerId) throw new AppError(503, "billing_customer_mismatch", "Invoice identity could not be verified.")
      invoices.push(invoice)
    }
    if (!batch.has_more) return invoices
    cursor = batch.data.at(-1)?.id
    if (!cursor) throw new Error("Stripe returned an invalid invoice page")
  }
}

async function renewalServicePeriod(invoice: Stripe.Invoice, subscriptionId: string, client: StripeBillingClient) {
  // Invoice period_start/end describe invoice-item association bounds, not the
  // service month. Only original, non-prorated subscription line periods qualify.
  const lines = [...(invoice.lines?.data ?? [])]
  if (invoice.lines?.has_more) {
    let cursor = lines.at(-1)?.id
    for (let page = 0; ; page++) {
      if (!cursor || page >= 100) throw new Error("Invoice line pagination exceeded")
      const batch = await client.invoices.listLineItems(invoice.id, { limit: 100, starting_after: cursor })
      lines.push(...batch.data)
      if (!batch.has_more) break
      cursor = batch.data.at(-1)?.id
    }
  }
  const subscriptionLines = lines.filter(line => line.parent?.type === "subscription_item_details")
  const period = subscriptionLines[0]?.period
  if (!period || !Number.isSafeInteger(period.start) || !Number.isSafeInteger(period.end) || period.end <= period.start) return null
  if (subscriptionLines.some(line => {
    const parent = line.parent?.subscription_item_details
    return parent?.subscription !== subscriptionId || parent.proration !== false || line.invoice !== invoice.id ||
      line.period.start !== period.start || line.period.end !== period.end
  })) return null
  return period
}

async function billingSystemAudit(db:DbExecutor,workspaceId:string,action:string,resourceId:string,metadata:Record<string,unknown>) {
  await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action,resourceType:"billing",resourceId,metadata,executor:db})
}

async function collectionOperationKey(db: DbExecutor, workspaceId: string, action: string, resourceId: string, episode: string | null) {
  // Committed successes advance the operation generation so later provider drift
  // cannot replay Stripe's cached success. Rollbacks retain the same retry key.
  const previous = await db.prepare<{ count: number }>("SELECT count(*)::int count FROM audit_events WHERE workspace_id=? AND action=? AND resource_id=?").get(workspaceId, action, resourceId)
  return `fundlane-${action}-${resourceId}-${episode}-${previous?.count ?? 0}`
}

/** Read-only accounting projections; a refund/dispute does not rewrite invoice debt or forgive it. */
async function reconcileBillingAdjustments(workspaceId:string,customerId:string,client:StripeBillingClient,db:DbExecutor) {
  let cursor:string|undefined
  for (let page=0;;page++) {
    if(page>=100) throw new Error("Charge pagination exceeded")
    const charges = await client.charges.list({customer:customerId,limit:100,...(cursor?{starting_after:cursor}:{})})
    for(const charge of charges.data) {
      if(charge.livemode!==(process.env.MCA_STRIPE_MODE==="live") || (typeof charge.customer==="string"?charge.customer:charge.customer?.id)!==customerId) throw new AppError(503,"billing_customer_mismatch","Charge identity could not be verified.")
      for(const kind of ["refund","dispute"] as const) {
        // Disputes must also be read after a resolution (charge.disputed can change).
        let adjustmentCursor:string|undefined
        for(let n=0;;n++) {
          if(n>=100) throw new Error("Adjustment pagination exceeded")
          const parameters={charge:charge.id,limit:100,...(adjustmentCursor?{starting_after:adjustmentCursor}:{})}
          const batch=kind==="refund" ? await client.refunds.list(parameters) : await client.disputes.list(parameters)
          for(const adjustment of batch.data) {
            const prior=await db.prepare<{status:string;amount:number}>("SELECT status,amount FROM company_billing_adjustments WHERE id=?").get(adjustment.id)
            await db.prepare(`INSERT INTO company_billing_adjustments (id,workspace_id,kind,stripe_charge_id,stripe_payment_intent_id,status,amount,currency,reason,livemode,created_at,synced_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,amount=EXCLUDED.amount,reason=EXCLUDED.reason,synced_at=EXCLUDED.synced_at`)
              .run(adjustment.id,workspaceId,kind,charge.id,typeof charge.payment_intent==="string"?charge.payment_intent:charge.payment_intent?.id??null,adjustment.status??"pending",adjustment.amount,adjustment.currency,adjustment.reason,charge.livemode?1:0,iso(adjustment.created),nowIso())
            if(!prior || prior.status!==adjustment.status || Number(prior.amount)!==adjustment.amount) await billingSystemAudit(db,workspaceId,`billing.${kind}_reconciled`,adjustment.id,{chargeId:charge.id,status:adjustment.status,amount:adjustment.amount,currency:adjustment.currency})
          }
          if(!batch.has_more) break
          adjustmentCursor=batch.data.at(-1)?.id
          if(!adjustmentCursor) throw new Error("Invalid adjustment page")
        }
      }
    }
    if(!charges.has_more) break
    cursor=charges.data.at(-1)?.id
    if(!cursor) throw new Error("Invalid charge page")
  }
}
