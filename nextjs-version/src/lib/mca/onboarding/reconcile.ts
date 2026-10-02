import "server-only"
import type Stripe from "stripe"
import { getDatabase, nowIso, withImmediateTransaction } from "../db"
import { encryptSensitive } from "../crypto"
import { AppError } from "../errors"
import {
  BILLING_WEBHOOK_EVENTS,
  getStripeClient,
  stripeLiveMode,
  type StripeBillingClient,
} from "../billing"
import { findEnrollment, recordEnrollmentActivation } from "./store"
import { enrollmentRuntimeEnabled } from "./config"
import {
  claimEnrollmentOperation,
  currentCheckoutRequest,
  readEnrollmentSession,
  persistCheckoutSession,
  releaseEnrollmentOperation,
  verifyEnrollmentAccount,
} from "./checkout"
import {
  fetchEnrollmentEvidence,
  enrollmentEvidenceScope,
  readVerifiedEnrollmentBilling,
  stripeObjectId,
} from "./evidence"
import type { EnrollmentRecord } from "./contracts"

/** Only call with an event produced by verifyStripeBillingEvent at the webhook boundary. */
export async function captureEnrollmentStripeEvent(
  event: Stripe.Event
): Promise<{ handled: boolean; enrollmentId?: string }> {
  if (
    !enrollmentRuntimeEnabled() ||
    (!BILLING_WEBHOOK_EVENTS.has(event.type) &&
      event.type !== "customer.updated")
  )
    return { handled: false }
  if (event.livemode !== stripeLiveMode())
    throw new AppError(400, "billing_mode_mismatch", "Webhook mode mismatch.")
  const object = event.data.object as unknown as {
    id?: string
    customer?: string | { id: string }
    metadata?: Record<string, string>
    parent?: { subscription_details?: { metadata?: Record<string, string> } }
  }
  const ownMetadata = object.metadata
  const subscriptionMetadata = object.parent?.subscription_details?.metadata
  if (
    ownMetadata?.enrollment_id &&
    subscriptionMetadata?.enrollment_id &&
    ["enrollment_id", "request_id", "request_generation"].some(
      (key) => ownMetadata[key] !== subscriptionMetadata[key]
    )
  )
    throw new AppError(
      400,
      "enrollment_session_mismatch",
      "Webhook enrollment attribution conflicts."
    )
  const metadata = ownMetadata?.enrollment_id
    ? ownMetadata
    : subscriptionMetadata?.enrollment_id
      ? subscriptionMetadata
      : undefined
  const customerId =
    event.type === "customer.updated"
      ? object.id
      : stripeObjectId(object.customer)
  return withImmediateTransaction(async (db) => {
    const candidate = metadata?.enrollment_id
      ? await findEnrollment(metadata.enrollment_id, db)
      : customerId
        ? await db.queryOne<{ id: string }>(
            "SELECT id FROM mca_enrollments WHERE customer_id=?",
            [customerId]
          )
        : undefined
    if (!candidate) return { handled: false }
    const row = await findEnrollment(candidate.id, db)
    if (!row || row.workspaceId) return { handled: false }
    if (
      row.providerAccountId !== process.env.MCA_STRIPE_EXPECTED_ACCOUNT_ID ||
      (event.account && event.account !== row.providerAccountId) ||
      row.offer.livemode !== event.livemode
    )
      throw new AppError(
        400,
        "enrollment_account_mismatch",
        "Webhook account mismatch."
      )
    if (metadata?.enrollment_id) {
      const request = await db.queryOne<{
        id: string
        checkout_session_id: string | null
      }>(
        "SELECT id,checkout_session_id FROM mca_enrollment_checkout_requests WHERE enrollment_id=? AND generation=? AND id=?",
        [
          row.id,
          Number(metadata.request_generation) || 0,
          metadata.request_id ?? "",
        ]
      )
      if (
        !request ||
        (event.type.startsWith("checkout.session.") &&
          request.checkout_session_id &&
          request.checkout_session_id !== object.id)
      )
        throw new AppError(
          400,
          "enrollment_session_mismatch",
          "Webhook request association mismatch."
        )
    }
    if (row.customerId && customerId && row.customerId !== customerId)
      throw new AppError(
        400,
        "enrollment_provider_mismatch",
        "Webhook customer mismatch."
      )
    const inserted = await db.execute(
      "INSERT INTO stripe_billing_events(event_id,event_type,stripe_customer_id,enrollment_id,received_at) VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING",
      [event.id, event.type, customerId ?? null, row.id, nowIso()]
    )
    if (inserted)
      await db.execute(
        "UPDATE mca_enrollments SET next_reconcile_at=?,revision=revision+1,updated_at=? WHERE id=?",
        [nowIso(), nowIso(), row.id]
      )
    return { handled: true, enrollmentId: row.id }
  })
}

