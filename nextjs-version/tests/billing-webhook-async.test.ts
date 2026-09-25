import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type Stripe from "stripe"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase, closeDatabaseForTests, nowIso } from "../src/lib/mca/db"
import { createWorkspaceWithAdmin } from "../src/lib/mca/workspaces"
import { processStripeBillingEvent, type StripeBillingClient } from "../src/lib/mca/billing"
import { deliverBillingNotifications, runBillingMaintenance } from "../src/lib/mca/billing-operations"
import { getCompanyBillingPresentation } from "../src/lib/mca/billing-presentation"
import { claimBackgroundJob } from "../src/lib/mca/jobs/queue"

let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const keys = ["DATABASE_URL","MCA_STRIPE_BILLING_ENABLED","MCA_STRIPE_MODE","STRIPE_BASE_PRICE_ID","STRIPE_ADDITIONAL_SEAT_PRICE_ID","MCA_APP_ORIGIN","MCA_EMAIL_WEBHOOK_URL"]
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
      assert.deepEqual(await processStripeBillingEvent(event),{queued:true})
      assert.deepEqual(await processStripeBillingEvent(event),{duplicate:true})
      assert.deepEqual(await processStripeBillingEvent({...event,id:`evt_${randomUUID()}`}),{queued:true})
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
