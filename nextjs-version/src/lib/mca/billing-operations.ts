import "server-only"
import { getDatabase, newId, nowIso, withImmediateTransaction, recordAuditEvent } from "./db"
import { billingEnabled, missingBillingStateFailsClosed, stripeTrialLifecycleEnabled, syncWorkspaceBilling, type StripeBillingClient } from "./billing"
import { getCompanyAccess, captureCompanyPauseBoundary, recordCompanyPauseBoundary } from "./company-access"
import { enqueueBillingNotification } from "./billing-reconciliation"
import { deliverBillingEmail, renderBillingEmailContent, type BillingEmailMessage } from "./email"
import { AppError } from "./errors"
import { recordOperationalError } from "./operations/telemetry"

/** At-least-once delivery; downstream receiver deduplicates the stable correlation ID. */
export async function deliverBillingNotifications(limit = 50) {
  const claimed = await withImmediateTransaction(async db => {
    const rows = await db.prepare<{ id: string; workspace_id: string; kind: string; data: string; attempts: number; created_at: string; delivery_payload:string|null }>(`SELECT id,workspace_id,kind,data,attempts,created_at,delivery_payload FROM company_billing_notifications
      WHERE delivered_at IS NULL AND available_at<=? AND (lease_until IS NULL OR lease_until<?)
      ORDER BY available_at LIMIT ? FOR UPDATE SKIP LOCKED`).all(nowIso(), nowIso(), limit)
    const lease = new Date(Date.now() + 300000).toISOString()
    for (const row of rows) await db.prepare("UPDATE company_billing_notifications SET lease_until=?,attempts=attempts+1 WHERE id=?").run(lease, row.id)
    return rows.map(row => ({ ...row, lease }))
  })
  let delivered = 0
  for (const row of claimed) {
    try {
      if (process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES === "true" && (row.kind === "payment_action_required" || row.kind === "payment_failed")) {
        const data = JSON.parse(row.data) as { invoiceId?: string; receivedAt?: string }
        const invoice = await getDatabase().prepare<{ status: string; amount_remaining: number; synced_at: string }>("SELECT status,amount_remaining,synced_at FROM company_billing_invoices WHERE workspace_id=? AND stripe_invoice_id=?").get(row.workspace_id,data.invoiceId)
        if (!invoice || Date.parse(invoice.synced_at) < Date.parse(data.receivedAt ?? row.created_at)) {
          await getDatabase().prepare("UPDATE company_billing_notifications SET lease_until=NULL,available_at=? WHERE id=? AND lease_until=?").run(new Date(Date.now()+60000).toISOString(),row.id,row.lease)
          continue
        }
        if (invoice.status !== "open" || Number(invoice.amount_remaining) <= 0) {
          await getDatabase().prepare("UPDATE company_billing_notifications SET delivered_at=?,lease_until=NULL,last_error=NULL WHERE id=? AND lease_until=?").run(nowIso(),row.id,row.lease)
          continue
        }
      }
      let payload:BillingEmailMessage
      if (row.delivery_payload) payload=JSON.parse(row.delivery_payload)
      else {
        const owner = await getDatabase().prepare<{ email: string }>(`SELECT u.email FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=? AND m.status='active'`).get(row.workspace_id)
        if (!owner) throw new Error("Company owner must be assigned before billing notifications can be delivered")
        const origin = process.env.MCA_APP_ORIGIN
        if (!origin) throw new Error("MCA_APP_ORIGIN is required")
        if (!process.env.MCA_EMAIL_WEBHOOK_URL && !(process.env.MCA_USESEND_API_KEY?.trim() && process.env.MCA_USESEND_FROM?.trim())) throw new Error("Configure the billing email webhook or UseSend API key and From address")
        const data = JSON.parse(row.data)
        const portal = row.kind === "payment_failed" || row.kind === "trial_paused" || (row.kind === "trial_ending" && data.stripeTrial === true)
        payload={recipient:owner.email,actionUrl:`${new URL(origin).origin}/settings/billing${portal?"?billingAction=portal":""}`,expiresAt:new Date(Date.parse(row.created_at)+30*86400000).toISOString(),data:{...data,kind:row.kind,workspaceId:row.workspace_id},transport:process.env.MCA_EMAIL_WEBHOOK_URL?"webhook":"usesend",...(process.env.MCA_EMAIL_WEBHOOK_URL?{}:{from:process.env.MCA_USESEND_FROM!.trim(),retryUntil:new Date(Date.now()+23*3600000).toISOString()})}
        payload.content=renderBillingEmailContent(payload)
        const frozen = await getDatabase().prepare("UPDATE company_billing_notifications SET delivery_payload=? WHERE id=? AND lease_until=?").run(JSON.stringify(payload),row.id,row.lease)
        if (!frozen.changes) continue
      }
      await deliverBillingEmail(payload,row.id)
      await getDatabase().prepare("UPDATE company_billing_notifications SET delivered_at=?,lease_until=NULL,last_error=NULL WHERE id=? AND lease_until=?").run(nowIso(), row.id, row.lease)
      delivered++
    } catch (error) {
      await getDatabase().prepare("UPDATE company_billing_notifications SET lease_until=NULL,available_at=?,last_error=? WHERE id=? AND lease_until=?").run(new Date(Date.now() + Math.min(86400000, 60000 * 2 ** Math.min(row.attempts, 10))).toISOString(), error instanceof Error ? error.message.slice(0, 500) : "Delivery failed", row.id, row.lease)
    }
  }
  return { claimed: claimed.length, delivered }
}

