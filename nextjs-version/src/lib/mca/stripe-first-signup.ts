import "server-only"
import { getDatabase, newId, nowIso, withImmediateTransaction } from "./db"
import { createOpaqueToken, hashOpaqueToken, encryptSensitive, decryptSensitive } from "./crypto"
import { AppError } from "./errors"
import { getStripeClient, stripeLiveMode, verifyBillingPrices, billingTrialDays, syncWorkspaceBilling, type StripeBillingClient } from "./billing"
import { isStripeCheckoutTrialConfigured } from "./stripe-checkout-trial"
import { trialAllowedForOwner, reserveTrialForCheckout } from "./trial-abuse"
import { requireOpenSignup } from "./signup-guard"
import { deliverEmail } from "./email"
import { assertTrustedMutation } from "./auth"
import { BILLING_PLANS } from "./billing-catalog"

export const SIGNUP_COOKIE = "fundlane_signup"
export const SIGNUP_LIFETIME_SECONDS = 7 * 86400
type Intent = { created_at:string; id:string; token_hash:string; token_cipher:string; checkout_session_id:string|null; checkout_email:string|null; payment_method_id:string|null; state:string; livemode:number; expires_at:string; workspace_id:string|null; user_id:string|null; activation_started_at:string|null; subscription_id:string|null; email_sent_at:string|null; email_retry_until:string|null }
const invalid = () => new AppError(410,"signup_intent_expired","This signup link is invalid or expired. Please get started again.")
function assertIntent(row:Intent|undefined): asserts row is Intent {
  if (!row || row.expires_at <= nowIso()) throw invalid()
  if (Boolean(row.livemode) !== stripeLiveMode()) throw new AppError(409,"signup_mode_mismatch","Restart signup in the current billing environment.")
}
export function signupOrigin() {
  const url = new URL(process.env.MCA_APP_ORIGIN ?? "http://localhost:3000")
  const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname)
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new AppError(503,"billing_origin_invalid","Signup requires a configured application origin.")
  return url.origin
}
export async function readSignupIntent(token:string) {
  const row = await getDatabase().prepare<Intent>("SELECT * FROM company_signup_intents WHERE token_hash=?").get(hashOpaqueToken(token))
  assertIntent(row)
  return row
}
export function assertSignupOrigin(request:Request) {
  assertTrustedMutation(request)
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new AppError(403,"untrusted_origin","Signup requires a same-origin request.")
}
export async function requireSignupEmail(token:string,email:string) {
  const row=await readSignupIntent(token)
  if (!row.payment_method_id || row.state==="pending") throw new AppError(409,"signup_card_incomplete","Finish saving your card first.")
  if (row.checkout_email!==email.trim().toLowerCase()) throw new AppError(403,"signup_email_mismatch","Use the same email used at Stripe.")
  return row
}
export async function createSignupIntent() {
  requireOpenSignup()
  const token=createOpaqueToken(),id=newId(),now=nowIso()
  await getDatabase().prepare(`INSERT INTO company_signup_intents (id,token_hash,token_cipher,livemode,state,expires_at,created_at,updated_at)
    VALUES (?,?,?,?,'pending',?,?,?)`).run(id,hashOpaqueToken(token),encryptSensitive(token,id),stripeLiveMode()?1:0,new Date(Date.now()+SIGNUP_LIFETIME_SECONDS*1000).toISOString(),now,now)
  return token
}

