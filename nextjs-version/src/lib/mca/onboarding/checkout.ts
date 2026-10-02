import "server-only"
import type Stripe from "stripe"
import { BILLING_CATALOG } from "../billing-catalog"
import {
  getDatabase,
  newId,
  nowIso,
  withImmediateTransaction,
  type DbExecutor,
} from "../db"
import {
  decryptSensitive,
  encryptSensitive,
  hashOpaqueToken,
  hmacScopedToken,
} from "../crypto"
import { AppError } from "../errors"
import {
  getStripeClient,
  stripeLiveMode,
  verifyBillingPrices,
  type StripeBillingClient,
} from "../billing"
import {
  trialAllowedForIdentity,
  reserveEnrollmentTrialIdentity,
} from "../trial-abuse"
import { createEnrollment, findEnrollment } from "./store"
import { enrollmentCreationEnabled, enrollmentRuntimeEnabled } from "./config"
import type { EnrollmentOffer, EnrollmentRecord } from "./contracts"

export interface EnrollmentCheckoutRequest {
  id: string
  enrollment_id: string
  generation: number
  request_key: string
  request_cipher: string
  payload_hash: string
  provider_account_id: string
  state: string
  checkout_session_id: string | null
  requested_at: string
  idempotency_expires_at: string
  checkout_expires_at: string | null
}
export function onboardingOrigin(): string {
  let url: URL
  try {
    url = new URL(process.env.MCA_APP_ORIGIN ?? "")
  } catch {
    throw new AppError(
      503,
      "enrollment_origin_invalid",
      "Configure the application origin."
    )
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new AppError(
      503,
      "enrollment_origin_invalid",
      "Configure a secure application origin."
    )
  return url.origin
}
export async function verifyEnrollmentAccount(
  client: StripeBillingClient,
  offer?: EnrollmentOffer
): Promise<string> {
  const expected = process.env.MCA_STRIPE_EXPECTED_ACCOUNT_ID?.trim()
  if (!expected || !/^acct_[A-Za-z0-9]+$/.test(expected) || !client.accounts)
    throw new AppError(
      503,
      "enrollment_account_unconfigured",
      "Configure the expected Stripe account."
    )
  if (
    (offer &&
      (offer.accountId !== expected || offer.livemode !== stripeLiveMode())) ||
    (await client.accounts.retrieve(null)).id !== expected
  )
    throw new AppError(
      503,
      "enrollment_account_mismatch",
      "Stripe account or mode could not be verified."
    )
  const prices = await verifyBillingPrices(client)
  if (
    offer &&
    (offer.basePriceId !== prices.base || offer.seatPriceId !== prices.seats)
  )
    throw new AppError(
      503,
      "enrollment_catalog_mismatch",
      "Enrollment catalog no longer matches configuration."
    )
  return expected
}
const requestScope = (id: string, generation: number) =>
  `onboarding:checkout:${id}:${generation}`
export function readCheckoutRequest(
  row: EnrollmentCheckoutRequest
): Stripe.Checkout.SessionCreateParams {
  const json = decryptSensitive(
    row.request_cipher,
    requestScope(row.enrollment_id, row.generation)
  )
  if (
    hmacScopedToken("onboarding-checkout", row.enrollment_id, json) !==
    row.payload_hash
  )
    throw new AppError(
      409,
      "enrollment_request_invalid",
      "Checkout request integrity failed."
    )
  return JSON.parse(json) as Stripe.Checkout.SessionCreateParams
}
export async function currentCheckoutRequest(
  row: EnrollmentRecord,
  db: DbExecutor = getDatabase()
) {
  return db.queryOne<EnrollmentCheckoutRequest>(
    "SELECT * FROM mca_enrollment_checkout_requests WHERE enrollment_id=? AND generation=?",
    [row.id, row.checkoutGeneration]
  )
}
/** Provider calls occur after this transaction commits. A token fences every completion. */
export async function claimEnrollmentOperation(
  id: string
): Promise<{ row: EnrollmentRecord; token: string } | null> {
  return withImmediateTransaction(async (db) => {
    const token = newId(),
      now = nowIso()
    const count = await db.execute(
      "UPDATE mca_enrollments SET claim_token=?,lease_until=?,revision=revision+1,updated_at=? WHERE id=? AND (lease_until IS NULL OR lease_until<?)",
      [token, new Date(Date.now() + 600000).toISOString(), now, id, now]
    )
    if (!count) return null
    return { row: (await findEnrollment(id, db))!, token }
  })
}
export async function releaseEnrollmentOperation(
  id: string,
  token: string,
  errorCode: string | null = null
) {
  await getDatabase().execute(
    "UPDATE mca_enrollments SET claim_token=NULL,lease_until=NULL,next_reconcile_at=?,error_code=?,revision=revision+1,updated_at=? WHERE id=? AND claim_token=?",
    [
      new Date(Date.now() + (errorCode ? 60000 : 300000)).toISOString(),
      errorCode,
      nowIso(),
      id,
      token,
    ]
  )
}
export function validateEnrollmentSession(
  session: Stripe.Checkout.Session,
  row: EnrollmentRecord,
  request: EnrollmentCheckoutRequest
) {
  const metadata = session.metadata
  if (
    !session.id ||
    session.livemode !== row.offer.livemode ||
    session.mode !== "subscription" ||
    session.client_reference_id !== row.id ||
    metadata?.enrollment_id !== row.id ||
    metadata?.request_generation !== String(request.generation) ||
    metadata?.request_id !== request.id ||
    (request.checkout_session_id && session.id !== request.checkout_session_id)
  )
    throw new AppError(
      409,
      "enrollment_session_mismatch",
      "Checkout identity could not be verified."
    )
  if (
    (session.automatic_tax?.enabled === true) !== row.offer.automaticTax ||
    (session.allow_promotion_codes === true) !== row.offer.promotionCodes ||
    session.managed_payments?.enabled === true ||
    session.payment_method_collection !== "always" ||
    session.payment_method_types?.length !== 1 ||
    session.payment_method_types[0] !== "card"
  )
    throw new AppError(
      409,
      "enrollment_session_mismatch",
      "Checkout terms could not be verified."
    )
  const items = session.line_items
  if (
    !items ||
    items.has_more ||
    items.data.length !== 1 ||
    items.data[0].price?.id !== row.offer.basePriceId ||
    items.data[0].quantity !== 1
  )
    throw new AppError(
      409,
      "enrollment_session_mismatch",
      "Checkout price could not be verified."
    )
}
export async function readEnrollmentSession(
  row: EnrollmentRecord,
  request: EnrollmentCheckoutRequest,
  client: StripeBillingClient
): Promise<Stripe.Checkout.Session> {
  if (request.checkout_session_id) {
    const session = await client.checkout.sessions.retrieve(
      request.checkout_session_id,
      { expand: ["line_items"] }
    )
    validateEnrollmentSession(session, row, request)
    return session
  }
  if (
    Date.now() < Date.parse(request.idempotency_expires_at) &&
    request.state !== "operator_required"
  ) {
    const created = await client.checkout.sessions.create(
      readCheckoutRequest(request),
      { idempotencyKey: request.request_key }
    )
    // Retrieval verifies the complete provider object even when the create response is sparse.
    const session = await client.checkout.sessions.retrieve(created.id, {
      expand: ["line_items"],
    })
    validateEnrollmentSession(session, row, request)
    return session
  }
  // Beyond Stripe's retention, never replay a key which may have been pruned.
  let cursor: string | undefined
  const candidates: Stripe.Checkout.Session[] = []
  for (let page = 0; page < 100; page++) {
    const batch = await client.checkout.sessions.list({
      limit: 100,
      created: {
        gte: Math.floor(Date.parse(request.requested_at) / 1000) - 60,
        lte: Math.ceil(Date.parse(request.idempotency_expires_at) / 1000),
      },
      ...(cursor ? { starting_after: cursor } : {}),
    })
    for (const item of batch.data)
      if (
        item.metadata?.enrollment_id === row.id &&
        item.metadata?.request_id === request.id
      )
        candidates.push(item)
    if (!batch.has_more) {
      if (candidates.length !== 1) break
      const session = await client.checkout.sessions.retrieve(
        candidates[0].id,
        { expand: ["line_items"] }
      )
      validateEnrollmentSession(session, row, request)
      return session
    }
    const next = batch.data.at(-1)?.id
    if (!next || next === cursor) break
    cursor = next
  }
  throw new AppError(
    409,
    "enrollment_operator_required",
    "Checkout acceptance requires operator reconciliation."
  )
}
async function prepareRequest(
  id: string,
  token: string
): Promise<EnrollmentCheckoutRequest> {
  return withImmediateTransaction(async (db) => {
    await db.queryOne("SELECT id FROM mca_enrollments WHERE id=? FOR UPDATE", [
      id,
    ])
    const row = (await findEnrollment(id, db))!
    if (
      row.claimToken !== token ||
      !row.leaseUntil ||
      Date.parse(row.leaseUntil) <= Date.now()
    )
      throw new AppError(
        409,
        "enrollment_busy",
        "Enrollment is being reconciled."
      )
    const old = await currentCheckoutRequest(row, db)
    if (old && old.state !== "expired") return old
    if (!enrollmentCreationEnabled())
      throw new AppError(
        503,
        "enrollment_creation_disabled",
        "New trial Checkout is unavailable."
      )
    if (row.activatedAt)
      throw new AppError(
        409,
        "enrollment_already_activated",
        "Recover the existing subscription."
      )
    const identity = row.initiatingProviderUserId
      ? await db.queryOne<{ id: string; email: string }>(
          "SELECT id,email FROM users WHERE supabase_user_id=?",
          [row.initiatingProviderUserId]
        )
      : undefined
    if (identity) {
      const claim = {
        userId: identity.id,
        providerUserId: row.initiatingProviderUserId!,
        email: identity.email,
      }
      if (!(await trialAllowedForIdentity(claim, { enrollmentId: row.id }, db)))
        throw new AppError(
          409,
          "enrollment_trial_ineligible",
          "This identity is not eligible for another trial."
        )
      await reserveEnrollmentTrialIdentity(row.id, claim, db)
    }
    const generation = old
        ? row.checkoutGeneration + 1
        : row.checkoutGeneration,
      requestId = newId(),
      key = `enrollment:${row.id}:checkout:${generation}`,
      now = nowIso()
    const metadata = {
      enrollment_id: row.id,
      request_generation: String(generation),
      request_id: requestId,
    }
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      client_reference_id: row.id,
      metadata,
      payment_method_collection: "always",
      payment_method_types: ["card"],
      name_collection: { business: { enabled: true, optional: false } },
      managed_payments: { enabled: false },
      integration_identifier: "fundlane_company_subscription_ndmotxpw",
      line_items: [{ price: row.offer.basePriceId, quantity: 1 }],
      subscription_data: {
        metadata,
        billing_mode: { type: "flexible" },
        trial_period_days: 14,
        trial_settings: { end_behavior: { missing_payment_method: "pause" } },
      },
      success_url: `${onboardingOrigin()}/enrollment?enrollment=${encodeURIComponent(row.id)}`,
      cancel_url: `${onboardingOrigin()}/enrollment?enrollment=${encodeURIComponent(row.id)}&checkout=canceled`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      ...(row.offer.automaticTax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: "required",
          }
        : {}),
      ...(row.offer.promotionCodes ? { allow_promotion_codes: true } : {}),
    }
    const json = JSON.stringify(params)
    await db.execute(
      "INSERT INTO mca_enrollment_checkout_requests(id,enrollment_id,generation,request_key,request_cipher,payload_hash,provider_account_id,state,requested_at,idempotency_expires_at,updated_at) VALUES (?,?,?,?,?,?,?,'creating',?,?,?)",
      [
        requestId,
        row.id,
        generation,
        key,
        encryptSensitive(json, requestScope(row.id, generation)),
        hmacScopedToken("onboarding-checkout", row.id, json),
        row.providerAccountId,
        now,
        new Date(Date.now() + 23 * 3600000).toISOString(),
        now,
      ]
    )
    await db.execute(
      "UPDATE mca_enrollments SET checkout_state='creating',checkout_generation=?,checkout_request_key=?,checkout_requested_at=?,revision=revision+1,updated_at=? WHERE id=? AND claim_token=?",
      [generation, key, now, now, row.id, token]
    )
    return (await db.queryOne<EnrollmentCheckoutRequest>(
      "SELECT * FROM mca_enrollment_checkout_requests WHERE id=?",
      [requestId]
    ))!
  })
}
export async function persistCheckoutSession(
  row: EnrollmentRecord,
  request: EnrollmentCheckoutRequest,
  session: Stripe.Checkout.Session,
  token: string
): Promise<boolean> {
  return withImmediateTransaction(async (db) => {
    const locked = await db.queryOne<{
      claim_token: string | null
      lease_until: string | null
    }>(
      "SELECT claim_token,lease_until FROM mca_enrollments WHERE id=? FOR UPDATE",
      [row.id]
    )
    if (
      locked?.claim_token !== token ||
      !locked.lease_until ||
      Date.parse(locked.lease_until) <= Date.now()
    )
      return false
    if (session.status === "expired" && session.subscription)
      throw new AppError(
        409,
        "enrollment_operator_required",
        "Expired session has a subscription."
      )
    const state = session.status
    if (!state)
      throw new AppError(
        409,
        "enrollment_session_mismatch",
        "Checkout state is unavailable."
      )
    await db.execute(
      "UPDATE mca_enrollment_checkout_requests SET checkout_session_id=?,state=?,checkout_expires_at=?,updated_at=? WHERE id=?",
      [
        session.id,
        state,
        new Date(session.expires_at * 1000).toISOString(),
        nowIso(),
        request.id,
      ]
    )
    await db.execute(
      "UPDATE mca_enrollments SET checkout_state=?,checkout_expires_at=?,revision=revision+1,updated_at=? WHERE id=?",
      [
        state,
        new Date(session.expires_at * 1000).toISOString(),
        nowIso(),
        row.id,
      ]
    )
    if (state === "expired")
      await db.execute(
        "UPDATE mca_enrollment_trial_reservations SET released_at=? WHERE enrollment_id=?",
        [nowIso(), row.id]
      )
    return true
  })
}
export async function startEnrollmentCheckout(
  input: { resumeSecret: string; initiatingProviderUserId?: string },
  providedClient?: StripeBillingClient
): Promise<{ enrollmentId: string; checkoutUrl: string }> {
  if (!enrollmentRuntimeEnabled())
    throw new AppError(
      503,
      "enrollment_disabled",
      "Enrollment recovery is unavailable."
    )
  // Force encryption/origin validation before any remote operation or durable request.
  encryptSensitive("configuration-check", "onboarding:configuration")
  onboardingOrigin()
  const existing = await getDatabase().queryOne<{ id: string }>(
    "SELECT id FROM mca_enrollments WHERE resume_secret_hash=?",
    [hashOpaqueToken(input.resumeSecret)]
  )
  if (!existing && !enrollmentCreationEnabled())
    throw new AppError(
      503,
      "enrollment_creation_disabled",
      "New trial Checkout is unavailable."
    )
  const client = providedClient ?? getStripeClient()
  let row = existing ? await findEnrollment(existing.id) : undefined
  const accountId = await verifyEnrollmentAccount(client, row?.offer)
  if (!row) {
    const ids = await verifyBillingPrices(client)
    row = await createEnrollment({
      ...input,
      offer: {
        version: 1,
        accountId,
        basePriceId: ids.base,
        seatPriceId: ids.seats,
        currency: "usd",
        baseAmount: BILLING_CATALOG.base.unitAmountCents,
        quantity: 1,
        trialDays: 14,
        livemode: stripeLiveMode(),
        promotionCodes:
          process.env.MCA_STRIPE_PROMOTION_CODES_ENABLED === "true",
        automaticTax: process.env.MCA_STRIPE_TAX_ENABLED === "true",
      },
    })
  }
  if (row.initiatingProviderUserId !== (input.initiatingProviderUserId ?? null))
    throw new AppError(
      409,
      "enrollment_conflict",
      "Enrollment identity binding differs."
    )
  const lease = await claimEnrollmentOperation(row.id)
  if (!lease)
    throw new AppError(
      409,
      "enrollment_busy",
      "Checkout is being prepared; retry shortly."
    )
  try {
    let request = await prepareRequest(row.id, lease.token)
    row = (await findEnrollment(row.id))!
    let session = await readEnrollmentSession(row, request, client)
    if (!(await persistCheckoutSession(row, request, session, lease.token)))
      throw new AppError(
        409,
        "enrollment_busy",
        "Checkout is being reconciled."
      )
    if (session.status === "expired") {
      request = await prepareRequest(row.id, lease.token)
      row = (await findEnrollment(row.id))!
      session = await readEnrollmentSession(row, request, client)
      if (!(await persistCheckoutSession(row, request, session, lease.token)))
        throw new AppError(
          409,
          "enrollment_busy",
          "Checkout is being reconciled."
        )
    }
    if (
      session.status !== "open" ||
      !session.url ||
      session.expires_at * 1000 <= Date.now()
    )
      throw new AppError(
        409,
        "enrollment_checkout_pending",
        "Checkout requires reconciliation."
      )
    await releaseEnrollmentOperation(row.id, lease.token)
    return { enrollmentId: row.id, checkoutUrl: session.url }
  } catch (error) {
    const code =
      error instanceof AppError ? error.code : "enrollment_checkout_uncertain"
    const now = nowIso()
    await getDatabase().execute(
      `UPDATE mca_enrollment_checkout_requests SET state=CASE WHEN ?='enrollment_operator_required' THEN 'operator_required' ELSE 'uncertain' END,error_code=?,updated_at=?
      WHERE enrollment_id=? AND generation=? AND checkout_session_id IS NULL
      AND EXISTS(SELECT 1 FROM mca_enrollments e WHERE e.id=mca_enrollment_checkout_requests.enrollment_id AND e.claim_token=? AND e.lease_until>?)`,
      [code, code, now, row.id, row.checkoutGeneration, lease.token, now]
    )
    await releaseEnrollmentOperation(row.id, lease.token, code)
    throw error
  }
}