async function reconcileQueuedBillingEvents(client?: StripeBillingClient) {
  const now=nowIso(),leaseToken=newId()
  const claimed=await getDatabase().prepare<{id:string;workspace_id:string;attempts:number}>(`WITH due AS (
    SELECT id FROM mca_background_jobs WHERE kind='billing_reconcile' AND
      ((state='queued' AND available_at<=?) OR (state='running' AND lease_expires_at<?))
    ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 100
  ) UPDATE mca_background_jobs j SET state='running',attempts=j.attempts+1,lease_token=?,lease_expires_at=?,updated_at=?
    FROM due WHERE j.id=due.id RETURNING j.id,j.workspace_id,j.attempts`).all(now,now,leaseToken,new Date(Date.now()+600000).toISOString(),now)
  const byWorkspace=new Map<string,typeof claimed>()
  for(const job of claimed) byWorkspace.set(job.workspace_id,[...(byWorkspace.get(job.workspace_id)??[]),job])
  const errors:Array<{workspaceId:string;error:string}>=[]
  for(const [workspaceId,jobs] of byWorkspace) {
    try {
      await syncWorkspaceBilling(workspaceId,client)
      for(const job of jobs) await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete',lease_token=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=?").run(nowIso(),job.id,leaseToken)
    } catch(error) {
      const message=error instanceof Error?error.message:"Reconciliation failed"
      errors.push({workspaceId,error:message})
      await recordOperationalError("billing","reconciliation_failed")
      for(const job of jobs) await getDatabase().prepare("UPDATE mca_background_jobs SET state='queued',available_at=?,lease_token=NULL,lease_expires_at=NULL,error_code='billing_reconciliation_failed',updated_at=? WHERE id=? AND state='running' AND lease_token=?")
        .run(new Date(Date.now()+Math.min(86400000,60000*2**Math.min(job.attempts,10))).toISOString(),nowIso(),job.id,leaseToken)
    }
  }
  return {claimed:claimed.length,reconciled:byWorkspace.size-errors.length,errors,workspaces:new Set(byWorkspace.keys())}
}

export async function runBillingMaintenance(client?: StripeBillingClient) {
  const queued=await reconcileQueuedBillingEvents(client)
  const companies = await getDatabase().prepare<{ workspace_id: string; trial_ends_at: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null }>(`SELECT w.id workspace_id,s.trial_ends_at,c.stripe_customer_id,e.stripe_subscription_id FROM workspaces w
    LEFT JOIN company_subscription_state s ON s.workspace_id=w.id
    LEFT JOIN workspace_stripe_customers c ON c.workspace_id=w.id
    LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=w.id
    WHERE s.workspace_id IS NOT NULL OR c.workspace_id IS NOT NULL ORDER BY s.updated_at NULLS FIRST,w.id LIMIT 100`).all()
  const errors: Array<{ workspaceId: string; error: string }> = [...queued.errors]
  let reconciled = queued.reconciled
  for (const company of companies) {
    try {
      if (company.stripe_customer_id && billingEnabled() && !queued.workspaces.has(company.workspace_id)) {
        if (!missingBillingStateFailsClosed()) await getDatabase().prepare("INSERT INTO company_subscription_state (workspace_id,legacy_exempt,selected_seats,updated_at) SELECT id,1,seat_limit,? FROM workspaces WHERE id=? ON CONFLICT(workspace_id) DO NOTHING").run(nowIso(),company.workspace_id)
        else if (!await getDatabase().prepare("SELECT workspace_id FROM company_subscription_state WHERE workspace_id=?").get(company.workspace_id)) throw new AppError(409,"billing_state_missing","Resolve the missing billing state in the Platform console before reconciliation.")
        await syncWorkspaceBilling(company.workspace_id, client); reconciled++
      }
      const access = await getCompanyAccess(company.workspace_id)
      if (!access.allowed) await withImmediateTransaction(async db=>{
        await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(company.workspace_id)
        await captureCompanyPauseBoundary(company.workspace_id,db)
      })
      if (company.trial_ends_at && localTrialNoticeEligible(company.stripe_subscription_id) && access.reason === "trial_expired") {
        await enqueueBillingNotification(getDatabase(), company.workspace_id, `billing:${company.workspace_id}:trial-ended`, "trial_ended", { trialEndsAt: company.trial_ends_at })
      }
      if (company.trial_ends_at && localTrialNoticeEligible(company.stripe_subscription_id) && access.status === "trial" && Date.parse(company.trial_ends_at) - Date.now() <= 3 * 86400000) await enqueueBillingNotification(getDatabase(), company.workspace_id, `billing:${company.workspace_id}:trial-ending`, "trial_ending", { trialEndsAt: company.trial_ends_at })
    } catch (error) { errors.push({ workspaceId: company.workspace_id, error: error instanceof Error ? error.message : "Reconciliation failed" });await recordOperationalError("billing","reconciliation_failed") }
    // Fair rotation even for a provider failure; the next cron revisits after others.
    await getDatabase().prepare("UPDATE company_subscription_state SET updated_at=? WHERE workspace_id=?").run(nowIso(), company.workspace_id)
  }
  return { scanned: companies.length, jobsClaimed:queued.claimed, reconciled, errors, notifications: await deliverBillingNotifications() }
}

