import "server-only"
import {
  assertTransactionExecutor,
  getDatabase,
  nowIso,
  withImmediateTransaction,
  type DbExecutor,
} from "../db"
import {
  persistTrialGrant,
  reserveEnrollmentTrialIdentity,
  type TrialIdentity,
} from "../trial-abuse"
import { readBillingInvoices } from "../billing-reconciliation"
import { AppError } from "../errors"
import {
  getStripeClient,
  persistEntitlement,
  stripeLiveMode,
  type StripeBillingClient,
} from "../billing"
import type { EnrollmentRecord } from "./contracts"
import { findEnrollment } from "./store"
import {
  claimEnrollmentOperation,
  releaseEnrollmentOperation,
  verifyEnrollmentAccount,
  onboardingOrigin,
  currentCheckoutRequest,
  readEnrollmentSession,
} from "./checkout"
import {
  fetchEnrollmentEvidence,
  readVerifiedEnrollmentBilling,
  stripeObjectId,
} from "./evidence"
import { enrollmentRuntimeEnabled } from "./config"

/** Caller owns the finalization transaction. Only database-verified evidence is consumed. */
export async function attachEnrollmentBilling(
  db: DbExecutor,
  workspaceId: string,
  enrollment: EnrollmentRecord
): Promise<void> {
  assertTransactionExecutor(db)
  await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
    enrollment.id,
  ])
  const row = await findEnrollment(enrollment.id, db),
    evidence = await readVerifiedEnrollmentBilling(enrollment.id, db)
  if (
    !row ||
    !evidence ||
    row.revision !== enrollment.revision ||
    row.errorCode ||
    (row.workspaceId && row.workspaceId !== workspaceId) ||
    row.customerId !== evidence.customerId ||
    row.subscriptionId !== evidence.subscriptionId ||
    row.providerAccountId !== evidence.accountId ||
    row.offer.livemode !== evidence.livemode ||
    row.checkoutSessionId !== evidence.sessionId ||
    row.checkoutGeneration !== evidence.requestGeneration ||
    row.trialStartedAt !== evidence.trialStartedAt ||
    row.trialEndsAt !== evidence.trialEndsAt ||
    row.verifiedAt !== evidence.verifiedAt ||
    Date.now() - Date.parse(evidence.verifiedAt) > 300000 ||
    row.claimToken ||
    row.claimState === "blocked" ||
    row.recoveryState !== "none"
  )
    throw new AppError(
      409,
      "enrollment_evidence_stale",
      "Refresh verified enrollment billing before finalization."
    )
  // A new claim must never overwrite another tenant's local trial or billing history.
  // Replays of an already committed finalization do not replace newer billing state.
  if (row.workspaceId === workspaceId && row.finalizationState === "complete")
    return
  if (
    await db.queryOne(
      "SELECT workspace_id FROM company_subscription_state WHERE workspace_id=? UNION ALL SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?",
      [workspaceId, workspaceId]
    )
  )
    throw new AppError(
      409,
      "enrollment_existing_billing",
      "Only a new company may attach enrollment billing."
    )
  await db.execute(
    "INSERT INTO workspace_stripe_customers(workspace_id,stripe_customer_id,livemode,checkout_session_id,checkout_plan_slug,created_at) VALUES (?,?,?,?,'fundlane:1',?) ON CONFLICT(workspace_id) DO NOTHING",
    [
      workspaceId,
      evidence.customerId,
      evidence.livemode ? 1 : 0,
      evidence.sessionId,
      nowIso(),
    ]
  )
  await db.execute(
    `INSERT INTO company_subscription_state(workspace_id,legacy_exempt,state_kind,selected_seats,trial_started_at,trial_ends_at,delinquent_since,delinquent_invoice_id,grace_ends_at,processing_extension_until,processing_extension_granted_at,collection_paused,updated_at)
    VALUES (?,0,'customer',1,NULL,NULL,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET legacy_exempt=0,state_kind='customer',selected_seats=1,trial_started_at=NULL,trial_ends_at=NULL,delinquent_since=EXCLUDED.delinquent_since,delinquent_invoice_id=EXCLUDED.delinquent_invoice_id,grace_ends_at=EXCLUDED.grace_ends_at,processing_extension_until=EXCLUDED.processing_extension_until,processing_extension_granted_at=EXCLUDED.processing_extension_granted_at,collection_paused=EXCLUDED.collection_paused,updated_at=EXCLUDED.updated_at`,
    [
      workspaceId,
      evidence.delinquentSince,
      evidence.delinquentInvoiceId,
      evidence.graceEndsAt,
      evidence.processingExtensionUntil,
      evidence.processingExtensionGrantedAt,
      evidence.collectionPaused ? 1 : 0,
      nowIso(),
    ]
  )
  for (const invoice of evidence.invoices)
    await db.execute(
      `INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,stripe_subscription_id,status,billing_reason,currency,amount_due,amount_paid,amount_remaining,invoice_url,paid_at,period_start,period_end,created_at,synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(stripe_invoice_id) DO NOTHING`,
      [
        invoice.id,
        workspaceId,
        invoice.subscriptionId,
        invoice.status,
        invoice.billingReason,
        invoice.currency,
        invoice.amountDue,
        invoice.amountPaid,
        invoice.amountRemaining,
        invoice.invoiceUrl,
        invoice.paidAt,
        invoice.periodStart,
        invoice.periodEnd,
        invoice.createdAt,
        evidence.verifiedAt,
      ]
    )
  await persistEntitlement(workspaceId, evidence.entitlement, "stripe_api", db)
}

