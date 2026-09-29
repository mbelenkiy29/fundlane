import "server-only"
import Stripe from "stripe"
import { AppError } from "../errors"
import { getDatabase, newId, nowIso, withTransaction } from "../db"
import {
  creditEntry,
  lockCreditAccount,
  recordCreditBalanceChange
} from "./credits"

export const CREDIT_PACK = {
  credits: 100,
  amount: 1000,
  currency: "usd"
} as const
export function purchasesAvailable() {
  return (
    process.env.MCA_AI_CREDIT_PURCHASES_ENABLED === "true" &&
    Boolean(
      process.env.STRIPE_SECRET_KEY &&
        process.env.STRIPE_WEBHOOK_SECRET &&
        process.env.MCA_APP_ORIGIN
    )
  )
}
export function creditStripe() {
  if (!process.env.STRIPE_SECRET_KEY)
    throw new AppError(
      503,
      "payments_unconfigured",
      "Credit purchases are not configured yet."
    )
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 1,
    timeout: 20000
  })
}
interface Purchase {
  id: string
  workspace_id: string
  buyer_user_id: string
  recipient_user_id: string
  session_id: string | null
  payment_intent_id: string | null
  credits: number
  amount: number
  currency: string
  state: string
  granted: number
  reversed: number
}
export async function createCreditCheckout(
  workspaceId: string,
  buyerUserId: string,
  recipientUserId: string,
  requestId: string,
  stripe?: Stripe
) {
  if (!purchasesAvailable())
    throw new AppError(
      503,
      "purchases_disabled",
      "AI credit purchases are not available yet."
    )
  stripe ??= creditStripe()
  const purchase = await withTransaction(async (db) => {
    const admin = await db
      .prepare(
        "SELECT id FROM memberships WHERE workspace_id=? AND user_id=? AND status='active' AND role IN ('admin','super_admin')"
      )
      .get(workspaceId, buyerUserId)
    if (!admin)
      throw new AppError(
        403,
        "admin_required",
        "Only a company admin can buy credits."
      )
    await lockCreditAccount(db, {
      workspace_id: workspaceId,
      user_id: recipientUserId
    })
    const id = newId()
    await db
      .prepare(
        "INSERT INTO mca_credit_purchases (id,workspace_id,buyer_user_id,recipient_user_id,request_id,state,created_at) VALUES (?,?,?,?,?,'created',?) ON CONFLICT(workspace_id,request_id) DO NOTHING"
      )
      .run(id, workspaceId, buyerUserId, recipientUserId, requestId, nowIso())
    const p = (await db
      .prepare<Purchase>(
        "SELECT * FROM mca_credit_purchases WHERE workspace_id=? AND request_id=?"
      )
      .get(workspaceId, requestId))!
    if (
      p.buyer_user_id !== buyerUserId ||
      p.recipient_user_id !== recipientUserId
    )
      throw new AppError(
        409,
        "purchase_changed",
        "This purchase request is already bound to a different user."
      )
    return p
  })
  let session: Stripe.Checkout.Session
  if (purchase.session_id)
    session = await stripe.checkout.sessions.retrieve(purchase.session_id)
  else {
    // Persisted purchase ID is also the provider idempotency key, including uncertain retries.
    const suffix = purchase.id
      .replaceAll("-", "")
      .slice(0, 8)
      .replace(/[0-9]/g, (n) => String.fromCharCode(97 + Number(n)))
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: purchase.id,
        integration_identifier: `mca_credit_pack_${suffix}`,
        // Fundlane sells as the merchant. Stripe accounts can default Checkout to Managed
        // Payments, which rejects this untaxed-code price ("product tax code is missing"),
        // so opt out explicitly, matching company Checkout (#183).
        managed_payments: { enabled: false },
        metadata: {
          purchase_id: purchase.id,
          workspace_id: workspaceId,
          recipient_user_id: recipientUserId
        },
        line_items: [
          {
            price_data: {
              currency: CREDIT_PACK.currency,
              unit_amount: CREDIT_PACK.amount,
              product_data: { name: "100 AI assistant credits" }
            },
            quantity: 1
          }
        ],
        payment_intent_data: { metadata: { purchase_id: purchase.id } },
        success_url: new URL(
          `/assistant/credits?workspace=${workspaceId}&purchase=${purchase.id}`,
          process.env.MCA_APP_ORIGIN
        ).toString(),
        cancel_url: new URL(
          `/assistant/credits?workspace=${workspaceId}&user=${recipientUserId}`,
          process.env.MCA_APP_ORIGIN
        ).toString()
      },
      { idempotencyKey: `mca-credit:${purchase.id}` }
    )
    await getDatabase()
      .prepare(
        "UPDATE mca_credit_purchases SET session_id=?,state='checkout' WHERE id=? AND session_id IS NULL"
      )
      .run(session.id, purchase.id)
  }
  return { purchaseId: purchase.id, url: session.url, state: session.status }
}
const objectId = (x: string | { id: string } | null) =>
  typeof x === "string" ? x : (x?.id ?? null)
