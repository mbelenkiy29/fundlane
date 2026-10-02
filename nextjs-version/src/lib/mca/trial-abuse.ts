import type Stripe from "stripe"
import { assertTransactionExecutor, recordAuditEvent, nowIso, type DbExecutor } from "./db"

import { enrollmentEmailHash, enrollmentEmailDomainHash } from "./onboarding/store"

const freeMailDomains = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "proton.me", "protonmail.com"])
const positiveLimit = (raw: string | undefined, fallback: number | null) => raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : fallback

export const trialAbuseLimitsEnabled = () => process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED === "true"

export function trialFingerprintAction(): "flag" | "off" {
  const configured = process.env.MCA_TRIAL_FINGERPRINT_ACTION
  if (configured === undefined || configured === "flag") return "flag"
  if (configured === "off") return "off"
  console.warn("Invalid MCA_TRIAL_FINGERPRINT_ACTION; falling back to flag.")
  return "flag"
}

async function owner(workspaceId: string, db: DbExecutor) {
  const row = await db.prepare<{user_id:string;email:string}>(`SELECT m.user_id,u.email FROM workspace_owners o
    JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id
    JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?`).get(workspaceId)
  if (!row) return null
  const email = row.email.trim().toLowerCase()
  return {userId:row.user_id,email,domain:email.split("@")[1] ?? ""}
}

export interface TrialIdentity { userId?:string; providerUserId?:string; email:string }
export interface TrialScope { workspaceId?:string; enrollmentId?:string }

/** Caller holds these namespace-105 transaction locks through reservation/final claim. */
export async function trialAllowedForIdentity(input:TrialIdentity, scope:TrialScope, db:DbExecutor) {
  if (!trialAbuseLimitsEnabled()) return true
  const email=input.email.trim().toLowerCase(),domain=email.split("@")[1]??""
  const perUser=positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_USER,1)!,perEmail=positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_EMAIL,1)!,perDomain=positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_DOMAIN,null)
  const keys=[`email:${email}`]
  if(input.userId)keys.push(`user:${input.userId}`)
  if(input.providerUserId)keys.push(`provider:${input.providerUserId}`)
  if(perDomain && domain && !freeMailDomains.has(domain))keys.push(`domain:${domain}`)
  for(const key of keys.sort())await db.prepare("SELECT pg_advisory_xact_lock(105, hashtext(?))").get(key)
  const count=async(kind:"user"|"email"|"domain")=>{
    const column=kind==="user"?"owner_user_id":kind==="email"?"owner_email":"email_domain"
    const value=kind==="user"?input.userId??"":kind==="email"?email:domain
    const enrollmentPredicate=kind==="user"?"(e.user_id=? OR e.claimed_provider_user_id::text=? OR e.initiating_provider_user_id::text=? OR r.owner_user_id=? OR r.provider_user_id::text=?)":kind==="email"?"(e.activation_email_hash=? OR (r.released_at IS NULL AND r.email_hash=?))":"(e.activation_email_domain_hash=? OR (r.released_at IS NULL AND r.domain_hash=?))"
    const hash=kind==="email"?enrollmentEmailHash(email):enrollmentEmailDomainHash(email)
    const values=kind==="user"?[input.userId??"",input.providerUserId??"",input.providerUserId??"",input.userId??"",input.providerUserId??""]:[hash,hash]
    // Workspace keys collapse transferred enrollment history and legacy grants;
    // unclaimed history and reservations share an enrollment key.
    return (await db.queryOne<{count:number}>(`SELECT count(*)::int count FROM (
      SELECT 'workspace:'||workspace_id k FROM company_trial_grants WHERE ${column}=? AND workspace_id<>?
      UNION SELECT 'workspace:'||workspace_id FROM company_trial_reservations WHERE ${column}=? AND workspace_id<>?
      UNION SELECT CASE WHEN e.workspace_id IS NOT NULL THEN 'workspace:'||e.workspace_id ELSE 'enrollment:'||e.id END
      FROM mca_enrollments e LEFT JOIN mca_enrollment_trial_reservations r ON r.enrollment_id=e.id
      WHERE e.id<>? AND COALESCE(e.workspace_id,'')<>? AND (e.trial_started_at IS NOT NULL OR (r.enrollment_id IS NOT NULL AND r.released_at IS NULL)) AND ${enrollmentPredicate}
    ) used`,[value,scope.workspaceId??"",value,scope.workspaceId??"",scope.enrollmentId??"",scope.workspaceId??"_none_",...values]))?.count??0
  }
  if((input.userId||input.providerUserId)&&await count("user")>=perUser || await count("email")>=perEmail)return false
  return !(perDomain && domain && !freeMailDomains.has(domain) && await count("domain")>=perDomain)
}
export async function trialAllowedForOwner(workspaceId:string,db:DbExecutor) {
  if(!trialAbuseLimitsEnabled())return true
  const identity=await owner(workspaceId,db)
  return identity?trialAllowedForIdentity(identity,{workspaceId},db):false
}
export async function reserveEnrollmentTrialIdentity(enrollmentId:string,identity:TrialIdentity,db:DbExecutor) {
  assertTransactionExecutor(db)
  await db.execute(`INSERT INTO mca_enrollment_trial_reservations(enrollment_id,owner_user_id,provider_user_id,email_hash,domain_hash,created_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(enrollment_id) DO UPDATE SET released_at=NULL`,[enrollmentId,identity.userId??null,identity.providerUserId??null,enrollmentEmailHash(identity.email),enrollmentEmailDomainHash(identity.email),nowIso()])
}

