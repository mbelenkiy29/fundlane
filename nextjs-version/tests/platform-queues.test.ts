import test, { before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests } from "../src/lib/mca/db"
const actor={userId:"owner",supabaseUserId:"00000000-0000-4000-8000-000000000001",email:"mike@sentineltechsolutions.io",sessionId:"session"}
let signedIn=true
mock.module(new URL("../src/lib/mca/supabase-auth.ts",import.meta.url).href,{namedExports:{supabaseIdentity:async()=>signedIn?{user:{id:actor.supabaseUserId},email:actor.email,sessionId:actor.sessionId}:null}})
mock.module(new URL("../src/lib/supabase/server.ts",import.meta.url).href,{namedExports:{createSupabaseServerClient:async()=>({auth:{getClaims:async()=>({data:{claims:{sub:actor.supabaseUserId,session_id:actor.sessionId,aal:"aal2"}},error:null}),getUser:async()=>({data:{user:null}})}})}})
let db:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let queues:typeof import("../src/lib/mca/platform-queues")
let route:typeof import("../src/app/api/platform/queues/route")
const stamp="2026-01-01T00:00:00.000Z"
before(async()=>{
 db=await createPostgresTestDatabase("platform_queues");process.env.DATABASE_URL=db.databaseUrl
 await db.query("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES ('owner',$1,'Owner','MCA-owner',$2,$3,$3)",[actor.email,actor.supabaseUserId,stamp])
 await db.query("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES ('owner',$1,'test','Test')",[stamp])
 await db.query(`INSERT INTO workspaces(id,name,feature_flags,page_visibility,created_at,updated_at) SELECT 'queue-'||lpad(i::text,3,'0'),'Company '||i,'{}','{}',$1,$1 FROM generate_series(1,101) i`,[stamp])
 await db.query(`INSERT INTO sms_companies(workspace_id,owner_user_id,review_state,profile_cipher,provider_cipher,content_cipher,created_at,updated_at) SELECT id,'owner',CASE WHEN id='queue-101' THEN 'pending' ELSE 'draft' END,'SECRET-PROFILE','SECRET-PROVIDER','PRIVATE-MESSAGE',$1,$1 FROM workspaces`,[stamp])
 ;[queues,route]=await Promise.all([import("../src/lib/mca/platform-queues"),import("../src/app/api/platform/queues/route")])
})
after(async()=>{await closeDatabaseForTests();await db?.close()})
test("101 companies and SMS records page without loss or duplicate timestamp ties",async()=>{
 for(const list of [queues.listCompanyOperations,queues.listSmsReviewQueue]){
 const ids:string[]=[];let cursor:string|undefined
 do {const page=await list(actor,{limit:50,cursor});assert.ok(page.items.length<=50);ids.push(...page.items.map(i=>i.workspaceId));cursor=page.nextCursor??undefined}while(cursor)
 assert.equal(ids.length,101);assert.equal(new Set(ids).size,101)
 }
})
test("state and company filters run before the limit and cursor cannot cross filters",async()=>{
 const page=await queues.listSmsReviewQueue(actor,{state:"pending",limit:1})
 assert.deepEqual(page.items.map(i=>i.workspaceId),["queue-101"]);assert.equal(page.nextCursor,null)
 assert.deepEqual((await queues.listCompanyOperations(actor,{workspaceId:"queue-101",limit:1})).items.map(i=>i.workspaceId),["queue-101"])
 const first=await queues.listCompanyOperations(actor,{limit:1})
 await assert.rejects(queues.listCompanyOperations(actor,{workspaceId:"queue-101",limit:1,cursor:first.nextCursor!}),{code:"invalid_query"})
})
test("missing provider observations remain unknown and legacy submissions have no invented version",async()=>{
 const company=(await queues.listCompanyOperations(actor,{workspaceId:"queue-101",limit:50})).items[0]
 assert.equal(company.providerState,"unknown");assert.equal(company.observedAt,null)
 const sms=(await queues.listSmsReviewQueue(actor,{workspaceId:"queue-101",limit:50})).items[0]
 assert.equal(sms.submissionId,null);assert.equal(sms.version,null)
 assert.deepEqual(Object.keys(company).sort(),["workspaceId","name","ownerEmail","occupiedSeats","purchasedSeats","subscriptionStatus","accessState","smsReviewState","providerState","blockedReasons","observedAt","billingObservation"].sort())
 assert.doesNotMatch(JSON.stringify([company,sms]),/SECRET|PRIVATE|cipher|profile_payload/)
})
test("HTTP validates bounds and rejects tenant roles, revoked grants and API keys regardless of requested company",async()=>{
 const request=(suffix="",headers={})=>new Request(`https://app.test/api/platform/queues?workspaceId=queue-101${suffix}`,{headers})
 const all=await route.GET(new Request("https://app.test/api/platform/queues"))
 assert.equal((await all.json()).items.length,50)
 const maximum=await route.GET(new Request("https://app.test/api/platform/queues?limit=100"))
 assert.equal((await maximum.json()).items.length,100)
 assert.equal((await route.GET(request("&limit=0"))).status,422)
 assert.equal((await route.GET(request("&limit=101"))).status,422)
 assert.equal((await route.GET(request("&cursor=garbage"))).status,422)
 const response=await route.GET(request());assert.equal(response.status,200);assert.match(response.headers.get("cache-control")!,/no-store/)
 assert.equal((await response.json()).items[0].workspaceId,"queue-101")
 assert.equal((await route.GET(request("",{authorization:"Bearer mca_fake"}))).status,403)
 await db.query("UPDATE platform_admin_grants SET revoked_at=$1 WHERE user_id='owner'",[stamp])
 await db.query("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES ('tenant','queue-101','owner','super_admin','active',$1,$1)",[stamp])
 assert.equal((await route.GET(request())).status,403)
 await assert.rejects(queues.listCompanyOperations(actor,{workspaceId:"queue-101",limit:50}),{status:403})
 signedIn=false;assert.equal((await route.GET(request())).status,401);signedIn=true
 await db.query("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id='owner'")
})
test("registration summaries use conservative provider states and latest attempts without exposing diagnostics",async()=>{
 await db.query(`INSERT INTO sms_registrations(id,workspace_id,kind,attempt,status,provider_status,rejection_detail_cipher,created_at,updated_at) VALUES
 ('old','queue-101','brand',1,'approved','approved','SECRET-DIAGNOSTIC',$1,$1),
 ('new','queue-101','brand',2,'approved','unrecognized_provider_value','SECRET-DIAGNOSTIC',$1,$1),
 ('other','queue-100','brand',1,'approved','approved','SECRET-OTHER',$1,$1)`,[stamp])
 const row=(await queues.listSmsReviewQueue(actor,{workspaceId:"queue-101",limit:1})).items[0]
 assert.deepEqual(row.registrationSummary,[{id:"new",kind:"brand",attempt:2,state:"unknown"}])
 assert.doesNotMatch(JSON.stringify(row),/SECRET|other|unrecognized_provider_value/)
})
test("company detail includes only scoped membership and seat metadata",async()=>{
 const { platformCompany }=await import("../src/lib/mca/platform-console")
 const detail=await platformCompany("queue-101")
 assert.equal(detail.seats.occupied,1)
 assert.deepEqual(detail.memberships.map(m=>({id:m.membershipId,role:m.role,status:m.status})),[{id:"tenant",role:"super_admin",status:"active"}])
 assert.deepEqual(Object.keys(detail.memberships[0]).sort(),["membershipId","name","email","role","status"].sort())
 assert.equal((await platformCompany("queue-100")).memberships.length,0)
})
test("latest operation metadata stays company-scoped and excludes payloads and raw errors",async()=>{
 await db.query(`INSERT INTO sms_operations(id,workspace_id,kind,request_key,payload_cipher,state,error_code,created_at,updated_at) VALUES ('operation-a','queue-101','register','request-a','SECRET-OPERATION','needs_review','SECRET-ERROR',$1,$1),('operation-b','queue-100','register','request-b','SECRET-OTHER','queued',NULL,$1,$1)`,[stamp])
 const row=(await queues.listSmsReviewQueue(actor,{workspaceId:"queue-101",limit:1})).items[0]
 assert.deepEqual(row.latestOperation,{id:"operation-a",kind:"register",state:"needs_review"})
 assert.doesNotMatch(JSON.stringify(row),/SECRET|operation-b/)
})