export async function beginSignupCheckout(token?:string, client:StripeBillingClient=getStripeClient()) {
  requireOpenSignup()
  if (!isStripeCheckoutTrialConfigured()) throw new AppError(503,"billing_checkout_unavailable","Signup billing is temporarily unavailable. Please try again later.")
  await verifyBillingPrices(client)
  const origin=signupOrigin()
  // A durable intent precedes Stripe. Retries after a timeout use the same idempotency key.
  let row:Intent|undefined
  if (token) { try { row=await readSignupIntent(token) } catch(error) { if (!(error instanceof AppError && error.code==="signup_intent_expired")) throw error } }
  if (!row) {
    token=await createSignupIntent()
    row=await readSignupIntent(token)
  }
  assertIntent(row)
  const signupToken=token!
  return withImmediateTransaction(async db=>{
    const current=await db.prepare<Intent>("SELECT * FROM company_signup_intents WHERE id=? FOR UPDATE").get(row.id)
    assertIntent(current)
    if (current.state!=="pending") return {token:signupToken,url:`${origin}/sign-up?next=%2Factivate`}
    if (current.checkout_session_id) {
      const session=await client.checkout.sessions.retrieve(current.checkout_session_id)
      if (session.livemode!==stripeLiveMode()) throw new AppError(409,"signup_mode_mismatch","Checkout mode mismatch.")
      if (session.status==="open" && session.url) return {token:signupToken,url:session.url}
      if (session.status==="complete") return {token:signupToken,url:`${origin}/signup-return?session_id=${session.id}`}
      throw new AppError(410,"signup_checkout_expired","Checkout expired. Start a new signup.")
    }
    if (Date.parse(current.created_at)<Date.now()-30*60000) throw new AppError(410,"signup_checkout_expired","Checkout expired. Start a new signup.")
    const session=await client.checkout.sessions.create({mode:"setup",currency:"usd",payment_method_types:["card"],billing_address_collection:"required",
      metadata:{fundlane_signup_intent:current.id},setup_intent_data:{metadata:{fundlane_signup_intent:current.id}},
      success_url:`${origin}/signup-return?session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${origin}/get-started?canceled=1`,
      custom_text:{submit:{message:`Save your card, then activate Fundlane to start your eligible 14-day trial. After the trial: $${BILLING_PLANS[0].monthlyUsd}/month including one user, plus applicable tax. Cancel before the trial ends to avoid a subscription charge.`}},
      expires_at:Math.floor(Date.parse(current.created_at)/1000)+3600,
    },{idempotencyKey:`fundlane-signup-setup-${current.id}`})
    if (session.livemode!==stripeLiveMode() || !session.url) throw new AppError(503,"billing_checkout_unavailable","Checkout is temporarily unavailable.")
    await db.prepare("UPDATE company_signup_intents SET checkout_session_id=?,updated_at=? WHERE id=?").run(session.id,nowIso(),current.id)
    return {token:signupToken,url:session.url}
  })
}

export async function completeSignupSetup(sessionId:string, client?:StripeBillingClient) {
  const row=await getDatabase().prepare<Intent>("SELECT * FROM company_signup_intents WHERE checkout_session_id=?").get(sessionId)
  if (!row) return false // Existing subscription Checkout continues through the ordinary billing handler.
  if (row.expires_at<=nowIso()) return true // Acknowledge delayed setup webhooks without starting billing.
  assertIntent(row)
  client??=getStripeClient()
  const session=await client.checkout.sessions.retrieve(sessionId,{expand:["setup_intent"]})
  if (session.livemode!==stripeLiveMode() || session.mode!=="setup" || session.metadata?.fundlane_signup_intent!==row.id)
    throw new AppError(400,"signup_checkout_mismatch","Signup checkout could not be verified.")
  if (session.status!=="complete") throw new AppError(409,"signup_card_incomplete","Finish saving your card in Stripe first.")
  const setup=typeof session.setup_intent==="string" ? await client.setupIntents.retrieve(session.setup_intent) : session.setup_intent
  const email=session.customer_details?.email?.trim().toLowerCase()
  const paymentMethod=typeof setup?.payment_method==="string" ? setup.payment_method : setup?.payment_method?.id
  if (!email || !paymentMethod || setup?.status!=="succeeded" || setup.livemode!==stripeLiveMode())
    throw new AppError(409,"signup_card_incomplete","Stripe has not confirmed the saved card yet.")
  await getDatabase().prepare(`UPDATE company_signup_intents SET checkout_email=?,payment_method_id=?,state=CASE WHEN state='pending' THEN 'ready' ELSE state END,updated_at=? WHERE id=?`).run(email,paymentMethod,nowIso(),row.id)
  return true
}