/** Internal: Task3 must authorize the verified claimant before exposing this action. */
export async function createEnrollmentBillingPortal(
  enrollment: EnrollmentRecord,
  providedClient?: StripeBillingClient
): Promise<string> {
  if (!enrollmentRuntimeEnabled())
    throw new AppError(
      503,
      "enrollment_disabled",
      "Enrollment recovery is unavailable."
    )
  const row = await findEnrollment(enrollment.id)
  if (
    !row?.customerId ||
    row.customerId !== enrollment.customerId ||
    row.subscriptionId !== enrollment.subscriptionId ||
    !row.activatedAt
  )
    throw new AppError(
      409,
      "enrollment_provider_mismatch",
      "Enrollment billing association is invalid."
    )
  const client = providedClient ?? getStripeClient()
  await verifyEnrollmentAccount(client, row.offer)
  const customer = await client.customers.retrieve(row.customerId),
    subscription = await client.subscriptions.retrieve(row.subscriptionId!)
  if (
    customer.deleted ||
    customer.id !== row.customerId ||
    customer.livemode !== row.offer.livemode ||
    (customer.metadata.workspace_id &&
      customer.metadata.workspace_id !== row.workspaceId) ||
    subscription.id !== row.subscriptionId ||
    stripeObjectId(subscription.customer) !== row.customerId ||
    subscription.livemode !== row.offer.livemode
  )
    throw new AppError(
      409,
      "enrollment_provider_mismatch",
      "Provider ownership could not be verified."
    )
  const configuration = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION
  if (!configuration)
    throw new AppError(
      503,
      "billing_portal_unconfigured",
      "Configure the payment and cancellation portal."
    )
  const settings =
    await client.billingPortal.configurations.retrieve(configuration)
  if (
    !settings.active ||
    settings.livemode !== stripeLiveMode() ||
    settings.features.subscription_update.enabled ||
    !settings.features.payment_method_update.enabled ||
    !settings.features.invoice_history.enabled ||
    !settings.features.subscription_cancel.enabled ||
    settings.features.subscription_cancel.mode !== "at_period_end"
  )
    throw new AppError(
      503,
      "billing_portal_configuration_invalid",
      "Portal must support payment recovery and period-end cancellation."
    )
  return (
    await client.billingPortal.sessions.create({
      customer: row.customerId,
      configuration,
      return_url: `${onboardingOrigin()}/enrollment?enrollment=${encodeURIComponent(row.id)}`,
    })
  ).url
}

async function exactTrialStillUncharged(
  customerId: string,
  subscriptionId: string,
  client: StripeBillingClient
): Promise<boolean> {
  const invoices = await readBillingInvoices(customerId, client)
  // A dedicated Checkout-created customer should have no unrelated billing.
  if (
    invoices.some(
      (i) =>
        stripeObjectId(i.parent?.subscription_details?.subscription) !==
          subscriptionId ||
        i.billing_reason !== "subscription_create" ||
        i.amount_due !== 0 ||
        i.amount_paid !== 0 ||
        i.amount_remaining !== 0 ||
        i.status !== "paid"
    )
  )
    return false
  for (const invoice of invoices) {
    const payments = await client.invoicePayments.list({
      invoice: invoice.id,
      limit: 100,
    })
    if (payments.has_more || payments.data.length) return false
  }
  const [charges, intents] = await Promise.all([
    client.charges.list({ customer: customerId, limit: 100 }),
    client.paymentIntents.list({ customer: customerId, limit: 100 }),
  ])
  return (
    !charges.has_more &&
    charges.data.length === 0 &&
    !intents.has_more &&
    intents.data.length === 0
  )
}

