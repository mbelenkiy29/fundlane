import test,{before,after,mock} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {getDatabase,nowIso,closeDatabaseForTests} from "../src/lib/mca/db"
import {BILLING_CATALOG,TRIAL_DAYS,TRIAL_SEATS} from "../src/lib/mca/billing-catalog"
const userId=randomUUID(),sessionId=randomUUID()
const stripeEnv={MCA_STRIPE_BILLING_ENABLED:"true",MCA_STRIPE_MODE:"test",STRIPE_SECRET_KEY:"rk_test_fixture",STRIPE_BASE_PRICE_ID:"price_base",STRIPE_ADDITIONAL_SEAT_PRICE_ID:"price_seats",STRIPE_BILLING_WEBHOOK_SECRET:"whsec_fixture",MCA_APP_ORIGIN:"http://localhost:3000"}
const stripeEnvKeys=Object.keys(stripeEnv)
mock.module("next/headers",{namedExports:{cookies:async()=>({get:()=>undefined,set:()=>{}})}})
mock.module(new URL("../src/lib/supabase/server.ts",import.meta.url).href,{namedExports:{
  getSupabaseAdminClient:()=>({}),
  createSupabaseServerClient:async()=>({auth:{getUser:async()=>({data:{user:{id:userId,email:`${userId}@example.test`,email_confirmed_at:nowIso(),app_metadata:{},user_metadata:{name:"Trial owner"}}},error:null}),getClaims:async()=>({data:{claims:{sub:userId,session_id:sessionId}},error:null})}}),
}})
let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let completeCompanyOnboarding:typeof import("../src/lib/mca/supabase-auth").completeCompanyOnboarding
let getCompanyAccess:typeof import("../src/lib/mca/company-access").getCompanyAccess
let GET:typeof import("../src/app/api/onboarding/route").GET
let POST:typeof import("../src/app/api/onboarding/route").POST
let createOnboardingCheckoutUrl:typeof import("../src/lib/mca/billing").createOnboardingCheckoutUrl
let getStripeClient:typeof import("../src/lib/mca/billing").getStripeClient
function clearStripeEnv(){
  for(const key of stripeEnvKeys) delete process.env[key]
}
function setStripeEnv(){
  Object.assign(process.env,stripeEnv)
}
async function json(response:Response){
  return {status:response.status,body:await response.json() as Record<string,unknown>}
}
before(async()=>{
  database=await createPostgresTestDatabase("billing_onboarding");process.env.DATABASE_URL=database.databaseUrl
  await getDatabase().prepare("CREATE SCHEMA IF NOT EXISTS mca_private").run()
  await getDatabase().prepare("CREATE TABLE mca_private.auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)").run()
  await getDatabase().prepare("INSERT INTO mca_private.auth_sessions VALUES (?,?,now()+interval '1 hour')").run(sessionId,userId)
  clearStripeEnv()
  ;({completeCompanyOnboarding}=await import("../src/lib/mca/supabase-auth"))
  ;({getCompanyAccess}=await import("../src/lib/mca/company-access"))
  ;({GET,POST}=await import("../src/app/api/onboarding/route"))
  ;({createOnboardingCheckoutUrl,getStripeClient}=await import("../src/lib/mca/billing"))
})
after(async()=>{clearStripeEnv();delete process.env.MCA_SIGNUP_MODE;delete process.env.MCA_TRIAL_REQUIRES_CARD;await closeDatabaseForTests();await database?.close()})
test("invite-only blocks OAuth onboarding creation while existing workspace selection stays available",async()=>{
  delete process.env.MCA_SIGNUP_MODE
  const existing=await completeCompanyOnboarding("Invite-only selection fixture")
  process.env.MCA_SIGNUP_MODE="invite_only"
  try {
    const get=await json(await GET())
    assert.equal(get.body.signupMode,"invite_only")
    const create=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Forbidden company"})})))
    assert.equal(create.status,403)
    assert.equal((create.body.error as {code:string}).code,"signup_invite_only")
    await assert.rejects(completeCompanyOnboarding("Direct forbidden company"),{code:"signup_invite_only"})
    assert.equal(await getDatabase().prepare("SELECT id FROM workspaces WHERE name=?").get("Forbidden company"),undefined)
    const select=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:existing.workspaceId})})))
    assert.equal(select.status,200)
    assert.equal(select.body.workspaceId,existing.workspaceId)
  } finally {delete process.env.MCA_SIGNUP_MODE}
})
test("workspace creation is limited per client IP before another workspace is created",async()=>{
  delete process.env.MCA_SIGNUP_MODE
  const create=(index:number)=>POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json","x-forwarded-for":"192.0.2.54"},body:JSON.stringify({name:`Rate limited company ${index}`})}))
  for(let index=0;index<10;index++) assert.equal((await create(index)).status,200)
  const blocked=await json(await create(10))
  assert.equal(blocked.status,429)
  assert.equal((blocked.body.error as {code:string}).code,"rate_limit_exceeded")
  assert.equal(await getDatabase().prepare("SELECT id FROM workspaces WHERE name=?").get("Rate limited company 10"),undefined)
})
test("company creation stores a >5 paid quantity and starts one five-seat trial atomically",async()=>{
  clearStripeEnv()
  const warnings:string[]=[]
  const warn=mock.method(console,"warn",(message:string)=>{warnings.push(String(message))})
  try {
    const context=await completeCompanyOnboarding("Large selected company",21)
    const state=await getDatabase().prepare<{selected_seats:number;trial_started_at:string;trial_ends_at:string;legacy_exempt:number;seat_limit:number}>("SELECT s.*,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(context.workspaceId)
    assert.equal(state?.selected_seats,21);assert.equal(state?.seat_limit,TRIAL_SEATS);assert.equal(state?.legacy_exempt,0)
    assert.equal(Date.parse(state!.trial_ends_at)-Date.parse(state!.trial_started_at),TRIAL_DAYS*86400000)
    const access=await getCompanyAccess(context.workspaceId)
    assert.equal(access.allowed,true);assert.equal(access.status,"trial");assert.equal(access.reason,null)
    assert.equal((await completeCompanyOnboarding("Large selected company",50)).workspaceId,context.workspaceId)
    const unchanged=await getDatabase().prepare<{selected_seats:number;trial_started_at:string}>("SELECT selected_seats,trial_started_at FROM company_subscription_state WHERE workspace_id=?").get(context.workspaceId)
    assert.equal(unchanged?.selected_seats,21);assert.equal(unchanged?.trial_started_at,state?.trial_started_at)
    assert.ok(await getDatabase().prepare("SELECT membership_id FROM workspace_owners WHERE workspace_id=?").get(context.workspaceId))
    assert.match(warnings.join("\n"),/Stripe Checkout trial not fully configured \(missing: .*MCA_STRIPE_BILLING_ENABLED/)
  } finally {warn.mock.restore()}
})
test("initializer failure rolls back company creation",async()=>{
  clearStripeEnv()
  await assert.rejects(completeCompanyOnboarding("Invalid seats company",0),RangeError)
  assert.equal(await getDatabase().prepare("SELECT id FROM workspaces WHERE name=?").get("Invalid seats company"),undefined)
})
test("company retry uses explicit ownership rather than an administrative role",async()=>{
  clearStripeEnv()
  const context=await completeCompanyOnboarding("Ownership-aware company",5)
  const db=getDatabase(),now=nowIso()
  await db.prepare("UPDATE memberships SET role='super_admin' WHERE id=?").run(context.membershipId)
  assert.equal((await completeCompanyOnboarding("Ownership-aware company",5)).workspaceId,context.workspaceId,"a super_admin owner must not create duplicates")
  const successor=randomUUID(),membershipId=randomUUID()
  await db.prepare("INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(successor,`${successor}@example.test`,"Successor",`MCA-${successor}`,now,now)
  await db.prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'admin','active',?,?)").run(membershipId,context.workspaceId,successor,now,now)
  const {transferCompanyOwnership}=await import("../src/lib/mca/company-ownership")
  await transferCompanyOwnership({...context,role:"super_admin"},membershipId)
  await db.prepare("UPDATE memberships SET role='admin' WHERE id=?").run(context.membershipId)
  const fresh=await completeCompanyOnboarding("Ownership-aware company",7)
  assert.notEqual(fresh.workspaceId,context.workspaceId,"an admin who no longer owns a company must not silently reuse it")
  assert.equal((await db.prepare<{selected_seats:number}>("SELECT selected_seats FROM company_subscription_state WHERE workspace_id=?").get(fresh.workspaceId))?.selected_seats,7)
})
test("configured onboarding stores selected seats without a local trial",async()=>{
  setStripeEnv()
  try {
    const context=await completeCompanyOnboarding("Card first company",21)
    const state=await getDatabase().prepare<{selected_seats:number;trial_started_at:string|null;trial_ends_at:string|null;legacy_exempt:number;seat_limit:number}>("SELECT s.*,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(context.workspaceId)
    assert.equal(state?.selected_seats,21);assert.equal(state?.seat_limit,1);assert.equal(state?.legacy_exempt,0)
    assert.equal(state?.trial_started_at,null);assert.equal(state?.trial_ends_at,null)
    const access=await getCompanyAccess(context.workspaceId)
    assert.equal(access.allowed,false);assert.equal(access.reason,"finish_setup")
  } finally {clearStripeEnv()}
})
test("GET /api/onboarding exposes cardRequiredTrial from the shared helper",async()=>{
  const previousLifecycleFlag=process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  clearStripeEnv()
  const off=await json(await GET())
  assert.equal(off.status,200)
  assert.equal(off.body.cardRequiredTrial,false)
  assert.equal(off.body.trialDays,undefined)
  assert.equal(off.body.trialLifecycleEnabled,false)
  setStripeEnv()
  try {
    const on=await json(await GET())
    assert.equal(on.status,200)
    assert.equal(on.body.cardRequiredTrial,true)
    assert.equal(on.body.trialDays,14)
    assert.equal(on.body.trialLifecycleEnabled,false)
    process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED="true"
    assert.equal((await json(await GET())).body.trialLifecycleEnabled,true)
    delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED
  } finally {clearStripeEnv();if(previousLifecycleFlag===undefined)delete process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED;else process.env.MCA_STRIPE_TRIAL_LIFECYCLE_ENABLED=previousLifecycleFlag}
})
test("unconfigured POST onboarding starts a local trial and never constructs Stripe",async()=>{
  clearStripeEnv()
  const warnings:string[]=[]
  const warn=mock.method(console,"warn",(message:string)=>{warnings.push(String(message))})
  try {
    const created=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Legacy onboarding company",selectedSeats:4})})))
    assert.equal(created.status,200)
    assert.equal(created.body.checkoutUrl,undefined)
    assert.equal(created.body.billingEnabled,false)
    const access=await getCompanyAccess(String(created.body.workspaceId))
    assert.equal(access.allowed,true);assert.equal(access.status,"trial")
    const state=await getDatabase().prepare<{trial_ends_at:string;seat_limit:number}>("SELECT s.trial_ends_at,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(created.body.workspaceId)
    assert.ok(state?.trial_ends_at)
    assert.ok(Math.abs(Date.parse(state.trial_ends_at)-Date.now()-TRIAL_DAYS*86400000)<60_000)
    assert.equal(state.seat_limit,TRIAL_SEATS)
    assert.equal(await createOnboardingCheckoutUrl(String(created.body.workspaceId),String(created.body.role),4),undefined)
    assert.throws(()=>getStripeClient(),/not enabled/)
    assert.match(warnings.join("\n"),/using the legacy no-card 14-day trial/)
  } finally {warn.mock.restore()}
})
test("card-required flag keeps a misconfigured new company in finish_setup without Stripe calls",async()=>{
  clearStripeEnv()
  process.env.MCA_TRIAL_REQUIRES_CARD="true"
  const errors:string[]=[]
  const error=mock.method(console,"error",(message:string)=>{errors.push(String(message))})
  try {
    const get=await json(await GET())
    assert.equal(get.body.cardRequiredTrial,true)
    assert.equal(get.body.checkoutUnavailable,true)
    const created=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Unavailable card checkout company",selectedSeats:7})})))
    assert.equal(created.status,200)
    assert.equal(created.body.checkoutUrl,undefined)
    assert.equal(created.body.checkoutUnavailable,true)
    const workspaceId=String(created.body.workspaceId)
    const state=await getDatabase().prepare<{trial_started_at:string|null;trial_ends_at:string|null;selected_seats:number;legacy_exempt:number;seat_limit:number}>("SELECT s.*,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(workspaceId)
    assert.equal(state?.trial_started_at,null)
    assert.equal(state?.trial_ends_at,null)
    assert.equal(state?.selected_seats,7)
    assert.equal(state?.seat_limit,1)
    assert.equal(state?.legacy_exempt,0)
    assert.deepEqual(await getCompanyAccess(workspaceId),{allowed:false,status:"paused",reason:"finish_setup",seatLimit:1,trialEndsAt:null,graceEndsAt:null,manualPaused:false})
    const retry=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Unavailable card checkout company",selectedSeats:12})})))
    assert.equal(retry.body.workspaceId,workspaceId)
    assert.equal((await getDatabase().prepare<{selected_seats:number}>("SELECT selected_seats FROM company_subscription_state WHERE workspace_id=?").get(workspaceId))?.selected_seats,7)
    assert.ok(errors.some(message=>message.includes('"code":"card_required_trial_checkout_unconfigured"')))
    assert.throws(()=>getStripeClient(),/not enabled/)
    const {createBillingCheckout}=await import("../src/lib/mca/billing")
    await assert.rejects(createBillingCheckout(workspaceId,7,true,{} as never),{code:"billing_checkout_unavailable"})
    await getDatabase().prepare("UPDATE company_subscription_state SET access_extended_until=? WHERE workspace_id=?").run(new Date(Date.now()+86400000).toISOString(),workspaceId)
    assert.equal((await getCompanyAccess(workspaceId)).status,"extended")
  } finally {error.mock.restore();delete process.env.MCA_TRIAL_REQUIRES_CARD}
})
test("enabling card requirement does not pause an existing local trial",async()=>{
  clearStripeEnv()
  const existing=await completeCompanyOnboarding("Existing local trial company",3)
  const originalTrialEnd=(await getCompanyAccess(existing.workspaceId)).trialEndsAt
  process.env.MCA_TRIAL_REQUIRES_CARD="true"
  process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED="true"
  try {
    const selected=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:existing.workspaceId})})))
    assert.equal(selected.status,200)
    assert.equal(selected.body.checkoutUnavailable,false)
    assert.equal((await getCompanyAccess(existing.workspaceId)).status,"trial")
    assert.equal((await getCompanyAccess(existing.workspaceId)).trialEndsAt,originalTrialEnd)
  } finally {delete process.env.MCA_TRIAL_REQUIRES_CARD;delete process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED}
})
test("configured onboarding returns a mocked Checkout URL and finish_setup access",async()=>{
  setStripeEnv()
  let checkoutCreations=0
  const client={
    customers:{create:async()=>({id:"cus_onboard",livemode:false})},
    prices:{retrieve:async(id:string)=>({id,active:true,livemode:false,currency:"usd",unit_amount:id==="price_base"?BILLING_CATALOG.base.unitAmountCents:null,billing_scheme:id==="price_base"?"per_unit":"tiered",tiers_mode:"graduated",tiers:BILLING_CATALOG.additionalSeats.tiers.map(tier=>({up_to:tier.upTo,unit_amount:tier.unitAmountCents})),recurring:{interval:"month",interval_count:1,usage_type:"licensed"}})},
    subscriptions:{list:async()=>({data:[],has_more:false})},
    invoices:{list:async()=>({data:[],has_more:false})},
    invoicePayments:{list:async()=>({data:[],has_more:false})},
    charges:{list:async()=>({data:[],has_more:false})},
    checkout:{sessions:{create:async()=>{checkoutCreations++;return {id:"cs_onboard",livemode:false,url:"https://checkout.stripe.com/test"}},retrieve:async()=>({id:"cs_onboard",status:"open",url:"https://checkout.stripe.com/test",payment_method_types:["card"]})}},
  }
  try {
    const context=await completeCompanyOnboarding("Checkout onboarding company",8)
    const access=await getCompanyAccess(context.workspaceId)
    assert.equal(access.allowed,false);assert.equal(access.reason,"finish_setup")
    const checkoutUrl=await createOnboardingCheckoutUrl(context.workspaceId,context.role,1,client as never)
    assert.equal(checkoutUrl,"https://checkout.stripe.com/test")
    process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED="true"
    const reused=await completeCompanyOnboarding("Checkout onboarding company",12)
    assert.equal(reused.workspaceId,context.workspaceId)
    assert.equal(await createOnboardingCheckoutUrl(reused.workspaceId,reused.role,1,client as never),checkoutUrl)
    assert.equal(checkoutCreations,1,"durable legacy Checkout is reused without another purchase")
    assert.equal((await getDatabase().queryOne<{selected_seats:number}>("SELECT selected_seats FROM company_subscription_state WHERE workspace_id=?",[context.workspaceId]))?.selected_seats,8)
  } finally {clearStripeEnv();delete process.env.MCA_STRIPE_FIRST_ONBOARDING_ENABLED}
})
