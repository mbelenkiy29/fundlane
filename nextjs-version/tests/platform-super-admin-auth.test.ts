import test,{before,after,mock} from "node:test"
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {readFileSync,readdirSync} from "node:fs"
import {join,relative} from "node:path"
import {createPostgresTestDatabase} from "./helpers/postgres-test-db.mjs"
import {getDatabase,nowIso,closeDatabaseForTests} from "../src/lib/mca/db"

const providerId=randomUUID(),userId=randomUUID(),sessionId=randomUUID()
let email="mike@sentineltechsolutions.io",signedIn=true,confirmed=true,aal="aal2",claimSession=sessionId
mock.module(new URL("../src/lib/mca/supabase-auth.ts",import.meta.url).href,{namedExports:{
  supabaseIdentity:async()=>signedIn&&confirmed?{user:{id:providerId,email,email_confirmed_at:nowIso()},email,sessionId}:null,
}})
mock.module(new URL("../src/lib/supabase/server.ts",import.meta.url).href,{namedExports:{
  createSupabaseServerClient:async()=>({auth:{getClaims:async()=>({data:{claims:{sub:providerId,session_id:claimSession,aal}},error:null}),getUser:async()=>({data:{user:signedIn?{id:providerId,email,email_confirmed_at:confirmed?nowIso():null}:null},error:null})}}),
}})
let fixture:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let auth:typeof import("../src/lib/mca/platform-auth")
let audit:typeof import("../src/lib/mca/platform-audit")
let stepUp:typeof import("../src/lib/mca/platform-step-up")
let sms:typeof import("../src/lib/mca/sms/onboarding")
const oldEnv={...process.env}
before(async()=>{
  fixture=await createPostgresTestDatabase("super_admin_auth")
  process.env.DATABASE_URL=fixture.databaseUrl
  ;[auth,audit,stepUp,sms]=await Promise.all([import("../src/lib/mca/platform-auth"),import("../src/lib/mca/platform-audit"),import("../src/lib/mca/platform-step-up"),import("../src/lib/mca/sms/onboarding")])
  await getDatabase().prepare("INSERT INTO users(id,email,name,application_identifier,supabase_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(userId,"mike@sentineltechsolutions.io","Mike",`MCA-${userId}`,providerId,nowIso(),nowIso())
})
after(async()=>{await closeDatabaseForTests();await fixture?.close();for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv)})