export function localTrialNoticeEligible(stripeSubscriptionId: string | null) {
  return !stripeTrialLifecycleEnabled() || !stripeSubscriptionId
}

/** Call only behind requirePlatformAdmin; does not infer platform authority from company role. */
export async function listPlatformCompanyBilling(limit = 100, offset = 0) {
  return getDatabase().prepare(`SELECT w.id,w.name,w.seat_limit,s.*,e.status AS subscription_status,e.stripe_subscription_id,e.period_end,c.livemode AS stripe_livemode,
    (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status IN ('active','pending')) occupied_seats
    FROM workspaces w LEFT JOIN company_subscription_state s ON s.workspace_id=w.id LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=w.id LEFT JOIN workspace_stripe_customers c ON c.workspace_id=w.id
    ORDER BY w.created_at DESC,w.id LIMIT ? OFFSET ?`).all(Math.min(Math.max(limit,1),200), Math.max(offset,0))
}
export async function getPlatformCompanyBillingDetail(workspaceId: string) {
  return { access: await getCompanyAccess(workspaceId),
    customer: await getDatabase().prepare("SELECT stripe_customer_id,livemode FROM workspace_stripe_customers WHERE workspace_id=?").get(workspaceId),
    state: await getDatabase().prepare("SELECT * FROM company_subscription_state WHERE workspace_id=?").get(workspaceId),
    invoices: await getDatabase().prepare("SELECT * FROM company_billing_invoices WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200").all(workspaceId),
    payments: await getDatabase().prepare("SELECT * FROM company_billing_payments WHERE workspace_id=? ORDER BY synced_at DESC LIMIT 200").all(workspaceId),
    adjustments: await getDatabase().prepare("SELECT * FROM company_billing_adjustments WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200").all(workspaceId),
    notifications: await getDatabase().prepare("SELECT id,kind,attempts,available_at,delivered_at,last_error FROM company_billing_notifications WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(workspaceId) }
}
export async function setPlatformCompanyAccess(workspaceId: string, actorUserId: string, input: { manualPaused?: boolean; accessExtendedUntil?: string | null; reason: string }) {
  if (!input.reason.trim()) throw new AppError(422, "reason_required", "An audit reason is required.")
  if (input.accessExtendedUntil && (!Number.isFinite(Date.parse(input.accessExtendedUntil)) || Date.parse(input.accessExtendedUntil) <= Date.now())) throw new AppError(422, "extension_invalid", "Extension must be a future timestamp.")
  return withImmediateTransaction(async db => {
    const workspace = await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(workspaceId)
    if (!workspace) throw new AppError(404,"workspace_not_found","Company not found.")
    if (!missingBillingStateFailsClosed()) await db.prepare("INSERT INTO company_subscription_state (workspace_id,legacy_exempt,selected_seats,updated_at) SELECT id,1,seat_limit,? FROM workspaces WHERE id=? ON CONFLICT(workspace_id) DO NOTHING").run(nowIso(),workspaceId)
    else if (!await db.prepare("SELECT workspace_id FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)) throw new AppError(409,"billing_state_missing","Resolve the missing billing state before editing access.")
    await captureCompanyPauseBoundary(workspaceId,db)
    if (input.manualPaused === true) {
      const old = await db.prepare<{manual_paused:number}>("SELECT manual_paused FROM company_subscription_state WHERE workspace_id=?").get(workspaceId)
      if (!old?.manual_paused) await recordCompanyPauseBoundary(workspaceId,nowIso(),db)
    }
    if (input.manualPaused !== undefined) await db.prepare("UPDATE company_subscription_state SET manual_paused=?,manual_reason=?,updated_at=? WHERE workspace_id=?").run(input.manualPaused ? 1 : 0,input.reason,nowIso(),workspaceId)
    if (input.accessExtendedUntil !== undefined) await db.prepare("UPDATE company_subscription_state SET access_extended_until=?,updated_at=? WHERE workspace_id=?").run(input.accessExtendedUntil ? new Date(input.accessExtendedUntil).toISOString() : null,nowIso(),workspaceId)
    await recordAuditEvent({ context: { workspaceId,userId:actorUserId },action:"billing.platform_access_changed",resourceType:"workspace",resourceId:workspaceId,metadata:input,executor:db })
    return getCompanyAccess(workspaceId)
  })
}
