import test,{before,after} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {createWorkspaceWithAdmin} from "../src/lib/mca/workspaces"
import {getDatabase,nowIso,closeDatabaseForTests,recordAuditEvent} from "../src/lib/mca/db"
import {platformCompanies,platformCompany,platformPayments,platformAudit,platformMutation,platformQuerySchema} from "../src/lib/mca/platform-console"
import {initializeCompanyTrial} from "../src/lib/mca/company-access"
let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let workspaceId:string,userId:string
before(async()=>{
  database=await createPostgresTestDatabase("platform_console");process.env.DATABASE_URL=database.databaseUrl
  const company=await createWorkspaceWithAdmin({workspaceName:"Searchable billing company",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Fixture password 99!",role:"admin"})
  workspaceId=company.workspaceId;userId=company.userId
  for(const [id,currency,paid,url] of [["invoice-usd","usd",39900,"https://invoice.stripe.com/i/test"],["invoice-eur","eur",12345,"javascript:alert(1)"]] as const){
    await getDatabase().prepare("INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,invoice_url,created_at,synced_at) VALUES (?,?,'paid',?,?,?,0,?,?,?)").run(id,workspaceId,currency,paid,paid,url,nowIso(),nowIso())
    await getDatabase().prepare("INSERT INTO company_billing_payments(stripe_payment_id,stripe_invoice_id,workspace_id,status,amount_paid,currency,synced_at) VALUES (?,?,?,'paid',?,?,?)").run(`payment-${currency}`,id,workspaceId,paid,currency,nowIso())
  }
  await recordAuditEvent({context:{workspaceId,userId},action:"billing.platform_access_changed",resourceType:"workspace",resourceId:workspaceId,metadata:{reason:"Customer support request",providerSecret:"must-not-leak"}})
})
after(async()=>{await closeDatabaseForTests();await database?.close()})
test("company searches execute on real records and preserve explicit projections",async()=>{
  const rows=await platformCompanies({q:"Searchable",status:"legacy_exempt",offset:0})
  assert.equal(rows.length,1);assert.equal(rows[0].id,workspaceId);assert.equal(rows[0].access.allowed,true)
  assert.equal((await platformCompanies({q:"missing-company",status:"",offset:0})).length,0)
  assert.equal((await platformCompanies({q:"",status:"",offset:0})).length,1)
  assert.equal((await platformCompanies({q:"Searchable",status:"",offset:50})).length,0)
})
test("payments aggregate currencies separately and invoice links are allowlisted",async()=>{
  const data=await platformPayments({q:"Searchable",status:"paid",offset:0})
  assert.equal(data.invoices.length,2);assert.equal(data.payments.length,2)
  assert.deepEqual(data.totals,[{currency:"eur",due:"12345",paid:"12345",remaining:"0",refunded:"0",disputed:"0"},{currency:"usd",due:"39900",paid:"39900",remaining:"0",refunded:"0",disputed:"0"}])
  assert.equal(data.invoices.find(row=>row.currency==="eur")?.invoice_url,null)
  assert.equal(data.invoices.find(row=>row.currency==="usd")?.invoice_url,"https://invoice.stripe.com/i/test")
  const detail=await platformCompany(workspaceId)
  assert.equal(detail.invoices.length,2);assert.equal(detail.payments.length,2)
})
test("audit search returns persisted billing reasons without raw metadata",async()=>{
  const rows=await platformAudit({q:"billing.platform_access_changed",status:"",offset:0})
  assert.equal(rows.length,1);assert.equal(rows[0].reason,"Customer support request")
  assert.equal(JSON.stringify(rows).includes("must-not-leak"),false)
})
test("access filters evaluate trial and manual pause before applying the result limit",async()=>{
  const company=await createWorkspaceWithAdmin({workspaceName:"Trial filter company",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Fixture password 99!",role:"admin"})
  await initializeCompanyTrial(company.workspaceId,12)
  assert.equal((await platformCompanies({q:"Trial filter",status:"access:trial",offset:0}))[0]?.id,company.workspaceId)
  await getDatabase().prepare("UPDATE company_subscription_state SET manual_paused=1 WHERE workspace_id=?").run(company.workspaceId)
  assert.equal((await platformCompanies({q:"Trial filter",status:"access:trial",offset:0})).length,0)
  assert.equal((await platformCompanies({q:"Trial filter",status:"access:paused",offset:0}))[0]?.access.allowed,false)
})
async function fixture(name:string) {return createWorkspaceWithAdmin({workspaceName:name,adminName:"Operator fixture",adminEmail:`${randomUUID()}@example.test`,password:"Fixture password 99!",role:"admin"})}
async function notification(companyId:string,options:{delivered?:boolean;leased?:boolean}={}) {
  const id=`notice-${randomUUID()}`,available=new Date(Date.now()+86400000).toISOString()
  await getDatabase().prepare("INSERT INTO company_billing_notifications(id,workspace_id,kind,data,attempts,available_at,lease_until,delivered_at,last_error,created_at) VALUES (?,?,'renewal_payment_failed',?,3,?,?,?,?,?)").run(id,companyId,JSON.stringify({invoiceId:"invoice-original"}),available,options.leased?available:null,options.delivered?nowIso():null,"Transport failed",nowIso())
  return {id,available}
}
test("notification retry is tenant-scoped, refuses active leases and preserves correlation identity",async()=>{
  const other=await fixture("Other notification company"),notice=await notification(workspaceId)
  await assert.rejects(platformMutation(other.workspaceId,userId,{action:"notification_retry",notificationId:notice.id,reason:"Investigated failure"}),{code:"notification_not_found"})
  assert.equal((await getDatabase().prepare<{available_at:string}>("SELECT available_at FROM company_billing_notifications WHERE id=?").get(notice.id))?.available_at,notice.available)
  const leased=await notification(workspaceId,{leased:true})
  await assert.rejects(platformMutation(workspaceId,userId,{action:"notification_retry",notificationId:leased.id,reason:"Investigated failure"}),{code:"notification_in_flight"})
  await platformMutation(workspaceId,userId,{action:"notification_retry",notificationId:notice.id,reason:"Receiver restored"})
  const row=await getDatabase().prepare<{id:string;attempts:number;available_at:string;delivered_at:string|null}>("SELECT id,attempts,available_at,delivered_at FROM company_billing_notifications WHERE id=?").get(notice.id)
  assert.equal(row?.id,notice.id);assert.equal(row?.attempts,3);assert.equal(row?.delivered_at,null);assert.ok(Date.parse(row!.available_at)<Date.parse(notice.available))
  const audit=await getDatabase().prepare<{metadata:string}>("SELECT metadata FROM audit_events WHERE action='billing.platform_notification_retry' AND resource_id=?").get(notice.id)
  assert.equal(JSON.parse(audit!.metadata).reason,"Receiver restored")
})
test("delivered notice requires explicit resend and queues a new audited identity linked to original",async()=>{
  const notice=await notification(workspaceId,{delivered:true}),db=getDatabase()
  await assert.rejects(platformMutation(workspaceId,userId,{action:"notification_retry",notificationId:notice.id,reason:"Support"}),{code:"notification_already_delivered"})
  const before=await db.prepare("SELECT * FROM company_billing_notifications WHERE id=?").get(notice.id)
  await platformMutation(workspaceId,userId,{action:"notification_resend",notificationId:notice.id,reason:"Owner requested another copy"})
  const queued=await db.prepare<{id:string;data:string;attempts:number;delivered_at:string|null;delivery_payload:string|null}>("SELECT id,data,attempts,delivered_at,delivery_payload FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'originalNotificationId'=?").get(workspaceId,notice.id)
  assert.ok(queued);assert.notEqual(queued.id,notice.id);assert.equal(queued.delivered_at,null);assert.equal(queued.attempts,0);assert.equal(queued.delivery_payload,null)
  assert.deepEqual(JSON.parse(queued.data),{invoiceId:"invoice-original",originalNotificationId:notice.id})
  assert.deepEqual(await db.prepare("SELECT * FROM company_billing_notifications WHERE id=?").get(notice.id),before)
  const audit=await db.prepare<{metadata:string;actor_user_id:string}>("SELECT metadata,actor_user_id FROM audit_events WHERE action='billing.platform_notification_resent' AND resource_id=?").get(queued.id)
  assert.equal(audit?.actor_user_id,userId);assert.deepEqual(JSON.parse(audit!.metadata),{originalNotificationId:notice.id,notificationId:queued.id,reason:"Owner requested another copy"})
  await assert.rejects(platformMutation(workspaceId,userId,{action:"notification_resend",notificationId:queued.id,reason:"Duplicate"}),{code:"notification_not_delivered"})
})
test("initial owner assignment validates company, administrative role and status and never replaces owners",async()=>{
  const company=await fixture("Legacy owner assignment"),other=await fixture("Different owner company"),db=getDatabase()
  const action=(membershipId:string)=>({action:"assign_owner" as const,membershipId,reason:"Verified legacy administrator"})
  await assert.rejects(platformMutation(company.workspaceId,userId,action(other.membershipId)),{code:"active_admin_required"})
  await db.prepare("UPDATE memberships SET role='rep' WHERE id=?").run(company.membershipId)
  await assert.rejects(platformMutation(company.workspaceId,userId,action(company.membershipId)),{code:"active_admin_required"})
  await db.prepare("UPDATE memberships SET role='admin',status='pending' WHERE id=?").run(company.membershipId)
  await assert.rejects(platformMutation(company.workspaceId,userId,action(company.membershipId)),{code:"active_admin_required"})
  await db.prepare("UPDATE memberships SET status='active' WHERE id=?").run(company.membershipId)
  const results=await Promise.allSettled([platformMutation(company.workspaceId,userId,action(company.membershipId)),platformMutation(company.workspaceId,userId,action(company.membershipId))])
  assert.equal(results.filter(result=>result.status==="fulfilled").length,1)
  assert.equal((results.find(result=>result.status==="rejected") as PromiseRejectedResult).reason.code,"owner_already_assigned")
  const detail=await platformCompany(company.workspaceId)
  assert.equal(detail.owner?.membershipId,company.membershipId);assert.deepEqual(detail.ownerCandidates,[])
  assert.equal((await platformCompanies({q:detail.owner!.email,status:"",offset:0}))[0]?.id,company.workspaceId)
  const audits=await db.prepare<{metadata:string}>("SELECT metadata FROM audit_events WHERE workspace_id=? AND action='billing.platform_owner_assigned'").all(company.workspaceId)
  assert.equal(audits.length,1);assert.equal(JSON.parse(audits[0].metadata).reason,"Verified legacy administrator")
})
test("refund/dispute reporting keeps gross, successful refunds and open balances separate by currency and date",async()=>{
  const company=await fixture("Financial reporting dates"),db=getDatabase()
  await db.prepare("INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,paid_at,created_at,synced_at) VALUES (?,?,'paid','usd',10000,10000,0,?,?,?)").run("dated-paid",company.workspaceId,"2025-03-05T00:00:00Z","2025-02-28T00:00:00Z",nowIso())
  await db.prepare("INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at) VALUES (?,?,'open','usd',2000,0,2000,?,?)").run("dated-open",company.workspaceId,"2025-03-10T00:00:00Z",nowIso())
  for(const [id,kind,status,amount,currency,created] of [["refund-good","refund","succeeded",1500,"usd","2025-03-31T23:59:59Z"],["refund-failed","refund","failed",500,"usd","2025-03-12T00:00:00Z"],["dispute-open","dispute","needs_response",10000,"usd","2025-03-12T00:00:00Z"],["refund-eur","refund","succeeded",700,"eur","2025-03-12T00:00:00Z"],["refund-outside","refund","succeeded",100,"usd","2025-04-01T00:00:00Z"]] as const) {
    await db.prepare("INSERT INTO company_billing_adjustments(id,workspace_id,kind,stripe_charge_id,status,amount,currency,livemode,created_at,synced_at) VALUES (?,?,?,'charge',?,?,?,0,?,?)").run(id,company.workspaceId,kind,status,amount,currency,created,nowIso())
  }
  const query=platformQuerySchema.parse({q:"Financial reporting",currency:"USD",from:"2025-03-01",to:"2025-03-31"}),data=await platformPayments(query)
  assert.equal(data.adjustments.length,3);assert.deepEqual(data.totals,[{currency:"usd",due:"2000",paid:"10000",remaining:"2000",refunded:"1500",disputed:"10000"}])
  assert.equal((await platformCompany(company.workspaceId)).adjustments.length,5)
  const all=await platformPayments({...query,currency:""});assert.equal(all.totals.length,2);assert.equal(all.totals.find(row=>row.currency==="eur")?.refunded,"700")
  const scoped=await platformPayments({...query,q:""},workspaceId);assert.equal(scoped.adjustments.length,0);assert.deepEqual(scoped.totals,[])
  assert.equal(platformQuerySchema.safeParse({from:"2025-03-31",to:"2025-03-01"}).success,false)
})