/** Always re-read provider state. Replayed or out-of-order webhooks cannot replay a grant. */
export async function reconcileCreditPurchase(
  purchaseId: string,
  stripe = creditStripe()
) {
  const p = await getDatabase()
    .prepare<Purchase>("SELECT * FROM mca_credit_purchases WHERE id=?")
    .get(purchaseId)
  if (!p?.session_id) return { state: "pending" }
  return withTransaction(async (db) => {
    const current = (await db
      .prepare<Purchase>(
        "SELECT * FROM mca_credit_purchases WHERE id=? FOR UPDATE"
      )
      .get(p.id))!
    const session = await stripe.checkout.sessions.retrieve(p.session_id!)
    if (
      session.mode !== "payment" ||
      session.client_reference_id !== p.id ||
      session.metadata?.purchase_id !== p.id ||
      session.metadata?.workspace_id !== p.workspace_id ||
      session.metadata?.recipient_user_id !== p.recipient_user_id ||
      session.amount_total !== p.amount ||
      session.currency !== p.currency
    )
      throw new AppError(
        409,
        "payment_mismatch",
        "Payment details do not match the recorded credit purchase."
      )
    const paid = session.payment_status === "paid"
    const intentId = objectId(session.payment_intent)
    if (paid && !intentId)
      throw new AppError(
        409,
        "payment_unsettled",
        "Payment confirmation is incomplete."
      )
    let reversed = current.reversed
    if (paid && intentId) {
      const intent = await stripe.paymentIntents.retrieve(intentId, {
        expand: ["latest_charge"]
      })
      if (
        intent.amount !== p.amount ||
        intent.currency !== p.currency ||
        intent.status !== "succeeded"
      )
        throw new AppError(409, "payment_unsettled", "Payment is not settled.")
      const charge =
        typeof intent.latest_charge === "object" ? intent.latest_charge : null
      reversed = Math.min(
        p.credits,
        Math.ceil(((charge?.amount_refunded ?? 0) * p.credits) / p.amount)
      )
      if (charge?.disputed) {
        const disputes = await stripe.disputes.list({
          payment_intent: intentId,
          limit: 100
        })
        if (
          disputes.data.some(
            (d) => !["won", "warning_closed"].includes(d.status)
          )
        )
          reversed = p.credits
      }
    }
    const account = await db
      .prepare<{
        id: string
      }>("SELECT id FROM mca_credit_accounts WHERE workspace_id=? AND user_id=? FOR UPDATE")
      .get(p.workspace_id, p.recipient_user_id)
    if (!account)
      throw new AppError(
        409,
        "purchase_account_missing",
        "The purchased-credit account needs reconciliation."
      )
    const grant = paid ? p.credits : current.granted
    const delta = grant - reversed - (current.granted - current.reversed)
    if (delta) {
      await db
        .prepare(
          "UPDATE mca_credit_accounts SET purchased_balance=purchased_balance+?,alert_dirty=1 WHERE id=?"
        )
        .run(delta, account.id)
      await recordCreditBalanceChange(db, account.id)
      await creditEntry(
        db,
        account.id,
        `purchase:${p.id}:${newId()}`,
        delta > 0
          ? current.granted
            ? "purchase_restored"
            : "purchase_grant"
          : "purchase_reversed",
        delta,
        "purchased"
      )
    }
    const state = paid
      ? reversed === p.credits
        ? "reversed"
        : "paid"
      : session.status === "expired"
        ? "expired"
        : "pending"
    await db
      .prepare(
        "UPDATE mca_credit_purchases SET granted=?,reversed=?,payment_intent_id=?,state=? WHERE id=?"
      )
      .run(grant, reversed, intentId, state, p.id)
    return { state, creditsGranted: grant, creditsReversed: reversed }
  })
}
export async function processCreditPaymentEvent(
  event: Stripe.Event,
  stripe = creditStripe()
) {
  if (event.type.startsWith("checkout.session.")) {
    const session = event.data.object as Stripe.Checkout.Session
    const id = session.metadata?.purchase_id
    if (!id) return
    const p = await getDatabase()
      .prepare<Purchase>("SELECT * FROM mca_credit_purchases WHERE id=?")
      .get(id)
    if (!p) return
    if (!p.session_id) {
      const fresh = await stripe.checkout.sessions.retrieve(session.id)
      if (
        fresh.client_reference_id !== id ||
        fresh.metadata?.workspace_id !== p.workspace_id ||
        fresh.metadata?.recipient_user_id !== p.recipient_user_id
      )
        return
      await getDatabase()
        .prepare(
          "UPDATE mca_credit_purchases SET session_id=? WHERE id=? AND session_id IS NULL"
        )
        .run(session.id, id)
    }
    await reconcileCreditPurchase(id, stripe)
    if (event.type === "checkout.session.async_payment_failed")
      await getDatabase()
        .prepare(
          "UPDATE mca_credit_purchases SET state='failed' WHERE id=? AND granted=0"
        )
        .run(id)
  } else if (
    event.type === "charge.refunded" ||
    event.type.startsWith("charge.dispute.")
  ) {
    const item = event.data.object as Stripe.Charge | Stripe.Dispute
    const intent = objectId(item.payment_intent)
    if (!intent) return
    let p = await getDatabase()
      .prepare<Purchase>(
        "SELECT * FROM mca_credit_purchases WHERE payment_intent_id=?"
      )
      .get(intent)
    if (!p) {
      const pi = await stripe.paymentIntents.retrieve(intent)
      const id = pi.metadata.purchase_id
      if (id)
        p = await getDatabase()
          .prepare<Purchase>("SELECT * FROM mca_credit_purchases WHERE id=?")
          .get(id)
    }
    if (p) await reconcileCreditPurchase(p.id, stripe)
  }
}