export async function reconcileEnrollment(
  id: string,
  providedClient?: StripeBillingClient
): Promise<EnrollmentRecord> {
  if (!enrollmentRuntimeEnabled())
    throw new AppError(
      503,
      "enrollment_disabled",
      "Enrollment recovery is unavailable."
    )
  const lease = await claimEnrollmentOperation(id)
  if (!lease) {
    const row = await findEnrollment(id)
    if (!row)
      throw new AppError(404, "enrollment_not_found", "Enrollment not found.")
    throw new AppError(
      409,
      "enrollment_busy",
      "Enrollment is being reconciled."
    )
  }
  try {
    const { row, token } = lease
    if (row.workspaceId) {
      await releaseEnrollmentOperation(id, token)
      return (await findEnrollment(id))!
    }
    const request = await currentCheckoutRequest(row)
    if (!request) {
      await releaseEnrollmentOperation(id, token)
      return (await findEnrollment(id))!
    }
    const client = providedClient ?? getStripeClient()
    await verifyEnrollmentAccount(client, row.offer)
    const session = await readEnrollmentSession(row, request, client)
    if (!(await persistCheckoutSession(row, request, session, token)))
      throw new AppError(
        409,
        "enrollment_busy",
        "A newer reconciliation owns this enrollment."
      )
    if (session.status === "complete") {
      const { activation, evidence } = await fetchEnrollmentEvidence(
        row,
        request,
        session,
        client,
        await readVerifiedEnrollmentBilling(id)
      )
      await withImmediateTransaction(async (db) => {
        const locked = await db.queryOne<{
          claim_token: string | null
          lease_until: string | null
          workspace_id: string | null
        }>(
          "SELECT claim_token,lease_until,workspace_id FROM mca_enrollments WHERE id=? FOR UPDATE",
          [id]
        )
        if (
          locked?.claim_token !== token ||
          !locked.lease_until ||
          Date.parse(locked.lease_until) <= Date.now() ||
          locked.workspace_id
        )
          throw new AppError(
            409,
            "enrollment_busy",
            "A newer operation owns this enrollment."
          )
        await recordEnrollmentActivation(id, activation, db)
        await db.execute(
          `INSERT INTO mca_enrollment_billing_evidence(enrollment_id,provider_account_id,revision,snapshot_cipher,verified_at) VALUES (?,?,1,?,?)
          ON CONFLICT(enrollment_id) DO UPDATE SET revision=mca_enrollment_billing_evidence.revision+1,snapshot_cipher=EXCLUDED.snapshot_cipher,verified_at=EXCLUDED.verified_at`,
          [
            id,
            row.providerAccountId,
            encryptSensitive(
              JSON.stringify(evidence),
              enrollmentEvidenceScope(id)
            ),
            evidence.verifiedAt,
          ]
        )
        await db.execute(
          "UPDATE mca_enrollments SET billing_state=?,verified_at=?,revision=revision+1,updated_at=? WHERE id=? AND claim_token=?",
          [
            evidence.entitlement.status,
            evidence.verifiedAt,
            nowIso(),
            id,
            token,
          ]
        )
      })
    }
    await releaseEnrollmentOperation(id, lease.token)
    return (await findEnrollment(id))!
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : "enrollment_verification_failed"
    if (code === "enrollment_operator_required")
      await getDatabase().execute(
        "UPDATE mca_enrollments SET recovery_state='operator_required',revision=revision+1,updated_at=? WHERE id=? AND claim_token=?",
        [nowIso(), id, lease.token]
      )
    await releaseEnrollmentOperation(id, lease.token, code)
    throw error
  }
}