export async function sendSignupRecovery(sessionId:string) {
  const row=await getDatabase().prepare<Intent>("SELECT * FROM company_signup_intents WHERE checkout_session_id=?").get(sessionId)
  if (!row || row.state!=="ready" || row.email_sent_at || !row.checkout_email || row.expires_at<=nowIso()) return
  // Freeze a short delivery retry window; do not resend outside provider deduplication guarantees.
  await getDatabase().prepare("UPDATE company_signup_intents SET email_retry_until=COALESCE(email_retry_until,?) WHERE id=?").run(new Date(Date.now()+23*3600000).toISOString(),row.id)
  if (row.email_retry_until && row.email_retry_until<=nowIso()) throw new AppError(503,"signup_email_review_required","Signup recovery email requires delivery review.")
  const token=decryptSensitive(row.token_cipher,row.id)
  const result=await deliverEmail({template:"signup_activation",recipient:row.checkout_email,actionUrl:`${signupOrigin()}/signup-resume?token=${token}`,expiresAt:row.expires_at},
    {correlationId:`fundlane-signup-recovery-${row.id}`})
  if (result.delivery!=="sent") throw new AppError(503,"signup_email_unavailable","Signup recovery email has not been sent.")
  await getDatabase().prepare("UPDATE company_signup_intents SET email_sent_at=? WHERE id=?").run(nowIso(),row.id)
}

