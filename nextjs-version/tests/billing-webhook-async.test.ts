import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { resolve } from "node:path"
import type Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, closeDatabaseForTests, nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { BILLING_WEBHOOK_EVENTS, processStripeBillingEvent, runImmediateBillingReconcile, type StripeBillingClient } from "../src/lib/mca/billing"
import { deliverBillingNotifications, runBillingMaintenance } from "../src/lib/mca/billing-operations"
import { getCompanyBillingPresentation } from "../src/lib/mca/billing-presentation"
import { claimBackgroundJob } from "../src/lib/mca/jobs/queue"
import { queueMetrics, runMonitor } from "../src/lib/mca/operations/monitor"

async function runCheckedInMonitorBundle(
  query: (sql: string, values?: unknown[]) => Promise<Record<string, unknown>[]>,
  fetcher: typeof fetch,
  recoveryAlerts = false,
  billingAlerts = false
) {
  const bundle = readFileSync(resolve("supabase/functions/platform-monitor/index.js"), "utf8")
  const executable = bundle.replace(
    /^import postgres from "npm:postgres@3\.4\.7";?$/m,
    "const postgres = globalThis.__postgres;"
  )
  assert.notEqual(executable, bundle, "bundle must have the expected Edge postgres import")
  let handler: ((request: Request) => Promise<Response>) | undefined
  const env: Record<string, string> = {
    MCA_MONITOR_TOKEN: "x".repeat(40),
    MCA_MONITOR_DATABASE_URL: "postgresql://mca_app.test:unused@localhost:6543/postgres",
    MCA_APP_ORIGIN: "https://fundlane.io",
    MCA_OPERATIONS_ALERTS_ENABLED: "true",
    MCA_OPERATIONS_ALERT_EMAIL: "owner@example.test",
    MCA_EMAIL_WEBHOOK_URL: "https://mail.example.test",
  }
  if (recoveryAlerts) env.MCA_OPERATIONS_RECOVERY_ALERTS_ENABLED = "true"
  if (billingAlerts) env.MCA_BILLING_RECONCILIATION_ALERTS_ENABLED = "true"
  runInNewContext(executable, {
    Deno: { env: { get: (name: string) => env[name] }, serve: (fn: typeof handler) => { handler = fn } },
    __postgres: () => ({ unsafe: query, end: async () => undefined }),
    fetch: fetcher,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    AbortSignal,
    URL,
    Response,
    console,
  })
  assert.ok(handler)
  const response = await handler(new Request("https://edge.example.test", {
    method: "POST",
    headers: { authorization: `Bearer ${env.MCA_MONITOR_TOKEN}` },
  }))
  assert.equal(response.status, 200)
}

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const keys = ["DATABASE_URL","MCA_STRIPE_BILLING_ENABLED","MCA_BILLING_VERIFIED_INVOICE_NOTICES","MCA_STRIPE_MODE","STRIPE_BASE_PRICE_ID","STRIPE_ADDITIONAL_SEAT_PRICE_ID","MCA_APP_ORIGIN","MCA_EMAIL_WEBHOOK_URL"]
const saved = Object.fromEntries(keys.map(key=>[key,process.env[key]]))
before(async()=>{
  database=await createPostgresTestDatabase("billing_webhook")
  Object.assign(process.env,{DATABASE_URL:database.databaseUrl,MCA_STRIPE_BILLING_ENABLED:"true",MCA_STRIPE_MODE:"test",STRIPE_BASE_PRICE_ID:"price_base",STRIPE_ADDITIONAL_SEAT_PRICE_ID:"price_seats",MCA_APP_ORIGIN:"http://localhost:3000"})
})
after(async()=>{
  for(const key of keys) if(saved[key]===undefined) delete process.env[key]; else process.env[key]=saved[key]
  await closeDatabaseForTests();await database?.close()
})

