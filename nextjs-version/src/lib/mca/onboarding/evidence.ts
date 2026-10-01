import "server-only"
import type Stripe from "stripe"
import { z } from "zod"
import { getDatabase, nowIso, type DbExecutor } from "../db"
import { AppError } from "../errors"
import {
  paidInvoiceEntitlement,
  subscriptionEntitlement,
  type BillingEntitlement,
  type StripeBillingClient,
} from "../billing"
import {
  readBillingInvoices,
  hasPendingRenewalPayment,
  fullyCoveredProcessingDebt,
} from "../billing-reconciliation"
import type { EnrollmentActivation, EnrollmentRecord } from "./contracts"
import {
  type EnrollmentCheckoutRequest,
  validateEnrollmentSession,
  verifyEnrollmentAccount,
} from "./checkout"
export const stripeObjectId = (
  value: string | { id: string } | null | undefined
) => (typeof value === "string" ? value : (value?.id ?? null))
const date = (seconds: number) => new Date(seconds * 1000).toISOString()
const nullableString = z.string().nullable()
const invoiceSchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  status: z.string(),
  billingReason: nullableString,
  currency: z.literal("usd"),
  amountDue: z.number().int().nonnegative(),
  amountPaid: z.number().int().nonnegative(),
  amountRemaining: z.number().int().nonnegative(),
  invoiceUrl: nullableString,
  paidAt: nullableString,
  periodStart: z.string(),
  periodEnd: z.string(),
  createdAt: z.string(),
})
const entitlementSchema = z.object({
  subscriptionId: nullableString,
  planId: nullableString,
  planSlug: z.string(),
  planName: z.string(),
  status: z.string(),
  periodStart: nullableString,
  periodEnd: nullableString,
  seatLimit: z.literal(1),
  paymentPastDue: z.boolean(),
})
export const enrollmentEvidenceSchema = z
  .object({
    version: z.literal(1),
    enrollmentId: z.string(),
    accountId: z.string(),
    livemode: z.boolean(),
    requestGeneration: z.number().int().positive(),
    sessionId: z.string(),
    customerId: z.string(),
    subscriptionId: z.string(),
    verifiedAt: z.iso.datetime(),
    trialStartedAt: z.iso.datetime(),
    trialEndsAt: z.iso.datetime(),
    paymentMethodVerified: z.literal(true),
    cardFingerprint: nullableString,
    entitlement: entitlementSchema,
    invoices: z.array(invoiceSchema),
    hasUnpaidInvoices: z.boolean(),
    delinquentSince: nullableString,
    delinquentInvoiceId: nullableString,
    graceEndsAt: nullableString,
    processingExtensionUntil: nullableString,
    processingExtensionGrantedAt: nullableString,
    collectionPaused: z.boolean(),
  })
  .strict()
export type VerifiedEnrollmentBilling = z.infer<typeof enrollmentEvidenceSchema>
export type VerifiedEnrollmentInvoice = z.infer<typeof invoiceSchema>