/** Call after Stripe creates the session, inside the eligibility transaction. */
export async function reserveTrialForCheckout(workspaceId:string, sessionId:string, expiresAt:number, db:DbExecutor) {
  if (!trialAbuseLimitsEnabled()) return
  const identity = await owner(workspaceId,db)
  if (!identity) return
  await db.prepare(`INSERT INTO company_trial_reservations
    (workspace_id,checkout_session_id,owner_user_id,owner_email,email_domain,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT (workspace_id) DO UPDATE SET
    checkout_session_id=EXCLUDED.checkout_session_id,owner_user_id=EXCLUDED.owner_user_id,
    owner_email=EXCLUDED.owner_email,email_domain=EXCLUDED.email_domain,
    expires_at=EXCLUDED.expires_at,created_at=EXCLUDED.created_at`).run(
    workspaceId,sessionId,identity.userId,identity.email,identity.domain,new Date(expiresAt*1000).toISOString(),nowIso())
}

export async function releaseTrialReservation(workspaceId:string, sessionId:string, db:DbExecutor) {
  if (!trialAbuseLimitsEnabled()) return
  await db.prepare("DELETE FROM company_trial_reservations WHERE workspace_id=? AND checkout_session_id=?").run(workspaceId,sessionId)
}

export async function recordTrialGrant(workspaceId:string, subscription:Stripe.Subscription, client:Pick<Stripe,"paymentMethods"|"setupIntents">, db:DbExecutor) {
  if (!trialAbuseLimitsEnabled() || !subscription.trial_start || !subscription.trial_end) return
  // The reservation records who claimed this Checkout trial. Ownership may
  // transfer before Stripe makes the resulting subscription visible.
  const reserved = await db.prepare<{owner_user_id:string;owner_email:string;email_domain:string}>(
    "SELECT owner_user_id,owner_email,email_domain FROM company_trial_reservations WHERE workspace_id=?"
  ).get(workspaceId)
  const identity = reserved
    ? {userId:reserved.owner_user_id,email:reserved.owner_email,domain:reserved.email_domain}
    : await owner(workspaceId,db)
  if (!identity) return
  let paymentMethod = subscription.default_payment_method
  if (!paymentMethod && subscription.pending_setup_intent) {
    try {
      const setup = await client.setupIntents.retrieve(typeof subscription.pending_setup_intent === "string" ? subscription.pending_setup_intent : subscription.pending_setup_intent.id)
      paymentMethod = setup.payment_method
    } catch { /* A pending or inaccessible setup intent cannot block reconciliation. */ }
  }
  let fingerprint:string|null = null
  if (paymentMethod) try {
    const method = typeof paymentMethod === "string" ? await client.paymentMethods.retrieve(paymentMethod) : paymentMethod
    fingerprint = method.card?.fingerprint ?? null
  } catch { /* Missing card details do not change the entitlement. */ }
  await persistTrialGrant(workspaceId,{subscriptionId:subscription.id,trialStartedAt:new Date(subscription.trial_start*1000).toISOString(),identity,fingerprint},db)
}
/** DB-only grant transfer. Card reuse is review evidence, never a denial. */
export async function persistTrialGrant(workspaceId:string,input:{subscriptionId:string;trialStartedAt:string;identity:TrialIdentity;fingerprint:string|null},db:DbExecutor) {
  const {fingerprint}=input
  const identity={userId:input.identity.userId,email:input.identity.email.trim().toLowerCase(),domain:input.identity.email.trim().toLowerCase().split("@")[1]??""}
  if(!identity.userId)return
  // Reconciliation runs under a workspace lock; serialize only matching cards
  // so concurrent first grants cannot both miss the review match.
  if (fingerprint) await db.prepare("SELECT pg_advisory_xact_lock(105, hashtext(?))").get(fingerprint)
  const existing = await db.prepare<{card_fingerprint:string|null;fingerprint_flagged_at:string|null}>("SELECT card_fingerprint,fingerprint_flagged_at FROM company_trial_grants WHERE workspace_id=?").get(workspaceId)
  if (!existing) await db.prepare(`INSERT INTO company_trial_grants (workspace_id,stripe_subscription_id,owner_user_id,owner_email,email_domain,card_fingerprint,trial_started_at,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(workspaceId,input.subscriptionId,identity.userId,identity.email,identity.domain,fingerprint,input.trialStartedAt,nowIso())
  else if (fingerprint && !existing.card_fingerprint) await db.prepare("UPDATE company_trial_grants SET card_fingerprint=? WHERE workspace_id=?").run(fingerprint,workspaceId)
  await db.prepare("DELETE FROM company_trial_reservations WHERE workspace_id=?").run(workspaceId)
  if (!fingerprint || existing?.fingerprint_flagged_at || trialFingerprintAction() === "off") return
  const repeat = await db.prepare<{workspace_id:string}>("SELECT workspace_id FROM company_trial_grants WHERE card_fingerprint=? AND workspace_id<>? LIMIT 1").get(fingerprint,workspaceId)
  if (repeat) {
    const flagged = await db.prepare("UPDATE company_trial_grants SET fingerprint_flagged_at=?, fingerprint_prior_workspace_id=? WHERE workspace_id=? AND fingerprint_flagged_at IS NULL").run(nowIso(),repeat.workspace_id,workspaceId)
    if (flagged.changes) await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.trial_fingerprint_review",resourceType:"workspace",resourceId:workspaceId,metadata:{subscriptionId:input.subscriptionId},executor:db})
  }
}
