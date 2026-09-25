import "server-only"
import { getDatabase, recordAuditEvent, withImmediateTransaction, nowIso, newId } from "./db"
import { getPlatformCompanyBillingDetail, listPlatformCompanyBilling, setPlatformCompanyAccess } from "./billing-operations"
import { syncWorkspaceBilling } from "./billing"
import { getCompanyAccess } from "./company-access"
import { AppError } from "./errors"
import { z } from "zod"
import { BILLING_CATALOG, monthlyPriceCents } from "./billing-catalog"

export const platformQuerySchema = z.object({ q:z.string().trim().max(200).default(""),status:z.string().max(40).default(""),offset:z.coerce.number().int().min(0).max(1000000).default(0),currency:z.union([z.literal(""),z.string().regex(/^[a-zA-Z]{3}$/)]).transform(value=>value.toLowerCase()).optional(),from:z.union([z.literal(""),z.iso.date()]).optional(),to:z.union([z.literal(""),z.iso.date()]).optional() }).refine(query=>!query.from||!query.to||query.from<=query.to,{message:"Start date must not be after end date.",path:["to"]})
export const platformActionSchema = z.discriminatedUnion("action",[
  z.object({action:z.literal("access"),manualPaused:z.boolean().optional(),accessExtendedUntil:z.iso.datetime().nullable().optional(),reason:z.string().trim().min(1).max(1000)}),
  z.object({action:z.literal("reconcile"),reason:z.string().trim().min(1).max(1000)}),
  z.object({action:z.literal("notification_retry"),notificationId:z.string().min(1).max(300),reason:z.string().trim().min(1).max(1000)}),
  z.object({action:z.literal("notification_resend"),notificationId:z.string().min(1).max(300),reason:z.string().trim().min(1).max(1000)}),
  z.object({action:z.literal("assign_owner"),membershipId:z.string().min(1).max(200),reason:z.string().trim().min(1).max(1000)}),
])
export type PlatformQuery = z.infer<typeof platformQuerySchema>
type CompanyRow = {id:string;name:string;seat_limit:number;selected_seats:number|null;occupied_seats:number;subscription_status:string|null;manual_paused:number|null;trial_ends_at:string|null}
export async function platformCompanies(query:PlatformQuery) {
  // Apply search before the server-side page limit; never search only the visible page.
  let rows:CompanyRow[]
  if(!query.q&&!query.status) rows=await listPlatformCompanyBilling(50,query.offset) as unknown as CompanyRow[]
  else rows=await getDatabase().prepare<CompanyRow>(`SELECT w.id,w.name,w.seat_limit,s.selected_seats,s.manual_paused,s.trial_ends_at,e.status subscription_status,
    (SELECT count(*)::int FROM memberships m WHERE m.workspace_id=w.id AND m.status IN ('active','pending')) occupied_seats
    FROM workspaces w LEFT JOIN company_subscription_state s ON s.workspace_id=w.id LEFT JOIN workspace_billing_entitlements e ON e.workspace_id=w.id
    WHERE (w.name ILIKE ? OR w.id ILIKE ? OR EXISTS (SELECT 1 FROM workspace_owners o JOIN memberships om ON om.id=o.membership_id AND om.workspace_id=o.workspace_id JOIN users ou ON ou.id=om.user_id WHERE o.workspace_id=w.id AND ou.email ILIKE ?)) AND (?='' OR CASE WHEN s.manual_paused=1 THEN 'manual_paused' WHEN s.legacy_exempt=1 OR s.workspace_id IS NULL THEN 'legacy_exempt' ELSE COALESCE(e.status,'no_subscription') END=? OR
      'access:' || CASE WHEN s.manual_paused=1 THEN 'paused'
      WHEN COALESCE(s.legacy_exempt,1)=1 THEN 'legacy_exempt'
      WHEN s.access_extended_until::timestamptz>now() THEN 'extended'
      WHEN e.status='trialing' AND e.period_end::timestamptz>now() THEN 'trialing'
      WHEN s.grace_ends_at IS NOT NULL AND e.status IN ('active','past_due') THEN CASE WHEN GREATEST(s.grace_ends_at::timestamptz,s.processing_extension_until::timestamptz)>now() THEN 'grace' ELSE 'paused' END
      WHEN e.status='active' AND e.period_end::timestamptz>now() THEN 'active'
      WHEN COALESCE(e.status,'none') IN ('none','incomplete','incomplete_expired') AND s.trial_ends_at::timestamptz>now() THEN 'trial'
      ELSE 'paused' END=?)
    ORDER BY w.created_at DESC,w.id LIMIT 50 OFFSET ?`).all(`%${query.q}%`,`%${query.q}%`,`%${query.q}%`,query.status,query.status,query.status,query.offset)
  return Promise.all(rows.map(async row=>({id:row.id,name:row.name,purchasedSeats:row.subscription_status?row.seat_limit:0,selectedSeats:row.selected_seats??row.seat_limit,occupiedSeats:row.occupied_seats,subscriptionStatus:row.subscription_status??"none",access:await getCompanyAccess(row.id)})))
}
export type PlatformCompany = Awaited<ReturnType<typeof platformCompanies>>[number]
export type Invoice = {stripe_invoice_id:string;workspace_id:string;company_name:string;status:string;currency:string;amount_due:string|number;amount_paid:string|number;amount_remaining:string|number;created_at:string;invoice_url:string|null}
export type Payment = {stripe_payment_id:string;stripe_invoice_id:string;workspace_id:string;company_name:string;status:string;currency:string;amount_paid:string|number;synced_at:string}
export type Adjustment = {id:string;workspace_id:string;company_name:string;kind:"refund"|"dispute";status:string;amount:string|number;currency:string;reason:string|null;livemode:number;created_at:string;synced_at:string}
export type CurrencyTotal = {currency:string;due:string;paid:string;remaining:string;refunded:string;disputed:string}
function financialRange(query:PlatformQuery) {
  return {currency:query.currency??"",from:query.from?`${query.from}T00:00:00.000Z`:"0001-01-01T00:00:00.000Z",to:query.to?new Date(Date.parse(`${query.to}T00:00:00.000Z`)+86400000).toISOString():"9999-12-31T23:59:59.999Z"}
}
export async function platformPayments(query:PlatformQuery,companyId="") {
  const pattern=`%${query.q}%`, db=getDatabase(),range=financialRange(query)
  const [invoices,payments,adjustments,totals]=await Promise.all([
    db.prepare<Invoice>(`SELECT i.stripe_invoice_id,i.workspace_id,w.name company_name,i.status,i.currency,i.amount_due,i.amount_paid,i.amount_remaining,i.created_at,i.invoice_url FROM company_billing_invoices i JOIN workspaces w ON w.id=i.workspace_id WHERE (?='' OR i.workspace_id=?) AND (w.name ILIKE ? OR i.stripe_invoice_id ILIKE ?) AND (?='' OR i.status=?) AND (?='' OR i.currency=?) AND i.created_at::timestamptz>=?::timestamptz AND i.created_at::timestamptz<?::timestamptz ORDER BY i.created_at DESC,i.stripe_invoice_id LIMIT 50 OFFSET ?`).all(companyId,companyId,pattern,pattern,query.status,query.status,range.currency,range.currency,range.from,range.to,query.offset),
    db.prepare<Payment>(`SELECT p.stripe_payment_id,p.stripe_invoice_id,p.workspace_id,w.name company_name,p.status,p.currency,p.amount_paid,p.synced_at FROM company_billing_payments p JOIN workspaces w ON w.id=p.workspace_id JOIN company_billing_invoices i ON i.stripe_invoice_id=p.stripe_invoice_id AND i.workspace_id=p.workspace_id WHERE (?='' OR p.workspace_id=?) AND (w.name ILIKE ? OR p.stripe_invoice_id ILIKE ? OR p.stripe_payment_id ILIKE ?) AND (?='' OR p.currency=?) AND COALESCE(i.paid_at,i.created_at)::timestamptz>=?::timestamptz AND COALESCE(i.paid_at,i.created_at)::timestamptz<?::timestamptz ORDER BY p.synced_at DESC,p.stripe_payment_id LIMIT 50 OFFSET ?`).all(companyId,companyId,pattern,pattern,pattern,range.currency,range.currency,range.from,range.to,query.offset),
    db.prepare<Adjustment>(`SELECT a.id,a.workspace_id,w.name company_name,a.kind,a.status,a.amount,a.currency,a.reason,a.livemode,a.created_at,a.synced_at FROM company_billing_adjustments a JOIN workspaces w ON w.id=a.workspace_id WHERE (?='' OR a.workspace_id=?) AND (w.name ILIKE ? OR a.id ILIKE ?) AND (?='' OR a.currency=?) AND a.created_at::timestamptz>=?::timestamptz AND a.created_at::timestamptz<?::timestamptz ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET ?`).all(companyId,companyId,pattern,pattern,range.currency,range.currency,range.from,range.to,query.offset),
    db.prepare<CurrencyTotal>(`WITH amounts AS (
      SELECT currency,amount_due due,0::bigint paid,CASE WHEN status='open' THEN amount_remaining ELSE 0 END remaining,0::bigint refunded,0::bigint disputed FROM company_billing_invoices WHERE (?='' OR workspace_id=?) AND created_at::timestamptz>=?::timestamptz AND created_at::timestamptz<?::timestamptz
      UNION ALL SELECT currency,0,amount_paid,0,0,0 FROM company_billing_invoices WHERE (?='' OR workspace_id=?) AND COALESCE(paid_at,created_at)::timestamptz>=?::timestamptz AND COALESCE(paid_at,created_at)::timestamptz<?::timestamptz
      UNION ALL SELECT currency,0,0,0,CASE WHEN kind='refund' AND status='succeeded' THEN amount ELSE 0 END,CASE WHEN kind='dispute' THEN amount ELSE 0 END FROM company_billing_adjustments WHERE (?='' OR workspace_id=?) AND created_at::timestamptz>=?::timestamptz AND created_at::timestamptz<?::timestamptz)
      SELECT currency,SUM(due)::text due,SUM(paid)::text paid,SUM(remaining)::text remaining,SUM(refunded)::text refunded,SUM(disputed)::text disputed FROM amounts WHERE (?='' OR currency=?) GROUP BY currency ORDER BY currency`).all(companyId,companyId,range.from,range.to,companyId,companyId,range.from,range.to,companyId,companyId,range.from,range.to,range.currency,range.currency),
  ])
  return {invoices:invoices.map(safeInvoice),payments,adjustments,totals}
}
function safeInvoice(row:Invoice):Invoice {
  let url:string|null=null
  try{const parsed=new URL(row.invoice_url??"");if(parsed.protocol==="https:"&&parsed.hostname==="invoice.stripe.com")url=parsed.href}catch{}
  return {...row,invoice_url:url}
}
export async function platformCompany(id:string) {
  const company=await getDatabase().prepare<{id:string;name:string}>("SELECT id,name FROM workspaces WHERE id=?").get(id)
  if(!company)throw new AppError(404,"workspace_not_found","Company not found.")
  const detail=await getPlatformCompanyBillingDetail(id)
  const owner=await getDatabase().prepare<{membershipId:string;name:string;email:string;status:string}>(`SELECT m.id "membershipId",u.name,u.email,m.status FROM workspace_owners o JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=o.workspace_id JOIN users u ON u.id=m.user_id WHERE o.workspace_id=?`).get(id)
  const ownerCandidates=owner?[]:await getDatabase().prepare<{membershipId:string;name:string;email:string}>(`SELECT m.id "membershipId",u.name,u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? AND m.status='active' AND m.role IN ('admin','super_admin') ORDER BY u.name,m.id LIMIT 200`).all(id)
  const subscription=await getDatabase().prepare<{planName:string;planSlug:string;seatLimit:number;status:string}>(`SELECT plan_name "planName",plan_slug "planSlug",seat_limit "seatLimit",status FROM workspace_billing_entitlements WHERE workspace_id=?`).get(id)
  // Explicit projection avoids leaking provider payloads, notification data or transport errors.
  const state=detail.state
  return {company,owner:owner??null,ownerCandidates,subscription:subscription??null,pricing:{version:BILLING_CATALOG.version,selectedMonthlyCents:monthlyPriceCents(Number(state?.selected_seats??1)),purchasedMonthlyCents:subscription?.planSlug==="fundlane"?monthlyPriceCents(subscription.seatLimit):null},access:detail.access,state:state?{selectedSeats:Number(state.selected_seats),pendingSeats:state.pending_seats==null?null:Number(state.pending_seats),pendingSeatsAt:String(state.pending_seats_at??""),accessExtendedUntil:String(state.access_extended_until??"")}:null,
    adjustments:await getDatabase().prepare<Adjustment>(`SELECT a.id,a.workspace_id,w.name company_name,a.kind,a.status,a.amount,a.currency,a.reason,a.livemode,a.created_at,a.synced_at FROM company_billing_adjustments a JOIN workspaces w ON w.id=a.workspace_id WHERE a.workspace_id=? ORDER BY a.created_at DESC,a.id LIMIT 200`).all(id),
    invoices:detail.invoices.map(row=>safeInvoice({stripe_invoice_id:String(row.stripe_invoice_id),workspace_id:id,company_name:company.name,status:String(row.status),currency:String(row.currency),amount_due:String(row.amount_due),amount_paid:String(row.amount_paid),amount_remaining:String(row.amount_remaining),created_at:String(row.created_at),invoice_url:row.invoice_url?String(row.invoice_url):null})),
    payments:detail.payments.map(row=>({stripe_payment_id:String(row.stripe_payment_id),stripe_invoice_id:String(row.stripe_invoice_id),workspace_id:id,company_name:company.name,status:String(row.status),currency:String(row.currency),amount_paid:String(row.amount_paid),synced_at:String(row.synced_at)})),
    notifications:detail.notifications.map(row=>({id:String(row.id),kind:String(row.kind),attempts:Number(row.attempts),availableAt:String(row.available_at),deliveredAt:row.delivered_at?String(row.delivered_at):null,failed:Boolean(row.last_error)}))}
}
export async function platformAudit(query:PlatformQuery) {
  const pattern=`%${query.q}%`
  return getDatabase().prepare<{id:string;workspace_id:string;company_name:string;actor_user_id:string|null;action:string;resource_type:string;resource_id:string;created_at:string;reason:string|null}>(`SELECT a.id,a.workspace_id,w.name company_name,a.actor_user_id,a.action,a.resource_type,a.resource_id,a.created_at,CASE WHEN a.action LIKE 'billing.%' THEN a.metadata::jsonb->>'reason' ELSE NULL END reason FROM audit_events a JOIN workspaces w ON w.id=a.workspace_id
    WHERE (w.name ILIKE ? OR a.action ILIKE ? OR a.resource_id ILIKE ? OR a.actor_user_id ILIKE ?) ORDER BY a.created_at DESC,a.id LIMIT 50 OFFSET ?`).all(pattern,pattern,pattern,pattern,query.offset)
}
export async function platformMutation(id:string,actorUserId:string,input:z.infer<typeof platformActionSchema>) {
  input=platformActionSchema.parse(input)
  if(input.action==="access") {await setPlatformCompanyAccess(id,actorUserId,input);return platformCompany(id)}
  if(input.action==="assign_owner"||input.action==="notification_retry"||input.action==="notification_resend") {
    await withImmediateTransaction(async db=>{
      if(!await db.prepare("SELECT id FROM workspaces WHERE id=? FOR UPDATE").get(id))throw new AppError(404,"workspace_not_found","Company not found.")
      if(input.action==="assign_owner") {
        if(await db.prepare("SELECT membership_id FROM workspace_owners WHERE workspace_id=?").get(id))throw new AppError(409,"owner_already_assigned","This company already has an owner. Use the owner-only transfer process.")
        const member=await db.prepare("SELECT id FROM memberships WHERE workspace_id=? AND id=? AND status='active' AND role IN ('admin','super_admin') FOR UPDATE").get(id,input.membershipId)
        if(!member)throw new AppError(409,"active_admin_required","Choose an active administrator in this company.")
        await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(id,input.membershipId,nowIso())
        await recordAuditEvent({context:{workspaceId:id,userId:actorUserId},action:"billing.platform_owner_assigned",resourceType:"workspace",resourceId:id,metadata:{membershipId:input.membershipId,reason:input.reason},executor:db})
        return
      }
      const notification=await db.prepare<{id:string;kind:string;data:string;delivered_at:string|null;lease_until:string|null}>("SELECT id,kind,data,delivered_at,lease_until FROM company_billing_notifications WHERE workspace_id=? AND id=? FOR UPDATE").get(id,input.notificationId)
      if(!notification)throw new AppError(404,"notification_not_found","Billing notification not found in this company.")
      if(notification.lease_until&&Date.parse(notification.lease_until)>Date.now())throw new AppError(409,"notification_in_flight","This notification is being delivered. Retry after its delivery lease ends.")
      if(input.action==="notification_retry") {
        if(notification.delivered_at)throw new AppError(409,"notification_already_delivered","This notification was delivered. Use explicit resend to queue a new notice.")
        await db.prepare("UPDATE company_billing_notifications SET available_at=?,lease_until=NULL WHERE workspace_id=? AND id=? AND delivered_at IS NULL").run(nowIso(),id,notification.id)
        await recordAuditEvent({context:{workspaceId:id,userId:actorUserId},action:"billing.platform_notification_retry",resourceType:"billing_notification",resourceId:notification.id,metadata:{reason:input.reason},executor:db})
      } else {
        if(!notification.delivered_at)throw new AppError(409,"notification_not_delivered","Use retry for a notice that has not been delivered.")
        const queuedId=`billing:resend:${newId()}`,now=nowIso()
        const data={...JSON.parse(notification.data),originalNotificationId:notification.id}
        await db.prepare("INSERT INTO company_billing_notifications(id,workspace_id,kind,data,available_at,created_at) VALUES (?,?,?,?,?,?)").run(queuedId,id,notification.kind,JSON.stringify(data),now,now)
        await recordAuditEvent({context:{workspaceId:id,userId:actorUserId},action:"billing.platform_notification_resent",resourceType:"billing_notification",resourceId:queuedId,metadata:{originalNotificationId:notification.id,notificationId:queuedId,reason:input.reason},executor:db})
      }
    })
    return platformCompany(id)
  }
  await syncWorkspaceBilling(id)
  await recordAuditEvent({context:{workspaceId:id,userId:actorUserId},action:"billing.platform_reconciled",resourceType:"workspace",resourceId:id,metadata:{reason:input.reason}})
  return platformCompany(id)
}
