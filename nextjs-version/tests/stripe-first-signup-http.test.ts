import test,{before,after,mock} from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {getDatabase,closeDatabaseForTests,nowIso} from "../src/lib/mca/db"
import {signupStripeProvider} from "./helpers/signup-stripe-provider"

let provider=signupStripeProvider(),signedIn=false,confirmed=true,signupCalls=0
const providerId=randomUUID(),sessionId=randomUUID(),jar=new Map<string,string>()
mock.module("next/headers",{namedExports:{cookies:async()=>({get:(name:string)=>jar.has(name)?{value:jar.get(name)}:undefined,set:(name:string,value:string)=>jar.set(name,value)})}})
mock.module(new URL("../src/lib/supabase/server.ts",import.meta.url).href,{namedExports:{
 getSupabaseAdminClient:()=>({}),createSupabaseServerClient:async()=>({auth:{
  getUser:async()=>({data:{user:signedIn?{id:providerId,email:provider.email,email_confirmed_at:confirmed?nowIso():null,app_metadata:{},user_metadata:{name:"Synthetic owner",companyName:"Synthetic company"}}:null},error:null}),
  getClaims:async()=>({data:{claims:{sub:providerId,session_id:sessionId}},error:null}),
  signUp:async()=>{signupCalls++;return {data:{session:null},error:null}},
 }})
}})
let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let http:typeof import("../src/lib/mca/signup-http"),service:typeof import("../src/lib/mca/stripe-first-signup")
before(async()=>{
 database=await createPostgresTestDatabase("signup_http");process.env.DATABASE_URL=database.databaseUrl
 Object.assign(process.env,{MCA_STRIPE_BILLING_ENABLED:"true",MCA_STRIPE_MODE:"test",STRIPE_SECRET_KEY:"sk_test_fixture",STRIPE_BASE_PRICE_ID:"price_base",STRIPE_ADDITIONAL_SEAT_PRICE_ID:"price_seats",STRIPE_BILLING_WEBHOOK_SECRET:"whsec_fixture",MCA_APP_ORIGIN:"http://localhost:3000",MCA_TRIAL_ABUSE_LIMITS_ENABLED:"true"})
 await getDatabase().prepare("CREATE TABLE mca_private.auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)").run()
 await getDatabase().prepare("INSERT INTO mca_private.auth_sessions VALUES (?,?,now()+interval '1 day')").run(sessionId,providerId)
 http=await import("../src/lib/mca/signup-http");service=await import("../src/lib/mca/stripe-first-signup")
})
after(async()=>{await closeDatabaseForTests();await database?.close()})
function request(path:string,body:unknown,origin="http://localhost:3000") {return new Request(`http://localhost:3000/api/billing/${path}`,{method:"POST",headers:{origin,"content-type":"application/json","x-forwarded-for":"127.0.0.5"},body:JSON.stringify(body)})}
async function ready(){signedIn=false;jar.clear();provider=signupStripeProvider();assert.equal((await http.signupCheckout(request("signup-checkout",{}),provider.client)).status,200);await service.completeSignupSetup(provider.complete(),provider.client)}

test("HTTP setup persists its secret cookie across a Stripe outage and reuses Checkout",async()=>{
 jar.clear();const create=provider.client.checkout.sessions.create
 let fail=true
 provider.client.checkout.sessions.create=(async(...args:Parameters<typeof create>)=>{if(fail){fail=false;throw new Error("Synthetic Stripe outage")};return create(...args)}) as typeof create
 const response=await http.signupCheckout(request("signup-checkout",{}),provider.client);assert.equal(response.status,500)
 const token=jar.get("fundlane_signup")!;assert.ok(token);assert.equal((await service.readSignupIntent(token)).state,"pending")
 const retry=await http.signupCheckout(request("signup-checkout",{}),provider.client);assert.equal(retry.status,200);assert.equal(jar.get("fundlane_signup"),token)
 assert.match((await retry.json()).url,/checkout.stripe.com/);assert.equal(provider.calls.subscriptions,0)
})
test("HTTP activation requires explicit agreement, verified email and possession of the card intent",async()=>{
 await ready();const input={companyName:"Synthetic company",terms:true,activate:true}
 assert.equal((await http.signupActivate(request("signup-activate",{...input,terms:false}),provider.client)).status,400)
 assert.equal((await http.signupActivate(request("signup-activate",input),provider.client)).status,401)
 signedIn=true;confirmed=false;assert.equal((await http.signupActivate(request("signup-activate",input),provider.client)).status,401);confirmed=true
 const token=jar.get("fundlane_signup")!;jar.delete("fundlane_signup");assert.equal((await http.signupActivate(request("signup-activate",input),provider.client)).status,410);jar.set("fundlane_signup",token)
 assert.equal(provider.calls.subscriptions,0)
})
test("company signup refuses changing the checkout email and missing legal agreement before calling Auth",async()=>{
 const {handleSupabaseAuth}=await import("../src/lib/mca/supabase-auth-http")
 const body={email:provider.email,name:"Synthetic owner",companyName:"Synthetic company",password:"Synthetic password 123!",next:"/activate",terms:"on"}
 assert.equal((await handleSupabaseAuth(request("auth",{...body,email:"attacker@example.test"}),"company-signup")).status,403)
 assert.equal((await handleSupabaseAuth(request("auth",{...body,terms:undefined}),"company-signup")).status,400)
 assert.equal(signupCalls,0)
 assert.equal((await handleSupabaseAuth(request("auth",body),"company-signup")).status,200);assert.equal(signupCalls,1)
})
test("HTTP activation creates one company and one trial across duplicate requests; existing customers keep their workspace",async()=>{
 const input={companyName:"Synthetic company",terms:true,activate:true};signedIn=true;confirmed=true
 const first=await http.signupActivate(request("signup-activate",input),provider.client);assert.equal(first.status,200,JSON.stringify(await first.clone().json()));assert.equal((await first.json()).status,"active")
 const retry=await http.signupActivate(request("signup-activate",{...input,companyName:"Changed company"}),provider.client);assert.equal(retry.status,200)
 assert.equal(provider.calls.subscriptions,1);assert.equal(provider.calls.customers,1)
 assert.equal((await getDatabase().prepare<{count:number}>("SELECT count(*)::int AS count FROM workspaces").get())?.count,1)
 jar.delete("fundlane_signup");assert.equal((await http.signupCheckout(request("signup-checkout",{}),provider.client)).status,200)
 assert.equal(provider.calls.setups,1)
})
