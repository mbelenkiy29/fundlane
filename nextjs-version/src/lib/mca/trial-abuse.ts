import type Stripe from "stripe"
import { recordAuditEvent, nowIso, type DbExecutor } from "./db"

const freeMailDomains = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "proton.me", "protonmail.com"])
const positiveLimit = (raw: string | undefined, fallback: number | null) => raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : fallback

export const trialAbuseLimitsEnabled = () => process.env.MCA_TRIAL_ABUSE_LIMITS_ENABLED === "true"

async function owner(workspaceId: string, db: DbExecutor) {
  const row = await db.prepare<{user_id:string;email:string}>(`SELECT m.user_id,u.email FROM workspace_owners o
    JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id
    JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?`).get(workspaceId)
  if (!row) return null
  const email = row.email.trim().toLowerCase()
  return {userId:row.user_id,email,domain:email.split("@")[1] ?? ""}
}

export async function trialAllowedForOwner(workspaceId: string, db: DbExecutor) {
  if (!trialAbuseLimitsEnabled()) return true
  const identity = await owner(workspaceId,db)
  if (!identity) return true // Missing owner data must not deny a first trial.
  const perUser = positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_USER,1)!
  const perEmail = positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_EMAIL,1)!
  const perDomain = positiveLimit(process.env.MCA_TRIAL_LIMIT_PER_DOMAIN,null)
  const count = async (column:"owner_user_id"|"owner_email"|"email_domain", value:string) =>
    (await db.prepare<{count:number}>(`SELECT count(*)::int count FROM company_trial_grants WHERE ${column}=? AND workspace_id<>?`).get(value,workspaceId))?.count ?? 0
  if (await count("owner_user_id",identity.userId) >= perUser || await count("owner_email",identity.email) >= perEmail) return false
  if (perDomain && identity.domain && !freeMailDomains.has(identity.domain) && await count("email_domain",identity.domain) >= perDomain) return false
  return true
}

export async function recordTrialGrant(workspaceId:string, subscription:Stripe.Subscription, client:Pick<Stripe,"paymentMethods"|"setupIntents">, db:DbExecutor) {
  if (!trialAbuseLimitsEnabled() || !subscription.trial_start || !subscription.trial_end) return
  const identity = await owner(workspaceId,db)
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
  // Reconciliation runs under a workspace lock; serialize only matching cards
  // so concurrent first grants cannot both miss the review match.
  if (fingerprint) await db.prepare("SELECT pg_advisory_xact_lock(105, hashtext(?))").get(fingerprint)
  const existing = await db.prepare<{card_fingerprint:string|null;fingerprint_flagged_at:string|null}>("SELECT card_fingerprint,fingerprint_flagged_at FROM company_trial_grants WHERE workspace_id=?").get(workspaceId)
  if (!existing) await db.prepare(`INSERT INTO company_trial_grants (workspace_id,stripe_subscription_id,owner_user_id,owner_email,email_domain,card_fingerprint,trial_started_at,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(workspaceId,subscription.id,identity.userId,identity.email,identity.domain,fingerprint,new Date(subscription.trial_start*1000).toISOString(),nowIso())
  else if (fingerprint && !existing.card_fingerprint) await db.prepare("UPDATE company_trial_grants SET card_fingerprint=? WHERE workspace_id=?").run(fingerprint,workspaceId)
  if (!fingerprint || existing?.fingerprint_flagged_at || process.env.MCA_TRIAL_FINGERPRINT_ACTION === "off") return
  const repeat = await db.prepare<{workspace_id:string}>("SELECT workspace_id FROM company_trial_grants WHERE card_fingerprint=? AND workspace_id<>? LIMIT 1").get(fingerprint,workspaceId)
  if (repeat) {
    const flagged = await db.prepare("UPDATE company_trial_grants SET fingerprint_flagged_at=? WHERE workspace_id=? AND fingerprint_flagged_at IS NULL").run(nowIso(),workspaceId)
    if (flagged.changes) await recordAuditEvent({context:{workspaceId,userId:null,source:"system"},action:"billing.trial_fingerprint_review",resourceType:"workspace",resourceId:workspaceId,metadata:{subscriptionId:subscription.id,priorWorkspaceId:repeat.workspace_id},executor:db})
  }
}