/** Caller supplies an independently verified Supabase identity, never a posted email/user/workspace. */
export async function activateSignup(token:string, context:{workspaceId:string;userId:string;email:string}, client:StripeBillingClient=getStripeClient()) {
  const row=await readSignupIntent(token)
  if (!row.payment_method_id || row.state==="pending") throw new AppError(409,"signup_card_incomplete","Finish saving your card before activating.")
  if (!row.checkout_email || row.checkout_email!==context.email.trim().toLowerCase()) throw new AppError(403,"signup_email_mismatch","Verify and sign in with the same email used at Stripe.")
  const ids=await verifyBillingPrices(client)
  const decision=await withImmediateTransaction(async db=>{
    const current=await db.prepare<Intent>("SELECT * FROM company_signup_intents WHERE id=? FOR UPDATE").get(row.id)
    assertIntent(current)
    if (current.workspace_id && (current.workspace_id!==context.workspaceId || current.user_id!==context.userId)) throw new AppError(409,"signup_already_claimed","This signup was already claimed by another company.")
    const owner=await db.prepare<{email:string}>(`SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=? AND m.user_id=? AND m.status='active'`).get(context.workspaceId,context.userId)
    if (!owner || owner.email.trim().toLowerCase()!==context.email.trim().toLowerCase()) throw new AppError(403,"signup_owner_required","Only the verified company owner can activate signup.")
    if (current.state==="active" || current.state==="paid_required" || current.state==="activating") return current.state
    const existing=await db.prepare("SELECT workspace_id FROM workspace_stripe_customers WHERE workspace_id=?").get(context.workspaceId)
    if (existing) throw new AppError(409,"billing_subscription_exists","Use your company's existing Plans & Billing.")
    const trial=await trialAllowedForOwner(context.workspaceId,db)
    await db.prepare("UPDATE company_signup_intents SET workspace_id=?,user_id=?,state=?,activation_started_at=?,updated_at=? WHERE id=?").run(context.workspaceId,context.userId,trial?"activating":"paid_required",nowIso(),nowIso(),current.id)
    if (trial) await reserveTrialForCheckout(context.workspaceId,current.checkout_session_id!,Math.floor(Date.now()/1000)+86400,db)
    return trial?"activating":"paid_required"
  })
  if (decision==="active") return {status:"active" as const}
  // Existing catalog/customer machinery needs a workspace before creating the real Stripe customer.
  const current=await readSignupIntent(token)
  let mapping=await getDatabase().prepare<{stripe_customer_id:string;livemode:number}>("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id=?").get(context.workspaceId)
  if (!mapping) {
    if (Date.parse(current.activation_started_at!) < Date.now()-23*3600000) throw new AppError(503,"signup_activation_review_required","Activation needs support review. No new charge has been created.")
    const method=await client.paymentMethods.retrieve(row.payment_method_id)
    if (method.livemode!==stripeLiveMode() || method.customer) throw new AppError(409,"signup_card_mismatch","The saved card cannot be attached to this company.")
    const address=method.billing_details.address
    const customer=await client.customers.create({email:context.email,...(address?{address:{city:address.city??undefined,country:address.country??undefined,line1:address.line1??undefined,line2:address.line2??undefined,postal_code:address.postal_code??undefined,state:address.state??undefined}}:{}),metadata:{workspace_id:context.workspaceId,fundlane_signup_intent:row.id}}, {idempotencyKey:`fundlane-signup-customer-${row.id}`})
    if (customer.livemode!==stripeLiveMode()) throw new AppError(409,"signup_mode_mismatch","Customer mode mismatch.")
    await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,livemode,created_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO NOTHING").run(context.workspaceId,customer.id,stripeLiveMode()?1:0,nowIso())
    mapping={stripe_customer_id:customer.id,livemode:stripeLiveMode()?1:0}
  }
  if (Boolean(mapping.livemode)!==stripeLiveMode()) throw new AppError(409,"signup_mode_mismatch","Customer mode mismatch.")
  const method=await client.paymentMethods.retrieve(row.payment_method_id)
  const methodCustomer=typeof method.customer==="string"?method.customer:method.customer?.id
  if (method.livemode!==stripeLiveMode() || (methodCustomer && methodCustomer!==mapping.stripe_customer_id)) throw new AppError(409,"signup_card_mismatch","The saved card belongs to another customer.")
  if (!methodCustomer) await client.paymentMethods.attach(method.id,{customer:mapping.stripe_customer_id},{idempotencyKey:`fundlane-signup-attach-${row.id}`})
  await client.customers.update(mapping.stripe_customer_id,{invoice_settings:{default_payment_method:method.id}},{idempotencyKey:`fundlane-signup-default-${row.id}`})
  if (decision==="paid_required") return {status:"paid_required" as const}
  const subscriptions=await client.subscriptions.list({customer:mapping.stripe_customer_id,status:"all",limit:100})
  if (subscriptions.has_more) throw new AppError(503,"signup_activation_review_required","Subscription history needs support review.")
  let subscription=subscriptions.data.find(sub=>sub.metadata?.fundlane_signup_intent===row.id)
  if (!subscription) {
    if (subscriptions.data.length || Date.parse(current.activation_started_at!) < Date.now()-23*3600000) throw new AppError(409,"signup_activation_review_required","Activation needs support review before creating another subscription.")
    subscription=await client.subscriptions.create({customer:mapping.stripe_customer_id,items:[{price:ids.base,quantity:1}],default_payment_method:method.id,
      metadata:{workspace_id:context.workspaceId,fundlane_signup_intent:row.id},billing_mode:{type:"flexible"},trial_period_days:billingTrialDays(),
      trial_settings:{end_behavior:{missing_payment_method:"pause"}},...(process.env.MCA_STRIPE_TAX_ENABLED==="true"?{automatic_tax:{enabled:true}}:{}),
    },{idempotencyKey:`fundlane-signup-subscription-${row.id}`})
  }
  if (subscription.livemode!==stripeLiveMode()) throw new AppError(409,"signup_mode_mismatch","Subscription mode mismatch.")
  const billing=await syncWorkspaceBilling(context.workspaceId,client)
  if (billing.subscriptionId!==subscription.id || !["trialing","active"].includes(billing.status)) throw new AppError(409,"signup_activation_pending","Your subscription is being verified. Retry activation shortly.")
  await getDatabase().prepare("UPDATE company_signup_intents SET state='active',subscription_id=?,updated_at=? WHERE id=?").run(subscription.id,nowIso(),row.id)
  return {status:"active" as const}
}
