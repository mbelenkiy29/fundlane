import test,{before,after,mock} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {getDatabase,nowIso,closeDatabaseForTests} from "../src/lib/mca/db"
const userId=randomUUID(),sessionId=randomUUID()
mock.module("next/headers",{namedExports:{cookies:async()=>({get:()=>undefined,set:()=>{}})}})
mock.module(new URL("../src/lib/supabase/server.ts",import.meta.url).href,{namedExports:{
  getSupabaseAdminClient:()=>({}),
  createSupabaseServerClient:async()=>({auth:{getUser:async()=>({data:{user:{id:userId,email:`${userId}@example.test`,email_confirmed_at:nowIso(),app_metadata:{},user_metadata:{name:"Trial owner"}}},error:null}),getClaims:async()=>({data:{claims:{sub:userId,session_id:sessionId}},error:null})}}),
}})
let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let completeCompanyOnboarding:typeof import("../src/lib/mca/supabase-auth").completeCompanyOnboarding
before(async()=>{
  database=await createPostgresTestDatabase("billing_onboarding");process.env.DATABASE_URL=database.databaseUrl
  await getDatabase().prepare("CREATE SCHEMA IF NOT EXISTS mca_private").run()
  await getDatabase().prepare("CREATE TABLE mca_private.auth_sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz)").run()
  await getDatabase().prepare("INSERT INTO mca_private.auth_sessions VALUES (?,?,now()+interval '1 hour')").run(sessionId,userId)
  ;({completeCompanyOnboarding}=await import("../src/lib/mca/supabase-auth"))
})
after(async()=>{await closeDatabaseForTests();await database?.close()})
test("company creation stores a >5 paid quantity and starts one five-seat trial atomically",async()=>{
  const context=await completeCompanyOnboarding("Large selected company",21)
  const state=await getDatabase().prepare<{selected_seats:number;trial_started_at:string;trial_ends_at:string;legacy_exempt:number;seat_limit:number}>("SELECT s.*,w.seat_limit FROM company_subscription_state s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?").get(context.workspaceId)
  assert.equal(state?.selected_seats,21);assert.equal(state?.seat_limit,5);assert.equal(state?.legacy_exempt,0)
  assert.equal(Date.parse(state!.trial_ends_at)-Date.parse(state!.trial_started_at),14*86400000)
  assert.equal((await completeCompanyOnboarding("Large selected company",50)).workspaceId,context.workspaceId)
  const unchanged=await getDatabase().prepare<{selected_seats:number;trial_started_at:string}>("SELECT selected_seats,trial_started_at FROM company_subscription_state WHERE workspace_id=?").get(context.workspaceId)
  assert.equal(unchanged?.selected_seats,21);assert.equal(unchanged?.trial_started_at,state?.trial_started_at)
  assert.ok(await getDatabase().prepare("SELECT membership_id FROM workspace_owners WHERE workspace_id=?").get(context.workspaceId))
})
test("initializer failure rolls back company creation",async()=>{
  await assert.rejects(completeCompanyOnboarding("Invalid seats company",0),RangeError)
  assert.equal(await getDatabase().prepare("SELECT id FROM workspaces WHERE name=?").get("Invalid seats company"),undefined)
})
test("company retry uses explicit ownership rather than an administrative role",async()=>{
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