function paths(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?paths(join(root,entry.name)):[join(root,entry.name)])}
test("every platform page and API handler declares the super-admin guard and mutation checks",()=>{
  const pages=paths("src/app/platform").filter(path=>/\/(page|layout)\.tsx$/.test(path))
  const handlers=paths("src/app/api/platform").filter(path=>path.endsWith("/route.ts"))
  const legacy=paths("src/app/api/mca/sms/operator").filter(path=>path.endsWith("/route.ts"))
  assert.ok(pages.length>=7);assert.ok(handlers.length>=10);assert.equal(legacy.length,2)
  for(const file of pages)assert.match(readFileSync(file,"utf8"),/await requirePlatformPage\(/,relative(".",file))
  for(const file of [...handlers,...legacy]){
    const source=readFileSync(file,"utf8")
    assert.match(source,/await requireSuperAdmin\(/,relative(".",file))
    if(/export async function (POST|PUT|PATCH|DELETE)\(/.test(source)){
      assert.match(source,/assertTrustedMutation\(request\)/,relative(".",file))
      assert.match(source,/assertStrictPlatformMutation\(request\)/,relative(".",file))
      assert.match(source,/consumeRequestRateLimit\(/,relative(".",file))
    }
    assert.doesNotMatch(source,/cookies\(\)\.set|mca_workspace|signInAs|impersonat/i,relative(".",file))
  }
})
test("grant, same-session MFA, confirmed email ceiling and API key are independent gates",async()=>{
  signedIn=false
  await assert.rejects(auth.requireSuperAdmin(),{code:"authentication_required",status:401})
  signedIn=true
  await assert.rejects(auth.requireSuperAdmin(),{code:"platform_admin_required",status:403})
  const companyId=randomUUID(),stamp=nowIso()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(companyId,"Synthetic role only","America/New_York",1,"{}","{}","{}",stamp,stamp)
  await getDatabase().prepare("INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(randomUUID(),companyId,userId,"super_admin","active",stamp,stamp)
  await assert.rejects(auth.requireSuperAdmin(new Request("https://app.test/api/platform/companies",{headers:{cookie:`mca_workspace=${companyId}`}})),{code:"platform_admin_required",status:403})
  await getDatabase().prepare("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,?,?)").run(userId,nowIso(),"trusted-operator","Reviewed")
  aal="aal1"
  await assert.rejects(auth.requireSuperAdmin(),{code:"mfa_required",status:403})
  aal="aal2";claimSession=randomUUID()
  await assert.rejects(auth.requireSuperAdmin(),{code:"mfa_required",status:403})
  claimSession=sessionId
  email="outside@example.test"
  await assert.rejects(auth.requireSuperAdmin(),{code:"super_admin_required",status:403})
  email=" Mike@SentinelTechSolutions.io "
  assert.equal((await auth.requireSuperAdmin()).userId,userId)
  process.env.MCA_SUPER_ADMIN_EMAILS=""
  await assert.rejects(auth.requireSuperAdmin(),{code:"super_admin_required",status:403})
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='super_admin.denied' AND reason='super_admin_required'").get())!.n,1)
  delete process.env.MCA_SUPER_ADMIN_EMAILS
  confirmed=false
  await assert.rejects(auth.requireSuperAdmin(),{code:"super_admin_required",status:403})
  confirmed=true
  await assert.rejects(auth.requireSuperAdmin(new Request("https://app.test/api/platform/audit",{headers:{authorization:"Bearer mca_test",cookie:"mca_workspace=forged"}})),{code:"super_admin_required",status:403})
  assert.equal((await auth.requireSuperAdmin(new Request("https://app.test/api/platform/audit",{headers:{cookie:"mca_workspace=forged"}}))).userId,userId)
  await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(),userId)
  await assert.rejects(auth.requireSuperAdmin(),{code:"platform_admin_required",status:403})
  await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?").run(userId)
})
test("Ben lacks SMS approver capability; step-up is session-bound and expires",async()=>{
  const actor=await auth.requireSuperAdmin()
  auth.requireSmsApprover(actor)
  assert.throws(()=>auth.requireSmsApprover({...actor,email:"ben@sentineltechsolutions.io"}),{code:"sms_approver_required",status:403})
  await assert.rejects(stepUp.requirePlatformStepUp(actor),{code:"step_up_required",status:403})
  await getDatabase().prepare("INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)").run(sessionId,userId,"2000-01-01T00:00:00.000Z")
  await assert.rejects(stepUp.requirePlatformStepUp(actor),{code:"step_up_required",status:403})
  await getDatabase().prepare("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?").run(nowIso(),sessionId)
  assert.ok(await stepUp.requirePlatformStepUp(actor))
  await assert.rejects(stepUp.requirePlatformStepUp({...actor,sessionId:randomUUID()}),{code:"step_up_required",status:403})
  assert.throws(()=>audit.assertStrictPlatformMutation(new Request("https://app.test/api/platform/step-up",{method:"POST"})),{code:"untrusted_origin",status:403})
})
test("one audit row commits with an action; an audit failure rolls state back; rows are append-only",async()=>{
  const actor=await auth.requireSuperAdmin()
  const before=(await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='test.rename'").get())!.n
  await audit.withSuperAdminAction({actor,action:"test.rename"},async db=>{await db.prepare("UPDATE users SET name='Renamed' WHERE id=?").run(userId)})
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='test.rename'").get())!.n,before+1)
  await assert.rejects(audit.withSuperAdminAction({actor,action:"test.bad_audit",workspaceId:randomUUID()},async db=>{await db.prepare("UPDATE users SET name='Should rollback' WHERE id=?").run(userId)}))
  assert.equal((await getDatabase().prepare<{name:string}>("SELECT name FROM users WHERE id=?").get(userId))!.name,"Renamed")
  const row=await getDatabase().prepare<{id:string}>("SELECT id FROM platform_admin_audit WHERE action='test.rename'").get()
  await assert.rejects(getDatabase().prepare("UPDATE platform_admin_audit SET action='changed' WHERE id=?").run(row!.id),/append-only/)
  await assert.rejects(getDatabase().prepare("DELETE FROM platform_admin_audit WHERE id=?").run(row!.id),/append-only/)
  await audit.recordFirstSuperAdminAccess(actor);await audit.recordFirstSuperAdminAccess(actor)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='super_admin.first_access' AND actor_user_id=?").get(userId))!.n,1)
})

test("legacy SMS approve/reject require Michael capability and a fresh step-up; a rejection is audited once",async()=>{
  const workspaceId=randomUUID(),stamp=nowIso()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(workspaceId,"Synthetic review","America/New_York",1,"{}","{}","{}",stamp,stamp)
  await getDatabase().prepare("INSERT INTO sms_companies(workspace_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?)").run(workspaceId,userId,stamp,stamp)
  const input={workspaceId,decision:"rejected" as const,note:"Synthetic review reason",numberLimit:1,monthlyLimitCents:100,registrationLimitCents:100}
  email="ben@sentineltechsolutions.io"
  await assert.rejects(sms.reviewCompany(null,input),{code:"sms_approver_required",status:403})
  await assert.rejects(sms.reviewCompany(null,{...input,decision:"approved"}),{code:"sms_approver_required",status:403})
  email="mike@sentineltechsolutions.io"
  await getDatabase().prepare("DELETE FROM platform_step_ups WHERE session_id=?").run(sessionId)
  await assert.rejects(sms.reviewCompany(null,input),{code:"step_up_required",status:403})
  await getDatabase().prepare("INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)").run(sessionId,userId,"2000-01-01T00:00:00.000Z")
  await assert.rejects(sms.reviewCompany(null,input),{code:"step_up_required",status:403})
  await getDatabase().prepare("UPDATE platform_step_ups SET verified_at=? WHERE session_id=?").run(nowIso(),sessionId)
  assert.deepEqual(await sms.reviewCompany(null,input),{updated:true})
  const rows=await getDatabase().prepare<{action:string}>("SELECT action FROM platform_admin_audit WHERE action='sms.rejected' AND target_workspace_id=?").all(workspaceId)
  assert.equal(rows.length,1)
  const mirror=await getDatabase().prepare<{metadata:string}>("SELECT metadata FROM audit_events WHERE workspace_id=? AND action='company.rejected'").get(workspaceId)
  assert.ok(mirror)
  assert.doesNotMatch(String(mirror.metadata),/Synthetic review reason/)
})
test("step-up consumes only a fresh app TOTP; recovery-shaped codes fail and attempts are audited",async()=>{
  const {encryptUserSecret}=await import("../src/lib/mca/crypto")
  const {generateTotpSecret,generateTotpCode}=await import("../src/lib/mca/totp")
  const secret=generateTotpSecret(),stamp=nowIso(),actor=await auth.requireSuperAdmin()
  await getDatabase().prepare(`INSERT INTO user_totp_factors(user_id,status,secret_cipher,last_used_counter,confirmed_at,created_at,updated_at)
    VALUES (?,'enabled',?,NULL,?,?,?)`).run(userId,encryptUserSecret(secret,userId),stamp,stamp,stamp)
  await getDatabase().prepare("DELETE FROM platform_step_ups WHERE session_id=?").run(sessionId)
  const request=new Request("https://app.test/api/platform/step-up",{method:"POST",headers:{origin:"https://app.test"}})
  await assert.rejects(stepUp.completePlatformStepUp(actor,"ABCD-EF01-2345-6789",request),{code:"totp_verification_failed",status:400})
  await assert.rejects(stepUp.requirePlatformStepUp(actor),{code:"step_up_required",status:403})
  const code=generateTotpCode(secret)
  await stepUp.completePlatformStepUp(actor,code,request)
  assert.ok(await stepUp.requirePlatformStepUp(actor))
  await assert.rejects(stepUp.completePlatformStepUp(actor,code,request),{code:"totp_verification_failed",status:400})
  const counts=await getDatabase().prepare<{action:string;n:number}>("SELECT action,count(*)::int n FROM platform_admin_audit WHERE action LIKE 'super_admin.step_up_%' GROUP BY action").all()
  assert.equal(counts.find(row=>row.action==="super_admin.step_up_succeeded")?.n,1)
  assert.equal(counts.find(row=>row.action==="super_admin.step_up_failed")?.n,2)
})
test("audit CSV export requires Origin and step-up, escapes formulas, and writes one audit row",async()=>{
  const actor=await auth.requireSuperAdmin()
  await assert.rejects(audit.listSuperAdminActions({from:"not-a-date"}),{code:"invalid_query",status:422})
  await audit.withSuperAdminAction({actor,action:"test.csv",reason:"=1+1"},async()=>undefined)
  const {POST}=await import("../src/app/api/platform/audit/export/route")
  const request=(origin?:string)=>new Request("https://app.test/api/platform/audit/export",{method:"POST",headers:origin?{origin}:undefined,body:new FormData()})
  assert.equal((await POST(request())).status,403)
  await getDatabase().prepare("DELETE FROM platform_step_ups WHERE session_id=?").run(sessionId)
  const missing=await POST(request("https://app.test"))
  assert.equal(missing.status,403);assert.equal((await missing.json()).error.code,"step_up_required")
  await getDatabase().prepare("INSERT INTO platform_step_ups(session_id,user_id,verified_at) VALUES (?,?,?)").run(sessionId,userId,nowIso())
  const response=await POST(request("https://app.test"))
  assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store")
  assert.match(await response.text(),/"'=1\+1"/)
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='super_admin.audit_export'").get())!.n,1)
})
test("a platform access mutation commits one audit row and rolls back when its audit insert fails",async()=>{
  const actor=await auth.requireSuperAdmin(),workspaceId=randomUUID(),stamp=nowIso()
  await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(workspaceId,"Synthetic support","America/New_York",1,"{}","{}","{}",stamp,stamp)
  const {platformMutation}=await import("../src/lib/mca/platform-console")
  const input={action:"access" as const,manualPaused:true,reason:"Synthetic support pause"}
  await audit.withSuperAdminAction({actor,action:"platform.access",workspaceId,targetType:"workspace",targetId:workspaceId,reason:input.reason},async()=>platformMutation(workspaceId,actor.userId,input))
  assert.equal((await getDatabase().prepare<{n:number}>("SELECT count(*)::int n FROM platform_admin_audit WHERE action='platform.access' AND target_workspace_id=?").get(workspaceId))!.n,1)
  assert.equal((await getDatabase().prepare<{manual_paused:number}>("SELECT manual_paused FROM company_subscription_state WHERE workspace_id=?").get(workspaceId))!.manual_paused,1)
  await assert.rejects(audit.withSuperAdminAction({actor,action:"platform.access",workspaceId:randomUUID()},async()=>platformMutation(workspaceId,actor.userId,{action:"access",manualPaused:false,reason:"Synthetic resume"})))
  assert.equal((await getDatabase().prepare<{manual_paused:number}>("SELECT manual_paused FROM company_subscription_state WHERE workspace_id=?").get(workspaceId))!.manual_paused,1)
})
test("every platform and legacy operator handler rejects each disallowed identity before feature or body checks",async()=>{
  const {pathToFileURL}=await import("node:url")
  const {resolve}=await import("node:path")
  const files=[...paths("src/app/api/platform"),...paths("src/app/api/mca/sms/operator")].filter(path=>path.endsWith("/route.ts"))
  const handlers=await Promise.all(files.map(async file=>({file,mod:await import(pathToFileURL(resolve(file)).href)})))
  const request=(method:string,apiKey=false)=>new Request("https://app.test/api/platform/check",{method,headers:{origin:"https://app.test",cookie:"mca_workspace=forged",...(apiKey?{authorization:"Bearer mca_test"}:{})},...(method==="GET"?{}:{body:"{}"})})
  const check=async(status:number,code:string,apiKey=false)=>{
    for(const {file,mod} of handlers)for(const method of ["GET","POST","PUT","PATCH","DELETE"] as const){
      const handler=mod[method] as ((request:Request,context:{params:Promise<{id:string}>})=>Promise<Response>)|undefined
      if(!handler)continue
      const response=await handler(request(method,apiKey),{params:Promise.resolve({id:randomUUID()})})
      assert.equal(response.status,status,`${file} ${method}`)
      assert.equal((await response.json()).error.code,code,`${file} ${method}`)
    }
  }
  try {
    signedIn=false;await check(401,"authentication_required")
    signedIn=true
    await getDatabase().prepare("DELETE FROM platform_admin_grants WHERE user_id=?").run(userId)
    await check(403,"platform_admin_required")
    await getDatabase().prepare("INSERT INTO platform_admin_grants(user_id,granted_at,granted_by,reason) VALUES (?,?,?,?)").run(userId,nowIso(),"trusted-operator","Reviewed")
    aal="aal1";await check(403,"mfa_required")
    aal="aal2";email="outside@example.test";await check(403,"super_admin_required")
    email="mike@sentineltechsolutions.io";confirmed=false;await check(403,"super_admin_required")
    confirmed=true;await check(403,"super_admin_required",true)
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=? WHERE user_id=?").run(nowIso(),userId)
    await check(403,"platform_admin_required")
  } finally {
    signedIn=true;confirmed=true;aal="aal2";email="mike@sentineltechsolutions.io";claimSession=sessionId
    await getDatabase().prepare("UPDATE platform_admin_grants SET revoked_at=NULL WHERE user_id=?").run(userId)
  }
})