/** Durable narrow saga, never a refund or cancellation of an existing company. */
export async function compensateEnrollment(
  id: string,
  providedClient?: StripeBillingClient
): Promise<void> {
  if (!enrollmentRuntimeEnabled())
    throw new AppError(
      503,
      "enrollment_disabled",
      "Enrollment recovery is unavailable."
    )
  const lease = await claimEnrollmentOperation(id)
  if (!lease)
    throw new AppError(
      409,
      "enrollment_busy",
      "Enrollment is being reconciled."
    )
  const { row, token } = lease
  if (
    row.workspaceId ||
    row.claimState !== "blocked" ||
    row.finalizationState !== "blocked" ||
    !["pending", "canceling", "uncertain", "canceled"].includes(
      row.recoveryState
    ) ||
    !row.customerId ||
    !row.subscriptionId
  ) {
    await releaseEnrollmentOperation(id, token)
    throw new AppError(
      409,
      "enrollment_compensation_forbidden",
      "Only a blocked redundant enrollment is eligible for compensation."
    )
  }
  let result: "canceled" | "operator_required" = "operator_required",
    errorCode: string | null = "enrollment_compensation_review"
  try {
    const client = providedClient ?? getStripeClient()
    await verifyEnrollmentAccount(client, row.offer)
    const request = await currentCheckoutRequest(row)
    if (!request) throw new Error("Missing committed request")
    const session = await readEnrollmentSession(row, request, client)
    await fetchEnrollmentEvidence(
      row,
      request,
      session,
      client,
      await readVerifiedEnrollmentBilling(id)
    )
    let sub = await client.subscriptions.retrieve(row.subscriptionId)
    if (
      sub.id !== row.subscriptionId ||
      stripeObjectId(sub.customer) !== row.customerId ||
      sub.livemode !== row.offer.livemode
    )
      throw new Error("Foreign subscription")
    if (
      sub.status === "canceled" &&
      ["canceling", "uncertain", "canceled"].includes(row.recoveryState) &&
      (await exactTrialStillUncharged(
        row.customerId,
        row.subscriptionId,
        client
      ))
    ) {
      result = "canceled"
      errorCode = null
    } else {
      // Even an open conversion invoice or an incomplete payment means cancellation
      // cannot promise charge prevention. No provider write follows ambiguous evidence.
      const uncharged = await exactTrialStillUncharged(
        row.customerId,
        row.subscriptionId,
        client
      )
      if (
        sub.status !== "trialing" ||
        !sub.trial_end ||
        sub.trial_end * 1000 <= Date.now() + 60000 ||
        !uncharged ||
        sub.pending_update ||
        sub.schedule ||
        sub.pause_collection
      )
        throw new Error("Trial conversion or payment is possible")
      const permitted = await withImmediateTransaction(async (db) => {
        const current = await db.queryOne<{
          claim_token: string | null
          claim_state: string
          workspace_id: string | null
        }>(
          "SELECT claim_token,claim_state,workspace_id FROM mca_enrollments WHERE id=? FOR UPDATE",
          [id]
        )
        if (
          current?.claim_token !== token ||
          current.claim_state !== "blocked" ||
          current.workspace_id
        )
          return false
        return (
          (await db.execute(
            "UPDATE mca_enrollments SET recovery_state='canceling',revision=revision+1,updated_at=? WHERE id=?",
            [nowIso(), id]
          )) === 1
        )
      })
      if (!permitted) throw new Error("Compensation lease lost")
      try {
        await client.subscriptions.cancel(
          row.subscriptionId,
          { invoice_now: false, prorate: false },
          { idempotencyKey: `enrollment:${row.id}:redundant-trial-cancel` }
        )
      } catch {
        /* Read current provider state after either success or response loss. */
      }
      sub = await client.subscriptions.retrieve(row.subscriptionId)
      if (
        sub.id === row.subscriptionId &&
        stripeObjectId(sub.customer) === row.customerId &&
        sub.livemode === row.offer.livemode &&
        sub.status === "canceled" &&
        sub.trial_end === Date.parse(row.trialEndsAt!) / 1000 &&
        (await exactTrialStillUncharged(
          row.customerId,
          row.subscriptionId,
          client
        ))
      ) {
        result = "canceled"
        errorCode = null
      } else errorCode = "enrollment_cancel_acceptance_unknown"
    }
  } catch {
    /* Persist the sanitized operator work item; no blind cancellation retry. */
  }
  await getDatabase().execute(
    "UPDATE mca_enrollments SET recovery_state=?,billing_state=CASE WHEN ?='canceled' THEN 'canceled' ELSE billing_state END,error_code=?,revision=revision+1,updated_at=? WHERE id=? AND claim_token=?",
    [result, result, errorCode, nowIso(), id, token]
  )
  await releaseEnrollmentOperation(id, token, errorCode)
}

/** Final claim records claimant history and card review evidence atomically, without provider I/O. */
export async function recordEnrollmentTrialGrant(
  db: DbExecutor,
  workspaceId: string,
  enrollment: EnrollmentRecord,
  identity: TrialIdentity
): Promise<void> {
  assertTransactionExecutor(db)
  const evidence = await readVerifiedEnrollmentBilling(enrollment.id, db)
  if (
    !evidence ||
    evidence.subscriptionId !== enrollment.subscriptionId ||
    evidence.trialStartedAt !== enrollment.trialStartedAt ||
    !identity.userId
  )
    throw new AppError(
      409,
      "enrollment_evidence_stale",
      "Verified trial history is required."
    )
  await reserveEnrollmentTrialIdentity(enrollment.id, identity, db)
  await persistTrialGrant(
    workspaceId,
    {
      subscriptionId: evidence.subscriptionId,
      trialStartedAt: evidence.trialStartedAt,
      identity,
      fingerprint: evidence.cardFingerprint,
    },
    db
  )
}