test("invoice notices use the existing outbox once per invoice and replayed receipts do no provider work",async()=>{
  const owner=await createWorkspaceWithAdmin({workspaceName:"Webhook test",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Unused fixture password 99!",role:"admin"})
  const customer=`cus_${randomUUID()}`
  await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)").run(owner.workspaceId,customer,nowIso())
  await getDatabase().prepare("INSERT INTO workspace_owners (workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(owner.workspaceId,owner.membershipId,nowIso())
  const sent:Array<{key:string;body:Record<string,unknown>}>=[]
  const server=createServer((request,response)=>{
    const chunks:Buffer[]=[]
    request.on("data",chunk=>chunks.push(chunk))
    request.on("end",()=>{sent.push({key:String(request.headers["idempotency-key"]),body:JSON.parse(Buffer.concat(chunks).toString())});response.writeHead(200);response.end()})
  })
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
  const address=server.address();assert.ok(address&&typeof address!=="string")
  process.env.MCA_EMAIL_WEBHOOK_URL=`http://127.0.0.1:${address.port}`
  try {
    for(const kind of ["invoice.payment_action_required","invoice.payment_failed"]){
      const id=`in_${randomUUID()}`,event={id:`evt_${randomUUID()}`,type:kind,livemode:false,data:{object:{id,customer,hosted_invoice_url:`https://invoice.stripe.com/i/${id}`}}} as Stripe.Event
      assert.equal("queued" in await processStripeBillingEvent(event),true)
      assert.deepEqual(await processStripeBillingEvent(event),{duplicate:true})
      assert.equal("queued" in await processStripeBillingEvent({...event,id:`evt_${randomUUID()}`}),true)
      assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'invoiceId'=?").get(owner.workspaceId,id))?.n,1)
      if(kind==="invoice.payment_action_required") assert.equal((await getCompanyBillingPresentation(owner.workspaceId)).actionRequiredInvoice?.url,`https://invoice.stripe.com/i/${id}`)
    }
    assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM stripe_billing_events WHERE workspace_id=?").get(owner.workspaceId))?.n,4)
    assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM mca_background_jobs WHERE workspace_id=? AND kind='billing_reconcile' AND state='queued'").get(owner.workspaceId))?.n,4)
    assert.equal(await claimBackgroundJob(),undefined)
    assert.equal((await deliverBillingNotifications()).delivered,2)
    assert.equal((await deliverBillingNotifications()).delivered,0)
    assert.equal(sent.length,2)
    const action=sent.find(value=>JSON.stringify(value.body).includes("payment_action_required"))
    const failed=sent.find(value=>JSON.stringify(value.body).includes('"payment_failed"'))
    assert.ok(action);assert.ok(failed)
    assert.match(JSON.stringify(action.body),/https:\/\/invoice\.stripe\.com\/i\//)
    assert.match(JSON.stringify(failed.body),/Payment settings & invoices/)
    assert.match(JSON.stringify(failed.body),/http:\/\/localhost:3000\/settings\/billing\?billingAction=portal/)
    assert.notEqual(action.key,failed.key)
  } finally {delete process.env.MCA_EMAIL_WEBHOOK_URL;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})

test("maintenance retries a failed reconciliation after the webhook has already returned",async()=>{
  const row=await getDatabase().prepare<{workspace_id:string;stripe_customer_id:string}>("SELECT workspace_id,stripe_customer_id FROM workspace_stripe_customers LIMIT 1").get()
  assert.ok(row)
  let calls=0
  const period={current_period_start:Math.floor(Date.now()/1000)-1000,current_period_end:Math.floor(Date.now()/1000)+2591000}
  const sub={id:"sub_retry",customer:row.stripe_customer_id,status:"active",livemode:false,items:{data:[{id:"si_base",quantity:1,price:{id:"price_base"},...period}]}}
  const client={
    subscriptions:{list:async()=>{calls++;if(calls===1) throw new Error("temporary Stripe outage");return {data:[sub],has_more:false}}},
    prices:{retrieve:async(id:string)=>({id,active:true,livemode:false,currency:"usd",unit_amount:id==="price_base"?39900:null,billing_scheme:id==="price_base"?"per_unit":"tiered",tiers_mode:"graduated",tiers:[{up_to:9,unit_amount:7900},{up_to:19,unit_amount:6900},{up_to:null,unit_amount:5900}],recurring:{interval:"month",interval_count:1,usage_type:"licensed"}})},
    invoices:{list:async()=>({data:[],has_more:false})},invoicePayments:{list:async()=>({data:[],has_more:false})},charges:{list:async()=>({data:[],has_more:false})},refunds:{list:async()=>({data:[],has_more:false})},disputes:{list:async()=>({data:[],has_more:false})},
  } as unknown as StripeBillingClient
  const first=await runBillingMaintenance(client)
  assert.equal(first.errors.length,1)
  assert.equal(first.jobsClaimed,4)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM mca_background_jobs WHERE workspace_id=? AND kind='billing_reconcile' AND state='queued' AND attempts=1 AND available_at>?").get(row.workspace_id,nowIso()))?.n,4)
  await getDatabase().prepare("UPDATE mca_background_jobs SET available_at=? WHERE workspace_id=? AND kind='billing_reconcile'").run("2000-01-01T00:00:00.000Z",row.workspace_id)
  const second=await runBillingMaintenance(client)
  assert.deepEqual(second.errors,[])
  assert.equal(second.jobsClaimed,4)
  assert.equal(second.reconciled,1)
  assert.equal(calls,2)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM mca_background_jobs WHERE workspace_id=? AND kind='billing_reconcile' AND state='complete' AND attempts=2").get(row.workspace_id))?.n,4)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM stripe_billing_events WHERE workspace_id=?").get(row.workspace_id))?.n,4)
})

async function queuedBillingEvent() {
  const owner=await createWorkspaceWithAdmin({workspaceName:"Immediate billing",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Unused fixture password 99!",role:"admin"})
  const customer=`cus_${randomUUID()}`
  await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)").run(owner.workspaceId,customer,nowIso())
  const event={id:`evt_${randomUUID()}`,type:"customer.subscription.updated",livemode:false,data:{object:{id:`sub_${randomUUID()}`,customer}}} as Stripe.Event
  const result=await processStripeBillingEvent(event)
  assert.ok("queued" in result && result.queued)
  return { event, result, workspaceId:owner.workspaceId }
}

function emptyBillingClient(list:()=>Promise<{data:unknown[];has_more:boolean}>) {
  return {
    subscriptions:{list},
    prices:{retrieve:async(id:string)=>({id,active:true,livemode:false,currency:"usd",unit_amount:id==="price_base"?39900:null,billing_scheme:id==="price_base"?"per_unit":"tiered",tiers_mode:"graduated",tiers:[{up_to:9,unit_amount:7900},{up_to:19,unit_amount:6900},{up_to:null,unit_amount:5900}],recurring:{interval:"month",interval_count:1,usage_type:"licensed"}})},
    invoices:{list:async()=>({data:[],has_more:false})},
    charges:{list:async()=>({data:[],has_more:false})},
    refunds:{list:async()=>({data:[],has_more:false})},
    disputes:{list:async()=>({data:[],has_more:false})},
  } as unknown as StripeBillingClient
}

async function jobState(jobId:string) {
  return getDatabase().prepare<{state:string}>("SELECT state FROM mca_background_jobs WHERE id=?").get(jobId)
}

test("immediate reconciliation updates entitlement and completes its queued job",async()=>{
  const {result,workspaceId}=await queuedBillingEvent()
  let calls=0
  await runImmediateBillingReconcile(result.workspaceId,result.jobId,{client:emptyBillingClient(async()=>{calls++;return {data:[],has_more:false}})})
  assert.equal(calls,1)
  assert.equal((await getDatabase().prepare<{status:string;source:string}>("SELECT status,source FROM workspace_billing_entitlements WHERE workspace_id=?").get(workspaceId))?.status,"none")
  assert.equal((await getDatabase().prepare<{source:string}>("SELECT source FROM workspace_billing_entitlements WHERE workspace_id=?").get(workspaceId))?.source,"stripe_api")
  assert.equal((await jobState(result.jobId))?.state,"complete")
})

test("immediate reconciliation failure records an operational error and leaves cron job queued",async()=>{
  const {result}=await queuedBillingEvent()
  const logs:string[]=[]
  const original=console.error
  console.error=(...args:unknown[])=>{logs.push(args.join(" "))}
  try {
    await assert.doesNotReject(runImmediateBillingReconcile(result.workspaceId,result.jobId,{client:emptyBillingClient(async()=>{throw new Error("synthetic Stripe failure")})}))
  } finally {console.error=original}
  assert.equal((await jobState(result.jobId))?.state,"queued")
  assert.ok(logs.some(line=>line.includes('"code":"immediate_reconciliation_failed"')))
  assert.ok(logs.every(line=>!line.includes("synthetic Stripe failure")))
})

test("immediate reconciliation timeout returns promptly and retains the cron job",async()=>{
  const {result}=await queuedBillingEvent()
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  const started=Date.now()
  await runImmediateBillingReconcile(result.workspaceId,result.jobId,{timeoutMs:25,client:emptyBillingClient(async()=>{await gate;return {data:[],has_more:false}})})
  assert.ok(Date.now()-started<1000)
  assert.equal((await jobState(result.jobId))?.state,"queued")
  release()
})

test("duplicate billing event has no new job or immediate reconciliation to schedule",async()=>{
  const {event,result,workspaceId}=await queuedBillingEvent()
  assert.deepEqual(await processStripeBillingEvent(event),{duplicate:true})
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM mca_background_jobs WHERE workspace_id=? AND kind='billing_reconcile'").get(workspaceId))?.n,1)
  assert.equal((await jobState(result.jobId))?.state,"queued")
})

test("immediate success leaves a job already claimed by cron running",async()=>{
  const {result}=await queuedBillingEvent()
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='running',lease_token=? WHERE id=?").run("cron-lease",result.jobId)
  await runImmediateBillingReconcile(result.workspaceId,result.jobId,{client:emptyBillingClient(async()=>({data:[],has_more:false}))})
  assert.equal((await getDatabase().prepare<{status:string}>("SELECT status FROM workspace_billing_entitlements WHERE workspace_id=?").get(result.workspaceId))?.status,"none")
  const job=await getDatabase().prepare<{state:string;lease_token:string}>("SELECT state,lease_token FROM mca_background_jobs WHERE id=?").get(result.jobId)
  assert.deepEqual(job,{state:"running",lease_token:"cron-lease"})
})

test("accepted webhook types match the documented live set exactly",async()=>{
  const required=["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired","customer.subscription.created","customer.subscription.updated","customer.subscription.deleted","customer.subscription.paused","customer.subscription.resumed","customer.subscription.trial_will_end","invoice.paid","invoice.payment_failed","invoice.payment_action_required","invoice.finalized","invoice.upcoming","charge.refunded","charge.dispute.created","charge.dispute.updated","charge.dispute.closed","charge.dispute.funds_withdrawn","charge.dispute.funds_reinstated","refund.created","refund.updated","refund.failed"]
  assert.deepEqual([...BILLING_WEBHOOK_EVENTS].sort(),required.sort())
  const row=await getDatabase().prepare<{workspace_id:string;stripe_customer_id:string}>("SELECT workspace_id,stripe_customer_id FROM workspace_stripe_customers LIMIT 1").get()
  assert.ok(row)
  for(const type of required){
    const event={id:`evt_${randomUUID()}`,type,livemode:false,data:{object:{id:`obj_${randomUUID()}`,customer:row.stripe_customer_id}}} as Stripe.Event
    assert.equal("queued" in await processStripeBillingEvent(event),true,type)
    assert.deepEqual(await processStripeBillingEvent(event),{duplicate:true},type)
  }
  assert.deepEqual(await processStripeBillingEvent({id:`evt_${randomUUID()}`,type:"invoice.created",livemode:false,data:{object:{customer:row.stripe_customer_id}}} as Stripe.Event),{ignored:true})
})

test("replayed refund receipts avoid another charge lookup",async()=>{
  const row=await getDatabase().prepare<{stripe_customer_id:string}>("SELECT stripe_customer_id FROM workspace_stripe_customers LIMIT 1").get()
  assert.ok(row)
  let lookups=0
  const client={charges:{retrieve:async()=>{lookups++;return {customer:row.stripe_customer_id,livemode:false}}}} as unknown as StripeBillingClient
  const event={id:`evt_${randomUUID()}`,type:"refund.created",livemode:false,data:{object:{id:`re_${randomUUID()}`,charge:"ch_test"}}} as Stripe.Event
  assert.equal("queued" in await processStripeBillingEvent(event,client),true)
  assert.deepEqual(await processStripeBillingEvent(event,client),{duplicate:true})
  assert.equal(lookups,1)
})

test("a retrying reconciliation opens a platform incident only when opted in",async()=>{
  const row=await getDatabase().prepare<{id:string}>("SELECT id FROM mca_background_jobs WHERE kind='billing_reconcile' LIMIT 1").get()
  assert.ok(row)
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='queued',attempts=1,available_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),row.id)
  const monitorDb={query:async(sql:string,values?:unknown[])=>(await database.query(sql,values)).rows as Record<string,unknown>[]}
  try {
    assert.ok((await queueMetrics(monitorDb)).billingRetrying>0)
    await runMonitor(monitorDb,{origin:"https://fundlane.io",token:"test",alerts:false},async()=>Response.json({databaseOk:true,databaseMs:1}))
    assert.equal((await database.query("SELECT count(*)::int n FROM mca_private.ops_incidents WHERE component='billing_reconciliation' AND opened_at IS NOT NULL")).rows[0].n,0)
    await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute'")
    await runMonitor(monitorDb,{origin:"https://fundlane.io",token:"test",alerts:false,billingReconciliationAlertsEnabled:true},async()=>Response.json({databaseOk:true,databaseMs:1}))
    assert.equal((await database.query("SELECT count(*)::int n FROM mca_private.ops_incidents WHERE component='billing_reconciliation' AND opened_at IS NOT NULL")).rows[0].n,1)
  } finally {await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete' WHERE id=?").run(row.id)}
})

test("checked-in Edge monitor keeps billing reconciliation default off and sends only after opt-in",async()=>{
  const row=await getDatabase().prepare<{id:string}>("SELECT id FROM mca_background_jobs WHERE kind='billing_reconcile' LIMIT 1").get()
  assert.ok(row)
  await getDatabase().prepare("UPDATE mca_background_jobs SET state='queued',attempts=1,available_at=? WHERE id=?").run(new Date(Date.now()+60000).toISOString(),row.id)
  const monitorDb={query:async(sql:string,values?:unknown[])=>(await database.query(sql,values)).rows as Record<string,unknown>[]}
  try {
    await database.query("UPDATE mca_private.ops_control SET document_worker_heartbeat_at=now(),last_started_at=now()-interval '1 minute'")
    await database.query("TRUNCATE mca_private.ops_incidents,mca_private.ops_alert_attempts")
    let sends=0
    const fetcher:typeof fetch=async(url)=>{
      if(String(url).includes('/api/internal/health'))return Response.json({databaseOk:true,databaseMs:1})
      sends++
      return new Response(null,{status:200})
    }
    await runCheckedInMonitorBundle(monitorDb.query,fetcher)
    assert.equal(sends,0)
    assert.equal((await database.query("SELECT count(*)::int n FROM mca_private.ops_incidents WHERE component='billing_reconciliation' AND opened_at IS NOT NULL")).rows[0].n,0)
    await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute'")
    await runCheckedInMonitorBundle(monitorDb.query,fetcher,false,true)
    assert.equal(sends,1)
    assert.equal((await database.query("SELECT count(*)::int n FROM mca_private.ops_alert_attempts WHERE component='billing_reconciliation' AND state='accepted'")).rows[0].n,1)
    await database.query("UPDATE mca_private.ops_control SET last_started_at=now()-interval '1 minute'")
    await runCheckedInMonitorBundle(monitorDb.query,fetcher,true,true)
    assert.equal(sends,1)
  } finally {await getDatabase().prepare("UPDATE mca_background_jobs SET state='complete' WHERE id=?").run(row.id)}
})

test("verified invoice notices wait for refresh and suppress settled out-of-order events",async()=>{
  process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES="true"
  const row=await getDatabase().prepare<{workspace_id:string;stripe_customer_id:string}>("SELECT workspace_id,stripe_customer_id FROM workspace_stripe_customers LIMIT 1").get()
  assert.ok(row)
  const paidId=`in_${randomUUID()}`
  const failedId=`in_${randomUUID()}`
  try {
    for(const [id,type] of [[paidId,"invoice.payment_action_required"],[failedId,"invoice.payment_failed"]]) {
      await processStripeBillingEvent({id:`evt_${randomUUID()}`,type,livemode:false,data:{object:{id,customer:row.stripe_customer_id,hosted_invoice_url:`https://invoice.stripe.com/i/${id}`}}} as Stripe.Event)
    }
    const pending=await deliverBillingNotifications()
    assert.equal(pending.delivered,0)
    assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'invoiceId' IN (?,?) AND delivered_at IS NULL").get(row.workspace_id,paidId,failedId))?.n,2)
    const insert="INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at) VALUES(?,? ,?,'usd',1000,?,?,?,?)"
    await getDatabase().prepare(insert).run(paidId,row.workspace_id,"paid",1000,0,nowIso(),"2100-01-01T00:00:00.000Z")
    await getDatabase().prepare(insert).run(failedId,row.workspace_id,"open",0,1000,nowIso(),"2100-01-01T00:00:00.000Z")
    await getDatabase().prepare("UPDATE company_billing_notifications SET available_at=? WHERE workspace_id=? AND data::jsonb->>'invoiceId' IN (?,?)").run("2000-01-01T00:00:00.000Z",row.workspace_id,paidId,failedId)
    const presentation=await getCompanyBillingPresentation(row.workspace_id)
    assert.equal(presentation.paymentFailedInvoice?.id,failedId)
    assert.notEqual(presentation.actionRequiredInvoice?.id,paidId)
    const result=await deliverBillingNotifications()
    assert.equal(result.delivered,0)
    assert.equal((await getDatabase().prepare<{delivered_at:string|null}>("SELECT delivered_at FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'invoiceId'=?").get(row.workspace_id,paidId))?.delivered_at!==null,true)
    assert.equal((await getDatabase().prepare<{delivered_at:string|null}>("SELECT delivered_at FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'invoiceId'=?").get(row.workspace_id,failedId))?.delivered_at,null)
  } finally {delete process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES}
})

test("failed-payment banner waits for an invoice snapshot newer than the failure event",async()=>{
  const owner=await createWorkspaceWithAdmin({workspaceName:"Stale invoice",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Unused fixture password 99!",role:"admin"})
  const customer=`cus_${randomUUID()}`,invoiceId=`in_${randomUUID()}`
  await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)").run(owner.workspaceId,customer,nowIso())
  await getDatabase().prepare("INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at) VALUES (?,?,'open','usd',1000,0,1000,?,?)").run(invoiceId,owner.workspaceId,nowIso(),"2000-01-01T00:00:00.000Z")
  process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES="true"
  try {
    await processStripeBillingEvent({id:`evt_${randomUUID()}`,type:"invoice.payment_failed",livemode:false,data:{object:{id:invoiceId,customer}}} as Stripe.Event)
    assert.equal((await getCompanyBillingPresentation(owner.workspaceId)).paymentFailedInvoice,null)
    assert.equal((await getCompanyBillingPresentation(owner.workspaceId)).timeZone,"America/New_York")
    await getDatabase().prepare("UPDATE workspaces SET timezone=? WHERE id=?").run("Not/AZone",owner.workspaceId)
    assert.equal((await getCompanyBillingPresentation(owner.workspaceId)).timeZone,null)
    await getDatabase().prepare("UPDATE company_billing_invoices SET synced_at=? WHERE workspace_id=? AND stripe_invoice_id=?").run("2100-01-01T00:00:00.000Z",owner.workspaceId,invoiceId)
    assert.equal((await getCompanyBillingPresentation(owner.workspaceId)).paymentFailedInvoice?.id,invoiceId)
  } finally {delete process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES}
})

test("verified notice retry suppresses frozen email after invoice settlement",async()=>{
  const owner=await createWorkspaceWithAdmin({workspaceName:"Settled retry",adminName:"Owner",adminEmail:`${randomUUID()}@example.test`,password:"Unused fixture password 99!",role:"admin"})
  const customer=`cus_${randomUUID()}`,invoiceId=`in_${randomUUID()}`
  await getDatabase().prepare("INSERT INTO workspace_stripe_customers (workspace_id,stripe_customer_id,created_at) VALUES (?,?,?)").run(owner.workspaceId,customer,nowIso())
  await getDatabase().prepare("INSERT INTO workspace_owners (workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(owner.workspaceId,owner.membershipId,nowIso())
  const requests:number[]=[]
  const server=createServer((_request,response)=>{requests.push(1);response.writeHead(503);response.end()})
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
  const address=server.address();assert.ok(address&&typeof address!=="string")
  process.env.MCA_EMAIL_WEBHOOK_URL=`http://127.0.0.1:${address.port}`
  process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES="true"
  try {
    await processStripeBillingEvent({id:`evt_${randomUUID()}`,type:"invoice.payment_failed",livemode:false,data:{object:{id:invoiceId,customer}}} as Stripe.Event)
    await getDatabase().prepare("INSERT INTO company_billing_invoices(stripe_invoice_id,workspace_id,status,currency,amount_due,amount_paid,amount_remaining,created_at,synced_at) VALUES (?,?,'open','usd',1000,0,1000,?,?)").run(invoiceId,owner.workspaceId,nowIso(),"2100-01-01T00:00:00.000Z")
    const first=await deliverBillingNotifications()
    assert.equal(first.delivered,0)
    assert.equal(requests.length,1)
    const notice=await getDatabase().prepare<{id:string;delivery_payload:string|null;delivered_at:string|null}>("SELECT id,delivery_payload,delivered_at FROM company_billing_notifications WHERE workspace_id=? AND data::jsonb->>'invoiceId'=?").get(owner.workspaceId,invoiceId)
    assert.ok(notice?.delivery_payload)
    assert.equal(notice.delivered_at,null)
    await getDatabase().prepare("UPDATE company_billing_invoices SET status='paid',amount_paid=1000,amount_remaining=0,synced_at=? WHERE workspace_id=? AND stripe_invoice_id=?").run("2100-01-02T00:00:00.000Z",owner.workspaceId,invoiceId)
    await getDatabase().prepare("UPDATE company_billing_notifications SET available_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z",notice.id)
    const retry=await deliverBillingNotifications()
    assert.equal(retry.delivered,0)
    assert.equal(requests.length,1)
    const suppressed=await getDatabase().prepare<{delivery_payload:string;delivered_at:string|null}>("SELECT delivery_payload,delivered_at FROM company_billing_notifications WHERE id=?").get(notice.id)
    assert.equal(suppressed?.delivery_payload,notice.delivery_payload)
    assert.ok(suppressed?.delivered_at)
  } finally {
    delete process.env.MCA_EMAIL_WEBHOOK_URL
    delete process.env.MCA_BILLING_VERIFIED_INVOICE_NOTICES
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
  }
})
