import test,{before,after,mock} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {getDatabase,nowIso,closeDatabaseForTests} from "../src/lib/mca/db"
import {TRIAL_DAYS,TRIAL_SEATS} from "../src/lib/mca/billing-catalog"
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
let billing:typeof import("../src/lib/mca/billing")
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
  billing=await import("../src/lib/mca/billing")
})
after(async()=>{clearStripeEnv();await closeDatabaseForTests();await database?.close()})
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
  clearStripeEnv()
  const off=await json(await GET())
  assert.equal(off.status,200)
  assert.equal(off.body.cardRequiredTrial,false)
  assert.equal(off.body.trialDays,undefined)
  setStripeEnv()
  try {
    const on=await json(await GET())
    assert.equal(on.status,200)
    assert.equal(on.body.cardRequiredTrial,true)
    assert.equal(on.body.trialDays,14)
  } finally {clearStripeEnv()}
})
test("unconfigured POST onboarding starts a local trial and never constructs Stripe",async()=>{
  clearStripeEnv()
  const stripe=mock.method(billing,"getStripeClient",()=>{throw new Error("Stripe client constructed")})
  const checkout=mock.method(billing,"createBillingCheckout",async()=>{throw new Error("Stripe checkout constructed")})
  const warnings:string[]=[]
  const warn=mock.method(console,"warn",(message:string)=>{warnings.push(String(message))})
  try {
    const created=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Legacy onboarding company",selectedSeats:4})})))
    assert.equal(created.status,200)
    assert.equal("checkoutUrl" in created.body && created.body.checkoutUrl!=null,false)
    assert.equal(created.body.billingEnabled,false)
    const access=await getCompanyAccess(String(created.body.workspaceId))
    assert.equal(access.allowed,true);assert.equal(access.status,"trial")
    const state=await getDatabase().prepare<{trial_ends_at:string;seat_limit:number}>("SELECT s.trial_ends_at,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(created.body.workspaceId)
    assert.ok(state?.trial_ends_at)
    assert.ok(Math.abs(Date.parse(state.trial_ends_at)-Date.now()-TRIAL_DAYS*86400000)<60_000)
    assert.equal(state.seat_limit,TRIAL_SEATS)
    assert.equal(stripe.mock.callCount(),0)
    assert.equal(checkout.mock.callCount(),0)
    assert.match(warnings.join("\n"),/using the legacy no-card 14-day trial/)
  } finally {stripe.mock.restore();checkout.mock.restore();warn.mock.restore()}
})
test("configured POST onboarding returns a mocked Checkout URL and finish_setup access",async()=>{
  setStripeEnv()
  const stripe=mock.method(billing,"getStripeClient",()=>{throw new Error("Stripe client constructed")})
  const checkout=mock.method(billing,"createBillingCheckout",async()=>({url:"https://checkout.stripe.com/test"}))
  try {
    const created=await json(await POST(new Request("http://localhost/api/onboarding",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Checkout onboarding company",selectedSeats:8})})))
    assert.equal(created.status,200)
    assert.equal(created.body.checkoutUrl,"https://checkout.stripe.com/test")
    assert.equal(created.body.billingEnabled,true)
    const access=await getCompanyAccess(String(created.body.workspaceId))
    assert.equal(access.allowed,false);assert.equal(access.reason,"finish_setup")
    assert.equal(checkout.mock.callCount(),1)
    assert.equal(stripe.mock.callCount(),0)
  } finally {stripe.mock.restore();checkout.mock.restore();clearStripeEnv()}
})