/** Provider reads only. No tenant, entitlement or identity write occurs here. */
export async function fetchEnrollmentEvidence(
  row: EnrollmentRecord,
  request: EnrollmentCheckoutRequest,
  session: Stripe.Checkout.Session,
  client: StripeBillingClient,
  previous?: VerifiedEnrollmentBilling
): Promise<{
  activation: EnrollmentActivation
  evidence: VerifiedEnrollmentBilling
}> {
  await verifyEnrollmentAccount(client, row.offer)
  validateEnrollmentSession(session, row, request)
  const customerId = stripeObjectId(session.customer),
    subscriptionId = stripeObjectId(session.subscription)
  if (
    session.status !== "complete" ||
    !customerId ||
    !subscriptionId ||
    (row.customerId && row.customerId !== customerId) ||
    (row.subscriptionId && row.subscriptionId !== subscriptionId)
  )
    throw new AppError(
      409,
      "enrollment_provider_mismatch",
      "Completed Checkout association is not verified."
    )
  const [customer, subscription] = await Promise.all([
    client.customers.retrieve(customerId),
    client.subscriptions.retrieve(subscriptionId),
  ])
  if (
    customer.deleted ||
    customer.id !== customerId ||
    customer.livemode !== row.offer.livemode ||
    subscription.id !== subscriptionId ||
    stripeObjectId(subscription.customer) !== customerId ||
    subscription.livemode !== row.offer.livemode ||
    subscription.metadata?.enrollment_id !== row.id ||
    subscription.metadata?.request_id !== request.id ||
    subscription.metadata?.request_generation !== String(request.generation)
  )
    throw new AppError(
      409,
      "enrollment_provider_mismatch",
      "Provider association could not be verified."
    )
  if (
    customer.metadata.workspace_id &&
    customer.metadata.workspace_id !== row.workspaceId
  )
    throw new AppError(
      409,
      "enrollment_provider_mismatch",
      "Customer belongs to another company."
    )
  if (
    !subscription.trial_start ||
    !subscription.trial_end ||
    subscription.trial_end - subscription.trial_start !== 1209600 ||
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    subscription.items.data[0].price.id !== row.offer.basePriceId ||
    subscription.items.data[0].quantity !== 1 ||
    subscription.collection_method !== "charge_automatically"
  )
    throw new AppError(
      409,
      "enrollment_terms_mismatch",
      "Provider trial dates and catalog must match the offer."
    )
  if (
    row.trialStartedAt &&
    (row.trialStartedAt !== date(subscription.trial_start) ||
      row.trialEndsAt !== date(subscription.trial_end))
  )
    throw new AppError(
      409,
      "enrollment_terms_mismatch",
      "Original trial dates cannot change."
    )
  const email = z.email().max(320).parse(session.customer_details?.email),
    name = z
      .string()
      .trim()
      .min(1)
      .max(255)
      .parse(
        session.collected_information?.business_name ||
          session.customer_details?.business_name
      )
  let methodId =
    stripeObjectId(subscription.default_payment_method) ||
    stripeObjectId(customer.invoice_settings.default_payment_method)
  if (subscription.pending_setup_intent) {
    const setupId = stripeObjectId(subscription.pending_setup_intent)!
    const setup = await client.setupIntents.retrieve(setupId)
    if (
      setup.id !== setupId ||
      setup.livemode !== row.offer.livemode ||
      stripeObjectId(setup.customer) !== customerId ||
      setup.status !== "succeeded"
    )
      throw new AppError(
        409,
        "enrollment_card_unverified",
        "Card setup has not succeeded."
      )
    methodId = methodId || stripeObjectId(setup.payment_method)
  }
  let cardFingerprint = previous?.cardFingerprint ?? null
  if (methodId) {
    const method = await client.paymentMethods.retrieve(methodId)
    if (
      method.id !== methodId ||
      method.livemode !== row.offer.livemode ||
      stripeObjectId(method.customer) !== customerId ||
      method.type !== "card" ||
      !method.card
    )
      throw new AppError(
        409,
        "enrollment_card_unverified",
        "An associated card must be verified."
      )
    cardFingerprint = method.card.fingerprint ?? null
  } else if (!previous?.paymentMethodVerified)
    throw new AppError(
      409,
      "enrollment_card_unverified",
      "An associated card must be verified."
    )
  const invoices = await readBillingInvoices(customerId, client),
    managed = invoices.filter(
      (i) =>
        stripeObjectId(i.parent?.subscription_details?.subscription) ===
        subscriptionId
    )
  const normalized: VerifiedEnrollmentInvoice[] = managed.map((i) =>
    invoiceSchema.parse({
      id: i.id,
      subscriptionId,
      status: i.status ?? "draft",
      billingReason: i.billing_reason,
      currency: i.currency,
      amountDue: i.amount_due,
      amountPaid: i.amount_paid,
      amountRemaining: i.amount_remaining,
      invoiceUrl: i.hosted_invoice_url ?? null,
      paidAt: i.status_transitions.paid_at
        ? date(i.status_transitions.paid_at)
        : null,
      periodStart: date(i.period_start),
      periodEnd: date(i.period_end),
      createdAt: date(i.created),
    })
  )
  const payments = new Map<string, Stripe.InvoicePayment[]>(),
    intents = new Map<string, Stripe.PaymentIntent | null>()
  for (const invoice of managed) {
    const values: Stripe.InvoicePayment[] = []
    let cursor: string | undefined
    for (let page = 0; ; page++) {
      if (page >= 100)
        throw new AppError(
          503,
          "enrollment_history_unverified",
          "Invoice payments require reconciliation."
        )
      const batch = await client.invoicePayments.list({
        invoice: invoice.id,
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      })
      for (const payment of batch.data) {
        if (
          stripeObjectId(payment.invoice) !== invoice.id ||
          payment.livemode !== row.offer.livemode ||
          payment.currency !== invoice.currency
        )
          throw new AppError(
            409,
            "enrollment_provider_mismatch",
            "Invoice payment association is invalid."
          )
        values.push(payment)
        const id = stripeObjectId(payment.payment?.payment_intent)
        if (id && payment.status !== "paid" && !intents.has(id)) {
          const intent = await client.paymentIntents.retrieve(id)
          if (
            intent.id !== id ||
            stripeObjectId(intent.customer) !== customerId ||
            intent.livemode !== row.offer.livemode
          )
            throw new AppError(
              409,
              "enrollment_provider_mismatch",
              "Payment ownership is invalid."
            )
          intents.set(id, intent)
        }
      }
      if (!batch.has_more) break
      const next = batch.data.at(-1)?.id
      if (!next || next === cursor)
        throw new AppError(
          503,
          "enrollment_history_unverified",
          "Incomplete payment pagination."
        )
      cursor = next
    }
    payments.set(invoice.id, values)
  }
  const arrears = managed.filter(
    (i) =>
      ["open", "uncollectible"].includes(i.status ?? "") ||
      (i.status !== "draft" && i.amount_remaining > 0)
  )
  const pausedDrafts = managed.filter(
    (i) =>
      i.status === "draft" &&
      i.billing_reason === "subscription_cycle" &&
      !!subscription.pause_collection
  )
  const hasUnpaidInvoices = arrears.length > 0 || pausedDrafts.length > 0
  const hasPaid = normalized.some(
    (i) =>
      i.status === "paid" &&
      i.amountRemaining === 0 &&
      !!i.paidAt &&
      !(i.amountDue === 0 && i.billingReason === "subscription_create")
  )
  const entitlement = paidInvoiceEntitlement(
    subscriptionEntitlement(subscription),
    hasPaid,
    hasUnpaidInvoices
  ) as BillingEntitlement
  let delinquentSince = previous?.delinquentSince ?? null,
    delinquentInvoiceId = previous?.delinquentInvoiceId ?? null,
    graceEndsAt = previous?.graceEndsAt ?? null,
    processingExtensionUntil = previous?.processingExtensionUntil ?? null,
    processingExtensionGrantedAt =
      previous?.processingExtensionGrantedAt ?? null
  const renewal = arrears
    .filter(
      (i) =>
        i.billing_reason === "subscription_cycle" &&
        (i.attempt_count > 0 ||
          i.status === "uncollectible" ||
          (i.due_date && i.due_date * 1000 < Date.now()) ||
          hasPendingRenewalPayment(
            i,
            payments.get(i.id) ?? [],
            intents,
            customerId
          ))
    )
    .sort((a, b) => a.created - b.created)[0]
  if (renewal && !delinquentSince) {
    delinquentSince = date(
      renewal.due_date ??
        renewal.status_transitions.finalized_at ??
        renewal.created
    )
    delinquentInvoiceId = renewal.id
    graceEndsAt = new Date(
      Date.parse(delinquentSince) + 7 * 86400000
    ).toISOString()
  }
  const original = managed.find((i) => i.id === delinquentInvoiceId)
  const processing =
    arrears.length > 0 &&
    pausedDrafts.length === 0 &&
    (await fullyCoveredProcessingDebt(
      arrears,
      invoices,
      payments,
      intents,
      customerId,
      client
    ))
  if (
    graceEndsAt &&
    Date.now() < Date.parse(graceEndsAt) &&
    processing &&
    !processingExtensionGrantedAt &&
    !subscription.pause_collection
  ) {
    processingExtensionGrantedAt = nowIso()
    processingExtensionUntil = new Date(
      Date.parse(graceEndsAt) + 2 * 86400000
    ).toISOString()
  }
  if (!processing) processingExtensionUntil = null
  if (
    !hasUnpaidInvoices &&
    original?.status === "paid" &&
    original.amount_remaining === 0 &&
    !managed.some(
      (i) =>
        i.created >= original.created &&
        i.status !== "paid" &&
        i.status !== "draft"
    )
  ) {
    delinquentSince = null
    delinquentInvoiceId = null
    graceEndsAt = null
    processingExtensionUntil = null
    processingExtensionGrantedAt = null
  }
  // Unverified draft debt or an unpaid conversion cannot become a fresh paid grant.
  if (hasUnpaidInvoices && !graceEndsAt && entitlement.status === "active") {
    entitlement.status = "past_due"
    entitlement.paymentPastDue = true
  }
  const verifiedAt = nowIso(),
    trialStartedAt = date(subscription.trial_start),
    trialEndsAt = date(subscription.trial_end)
  const evidence = enrollmentEvidenceSchema.parse({
    version: 1,
    enrollmentId: row.id,
    accountId: row.providerAccountId,
    livemode: row.offer.livemode,
    requestGeneration: request.generation,
    sessionId: session.id,
    customerId,
    subscriptionId,
    verifiedAt,
    trialStartedAt,
    trialEndsAt,
    paymentMethodVerified: true,
    cardFingerprint,
    entitlement,
    invoices: normalized,
    hasUnpaidInvoices,
    delinquentSince,
    delinquentInvoiceId,
    graceEndsAt,
    processingExtensionUntil,
    processingExtensionGrantedAt,
    collectionPaused: !!subscription.pause_collection,
  })
  return {
    activation: {
      sessionId: session.id,
      customerId,
      subscriptionId,
      email,
      businessName: name,
      trialStartedAt,
      trialEndsAt,
      verifiedAt,
      billingStatus: evidence.entitlement.status,
      livemode: row.offer.livemode,
    },
    evidence,
  }
}

export const enrollmentEvidenceScope = (id: string) =>
  `onboarding:billing-evidence:${id}`
export async function readVerifiedEnrollmentBilling(
  enrollmentId: string,
  db: DbExecutor = getDatabase()
): Promise<VerifiedEnrollmentBilling | undefined> {
  const stored = await db.queryOne<{ snapshot_cipher: string }>(
    "SELECT snapshot_cipher FROM mca_enrollment_billing_evidence WHERE enrollment_id=?",
    [enrollmentId]
  )
  if (!stored) return undefined
  const { decryptSensitive } = await import("../crypto")
  const result = enrollmentEvidenceSchema.parse(
    JSON.parse(
      decryptSensitive(
        stored.snapshot_cipher,
        enrollmentEvidenceScope(enrollmentId)
      )
    )
  )
  if (result.enrollmentId !== enrollmentId)
    throw new AppError(
      409,
      "enrollment_evidence_mismatch",
      "Billing evidence belongs to another enrollment."
    )
  return result
}
