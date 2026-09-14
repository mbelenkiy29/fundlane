import "./helpers/business-auth"
import test,{before,after,beforeEach} from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { getDatabase,closeDatabaseForTests,nowIso } from "../src/lib/mca/db"
import { encryptSensitive,hashOpaqueToken } from "../src/lib/mca/crypto"
import { actorForDeals,createDeal } from "../src/lib/mca/deals/service"
import type { DealActor } from "../src/lib/mca/deals/schema"
import type { Role } from "../src/lib/mca/types"
import { activitySchema,localToIso,type ActivityInput } from "../src/lib/mca/calendar/contracts"
import { calendarFeed,saveActivity,projectFollowups } from "../src/lib/mca/calendar/service"
import { beginGoogleAuthorization,finishGoogleAuthorization,changeGoogleConnection,connectionFor,googleConnectionView,receiveGoogleNotification,setCalendarFetchForTests,GOOGLE_CALENDAR_SCOPES,type GoogleEvent } from "../src/lib/mca/calendar/google"
import { syncConnection,resolveCalendarConflict,stableEventId,syncDecision } from "../src/lib/mca/calendar/sync"
import { GET as getCalendar,POST as postCalendar } from "../src/app/api/mca/calendar/route"

let database:Awaited<ReturnType<typeof createPostgresTestDatabase>>
let admin:DealActor,rep:DealActor,otherRep:DealActor,manager:DealActor,outsider:DealActor,dealId:string,otherDealId:string
let remote=new Map<string,GoogleEvent>(),calendars:{id:string;summary:string;description?:string;primary?:boolean}[]=[]
let inserts=0,etag=0,failList=0,invalidToken=false,oauthRefreshes=0,unauthorized=false,etagRace=false
function stamp(event:GoogleEvent) {return {...event,etag:`"${++etag}"`}}
const parseBody=(init?:RequestInit)=>JSON.parse(String(init?.body??"{}"))
const response=(data:unknown,status=200)=>new Response(status===204?null:JSON.stringify(data),{status,headers:{"content-type":"application/json"}})
const fakeFetch:typeof fetch=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??"GET"
  if(url.pathname==="/token") {
    const form=new URLSearchParams(String(init?.body));if(form.get("grant_type")==="refresh_token")oauthRefreshes++
    return response({access_token:"access-secret",refresh_token:"refresh-secret",expires_in:3600,scope:GOOGLE_CALENDAR_SCOPES.join(" ")})
  }
  if(url.pathname.endsWith("/userinfo")) return response({email:"calendar@example.test",verified_email:true})
  if(unauthorized)return response({},401)
  const path=decodeURIComponent(url.pathname.replace("/calendar/v3",""))
  if(path==="/users/me/calendarList")return response({items:calendars})
  if(path==="/calendars"&&method==="POST") {const body=parseBody(init),cal={id:"fundlane",summary:"Fundlane",description:body.description};calendars.push(cal);return response(cal)}
  if(path.endsWith("/watch"))return response({id:parseBody(init).id,resourceId:"resource",expiration:String(Date.now()+604800000)})
  if(path==="/channels/stop")return response(null,204)
  const match=path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
  assert.ok(match,`Unexpected Google request ${method} ${path}`)
  const [,cal,id]=match
  if(!id && method==="GET") {
    if(failList>0){failList--;return response({},503)}
    if(invalidToken&&cal==="primary"&&url.searchParams.has("syncToken")){invalidToken=false;return response({},410)}
    const items=[...remote.entries()].filter(([key])=>key.startsWith(cal+":")).map(([,event])=>event)
    // Exercise full/incremental pagination before committing the final token.
    return response(url.searchParams.has("pageToken")?{items:items.slice(1),nextSyncToken:"sync-token"}:items.length>1?{items:items.slice(0,1),nextPageToken:"second"}:{items,nextSyncToken:"sync-token"})
  }
  if(!id&&method==="POST") {const body=parseBody(init),key=cal+":"+body.id;if(remote.has(key))return response({},409);inserts++;const saved=stamp(body);remote.set(key,saved);return response(saved)}
  const key=cal+":"+id,current=remote.get(key)
  if(!current)return response({},404)
  if(method==="GET")return response(current)
  const matchTag=new Headers(init?.headers).get("if-match")
  if(matchTag&&matchTag!==current.etag)return response({},412)
  if(method==="DELETE"){remote.set(key,stamp({...current,status:"cancelled"}));return response(null,204)}
  if(method==="PATCH"&&etagRace){etagRace=false;remote.set(key,stamp({...current,summary:"Concurrent remote edit"}));return response({},412)}
  if(method==="PATCH"){const saved=stamp({...current,...parseBody(init)});remote.set(key,saved);return response(saved)}
  throw new Error(`Unexpected Google operation ${method}`)
}
function input(overrides:Partial<ActivityInput>={}):ActivityInput {return {dealId,assigneeId:"rep",kind:"call",title:"Discuss funding",start:"2026-10-05T14:00:00.000Z",end:"2026-10-05T14:30:00.000Z",allDay:false,timezone:"America/New_York",notes:"Private underwriting note",status:"scheduled",...overrides}}
function query(scope="mine"){return new URLSearchParams({from:"2026-10-01T00:00:00Z",to:"2026-11-01T00:00:00Z",scope})}
async function connect(actor=rep) {
  const url=new URL(await beginGoogleAuthorization(actor))
  assert.equal(url.searchParams.get("code_challenge_method"),"S256")
  await finishGoogleAuthorization(actor,url.searchParams.get("state")!,"test-code")
  return (await connectionFor(actor))!
}
async function update(activityId:string,overrides:Partial<ActivityInput>={}) {
  const row=await getDatabase().prepare<{version:number}>("SELECT version FROM mca_calendar_activities WHERE id=?").get(activityId)
  return saveActivity(admin,input({...overrides,version:row!.version}),activityId)
}
before(async()=>{
  database=await createPostgresTestDatabase("calendar")
  Object.assign(process.env,database.env(),{MCA_CALENDAR_GOOGLE_ENABLED:"true",GOOGLE_CALENDAR_CLIENT_ID:"test-client",GOOGLE_CALENDAR_CLIENT_SECRET:"test-secret",MCA_APP_ORIGIN:"https://fundlane.example.test"})
  const db=getDatabase(),now=nowIso(),pages=JSON.stringify({dashboard:true,deals:true,users:true,reports:true,payments:true,workspace:true,integrations:true}),actions=JSON.stringify({createDeal:true,exportDeals:true,inviteUsers:true,manageApiKeys:true,viewPaymentTable:true,viewCompanyFinancials:true}),flags=JSON.stringify({reports:true,payments:true,integrations:true})
  for(const id of ["workspace","outside"]) await db.prepare("INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?,?,'America/New_York',20,?,?,?,?,?)").run(id,id,flags,pages,actions,now,now)
  for(const [id,role,ws,managerId] of [["admin","admin","workspace",null],["manager","manager","workspace",null],["rep","rep","workspace","manager"],["other","rep","workspace",null],["outside","admin","outside",null]] as const){
    await db.prepare("INSERT INTO users (id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id,id+"@example.test",id,id,now,now)
    await db.prepare("INSERT INTO memberships (id,workspace_id,user_id,role,manager_membership_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?)").run(id,ws,id,role,managerId,now,now)
    await db.prepare("INSERT INTO sessions (id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,'2099-01-01',?,?)").run(id,id,id,hashOpaqueToken(id),now,now)
  }
  async function actor(id:string,role:Role,ws="workspace"){return actorForDeals({authType:"session",userId:id,membershipId:id,workspaceId:ws,role,scopes:[],sessionId:id})}
  admin=await actor("admin","admin");rep=await actor("rep","rep");otherRep=await actor("other","rep");manager=await actor("manager","manager");outsider=await actor("outside","admin","outside")
  dealId=(await createDeal(admin,{legalName:"Calendar Merchant",idempotencyKey:"calendar-deal",assignments:[{membershipId:"rep",kind:"originator",isPrimary:true}]})).deal.id
  otherDealId=(await createDeal(admin,{legalName:"Other Merchant",idempotencyKey:"other-deal",assignments:[{membershipId:"other",kind:"originator",isPrimary:true}]})).deal.id
})
beforeEach(async()=>{
  const db=getDatabase()
  await db.prepare("DELETE FROM mca_calendar_connections").run()
  await db.prepare("DELETE FROM mca_calendar_activities").run()
  await db.prepare("DELETE FROM mca_calendar_oauth_states").run()
  remote=new Map();calendars=[{id:"primary",summary:"Private calendar",primary:true}];inserts=0;etag=0;failList=0;invalidToken=false;oauthRefreshes=0;unauthorized=false;etagRace=false
  setCalendarFetchForTests(fakeFetch)
})
after(async()=>{setCalendarFetchForTests();await closeDatabaseForTests();await database?.close()})

test("date validation, DST gaps, all-day exclusive end, weekly and monthly recurrence",()=>{
  assert.equal(localToIso("2026-03-08T02:30","America/New_York"),undefined)
  assert.equal(localToIso("2026-03-08T03:30","America/New_York"),"2026-03-08T07:30:00.000Z")
  assert.ok(localToIso("2026-11-01T01:30","America/New_York"))
  assert.equal(localToIso("2026-11-01T01:30","America/New_York","2026-11-01T06:30:00.000Z"),"2026-11-01T06:30:00.000Z")
  assert.equal(activitySchema.safeParse(input({start:"2026-02-30",end:"2026-03-01",allDay:true})).success,false)
  assert.equal(activitySchema.safeParse(input({start:"2026-10-05",end:"2026-10-06",allDay:true})).success,true)
  assert.equal(activitySchema.safeParse(input({end:"2026-10-05T13:00:00Z"})).success,false)
  const monthly=projectFollowups({timezone:"America/New_York",frequency:"monthly",dayOfMonth:31,hour:9,minute:0},"2026-02-01T00:00:00Z","2026-03-01T00:00:00Z")
  assert.equal(monthly.length,1);assert.equal(monthly[0].localDate,"2026-02-28")
  const dst=projectFollowups({timezone:"America/New_York",frequency:"daily",hour:2,minute:30},"2026-03-07T00:00:00Z","2026-03-10T00:00:00Z")
  assert.equal(dst.length,2)
  assert.equal(syncDecision(true,true,false),"conflict")
  assert.match(stableEventId("c","a"),/^[0-9a-v]{5,1024}$/)
})
test("calendar access follows workspace, deal, assignment and manager permissions",async()=>{
  const activity=await saveActivity(admin,input())
  assert.equal((await calendarFeed(rep,query())).events.length,1)
  assert.equal((await calendarFeed(otherRep,query())).events.length,0)
  assert.equal((await calendarFeed(otherRep,query())).deals[0].id,otherDealId)
  assert.equal((await calendarFeed(admin,query())).events.length,0)
  assert.equal((await calendarFeed(manager,query("team"))).events.length,1)
  assert.equal((await calendarFeed(outsider,query("team"))).events.length,0)
  await assert.rejects(calendarFeed(rep,query("team")),/manager/)
  await assert.rejects(saveActivity(otherRep,input({version:1}),activity.id),/not found/)
  await assert.rejects(saveActivity(admin,input({assigneeId:"other"})),/not found/)
  await assert.rejects(saveActivity(rep,input({version:0}),activity.id),/Check/)
  await update(activity.id,{status:"completed"})
  await assert.rejects(saveActivity(rep,input({version:1}),activity.id),/changed/)
  assert.equal((await calendarFeed(rep,query())).events[0].status,"completed")
})
test("HTTP handlers reject unauthenticated, cross-origin, and disabled-page access",async()=>{
  assert.equal((await getCalendar(new Request("https://fundlane.example.test/api/mca/calendar?"+query()))).status,401)
  const req=(origin:string)=>new Request("https://fundlane.example.test/api/mca/calendar",{method:"POST",headers:{origin,cookie:"mca_session=rep","content-type":"application/json"},body:JSON.stringify(input())})
  assert.equal((await postCalendar(req("https://attacker.test"))).status,403)
  assert.equal((await postCalendar(req("https://fundlane.example.test"))).status,201)
  await getDatabase().prepare("UPDATE workspaces SET page_visibility=jsonb_set(page_visibility::jsonb,'{deals}','false')::text WHERE id='workspace'").run()
  assert.equal((await postCalendar(req("https://fundlane.example.test"))).status,403)
  await getDatabase().prepare("UPDATE workspaces SET page_visibility=jsonb_set(page_visibility::jsonb,'{deals}','true')::text WHERE id='workspace'").run()
})
test("OAuth state is personal, one-time, and never exposes credentials",async()=>{
  const url=new URL(await beginGoogleAuthorization(rep)),state=url.searchParams.get("state")!
  await assert.rejects(finishGoogleAuthorization(otherRep,state,"code"),/expired/)
  await finishGoogleAuthorization(rep,state,"code")
  await assert.rejects(finishGoogleAuthorization(rep,state,"code"),/expired/)
  const view=JSON.stringify(await googleConnectionView(rep))
  assert.ok(!view.includes("secret"));assert.equal((await googleConnectionView(admin)).connected,false)
})
test("Google push, pull, completion, cancellation and restore preserve identity",async()=>{
  const activity=await saveActivity(admin,input()),connection=await connect()
  await syncConnection(connection.id)
  const key="fundlane:"+stableEventId(connection.id,activity.id)
  assert.equal(inserts,1);assert.ok(remote.has(key));assert.ok(!JSON.stringify(remote.get(key)).includes("Private underwriting"))
  await syncConnection(connection.id);assert.equal(inserts,1)
  remote.set(key,stamp({...remote.get(key)!,summary:"Changed in Google",start:{dateTime:"2026-10-05T16:00:00Z",timeZone:"America/New_York"},end:{dateTime:"2026-10-05T16:30:00Z",timeZone:"America/New_York"}}))
  await syncConnection(connection.id)
  let event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.equal(event.title,"Changed in Google");assert.equal(event.start,"2026-10-05T16:00:00.000Z");assert.equal(event.assigneeId,"rep")
  await update(activity.id,{status:"completed"})
  await syncConnection(connection.id)
  assert.equal((await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)?.status,"completed")
  await update(activity.id,{status:"cancelled"});await syncConnection(connection.id)
  assert.equal(remote.get(key)?.status,"cancelled")
  await update(activity.id,{status:"scheduled"});await syncConnection(connection.id)
  assert.equal(inserts,2)
  const active=[...remote.values()].find(e=>e.status!=="cancelled")!
  remote.set("fundlane:"+active.id,stamp({...active,status:"cancelled"}))
  await syncConnection(connection.id)
  event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.equal(event.status,"cancelled")
})
test("simultaneous edits produce a conflict and resolve explicitly",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();await syncConnection(c.id)
  const key="fundlane:"+stableEventId(c.id,activity.id)
  await update(activity.id,{title:"Fundlane edit"})
  remote.set(key,stamp({...remote.get(key)!,summary:"Google edit"}))
  await syncConnection(c.id)
  let event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.ok(event.conflict);assert.equal(event.title,"Fundlane edit")
  await assert.rejects(resolveCalendarConflict(otherRep,activity.id,{choice:"google",version:event.version!,etag:event.conflict.etag}),/Connect/)
  await resolveCalendarConflict(rep,activity.id,{choice:"google",version:event.version!,etag:event.conflict.etag})
  await syncConnection(c.id)
  event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.equal(event.title,"Google edit");assert.equal(event.conflict,undefined)
})
test("a provider success followed by worker rollback does not duplicate calendar or event",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();failList=1
  await syncConnection(c.id);assert.equal((await connectionFor(rep))?.status,"error");assert.equal(inserts,1)
  await syncConnection(c.id);assert.equal(inserts,1);assert.equal(calendars.filter(c=>c.id==="fundlane").length,1)
  assert.ok(remote.has("fundlane:"+stableEventId(c.id,activity.id)))
})
test("private overlays, pagination, token reset, expired token, and disconnect",async()=>{
  const c=await connect()
  remote.set("primary:one",stamp({id:"one",summary:"Private appointment",start:{dateTime:"2026-10-05T10:00:00Z"},end:{dateTime:"2026-10-05T11:00:00Z"}}))
  remote.set("primary:two",stamp({id:"two",summary:"Recurring occurrence",recurringEventId:"series",start:{date:"2026-10-06"},end:{date:"2026-10-07"}}))
  await syncConnection(c.id)
  assert.equal((await calendarFeed(rep,query())).events.filter(e=>e.kind==="google").length,2)
  assert.equal((await calendarFeed(admin,query("team"))).events.filter(e=>e.kind==="google").length,0)
  assert.equal((await calendarFeed(manager,query("team"))).events.filter(e=>e.kind==="google").length,0)
  invalidToken=true;remote.delete("primary:one");await syncConnection(c.id)
  assert.equal((await calendarFeed(rep,query())).events.filter(e=>e.kind==="google").length,1)
  await getDatabase().prepare("UPDATE mca_calendar_connections SET credential_cipher=? WHERE id=?").run(encryptSensitive(JSON.stringify({accessToken:"expired",refreshToken:"refresh-secret",expiresAt:0}),"workspace"),c.id)
  await syncConnection(c.id);assert.equal(oauthRefreshes,1)
  await changeGoogleConnection(rep,{action:"disconnect"})
  assert.equal(await connectionFor(rep),undefined)
  assert.equal((await calendarFeed(rep,query())).events.filter(e=>e.kind==="google").length,0)
})
test("webhook channel authentication and duplicate notifications only schedule reconciliation",async()=>{
  const c=await connect();await syncConnection(c.id)
  await getDatabase().prepare("UPDATE mca_calendar_sources SET channel_id='channel',channel_token_hash=?,resource_id='resource',channel_expires_at='2099-01-01' WHERE connection_id=? AND calendar_id='primary'").run(hashOpaqueToken("secret"),c.id)
  const req=(token:string)=>new Request("https://fundlane.example.test/api/mca/calendar/google/webhook",{method:"POST",headers:{"x-goog-channel-id":"channel","x-goog-channel-token":token,"x-goog-resource-id":"resource"}})
  await assert.rejects(receiveGoogleNotification(req("wrong")),/Invalid/)
  await receiveGoogleNotification(req("secret"));await receiveGoogleNotification(req("secret"))
  assert.ok((await connectionFor(rep))!.next_sync_at<=nowIso())
})
test("reassignment removes the old export and access removal purges the connection",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();await syncConnection(c.id)
  // Admin can access any deal and become the assignee without changing deal ownership.
  await update(activity.id,{assigneeId:"admin"});await syncConnection(c.id)
  assert.equal(remote.get("fundlane:"+stableEventId(c.id,activity.id))?.status,"cancelled")
  assert.equal((await calendarFeed(rep,query())).events.filter(e=>e.id===activity.id).length,0)
  await getDatabase().prepare("UPDATE memberships SET status='deactivated' WHERE id='rep'").run()
  await syncConnection(c.id);assert.equal(await connectionFor(rep),undefined)
  await getDatabase().prepare("UPDATE memberships SET status='active' WHERE id='rep'").run()
})

test("automated projections follow current stages and pauses; stored outcomes replace projections",async()=>{
  const db=getDatabase(),future=new Date(Date.now()+5*86400000).toISOString(),from=future.slice(0,10)+"T00:00:00.000Z",to=new Date(Date.parse(from)+86400000).toISOString()
  await db.prepare("UPDATE deals SET status='missing_documents' WHERE id=?").run(dealId)
  await db.prepare("INSERT INTO mca_followup_policies (id,workspace_id,deal_status,channel,local_schedule,template_id,enabled,created_at,updated_at) VALUES ('calendar-policy','workspace','missing_documents','email',?,'unused',1,?,?)").run(JSON.stringify({timezone:"UTC",frequency:"daily",hour:9,minute:0}),nowIso(),nowIso())
  const params=new URLSearchParams({from,to,scope:"mine"})
  let feed=await calendarFeed(rep,params)
  assert.equal(feed.events.filter(e=>e.kind==="automated_followup").length,1)
  const occurrence=feed.events[0]
  assert.equal(occurrence.editable,false)
  await db.prepare("INSERT INTO mca_followup_occurrences (id,workspace_id,policy_id,deal_id,occurrence_key,state,correlation_id,scheduled_for,created_at,updated_at) VALUES ('calendar-occurrence','workspace','calendar-policy',?,?,'failed','test',?,?,?)").run(dealId,"daily:"+from.slice(0,10),occurrence.start,nowIso(),nowIso())
  feed=await calendarFeed(rep,params)
  assert.equal(feed.events.length,1);assert.equal(feed.events[0].status,"failed")
  await db.prepare("DELETE FROM mca_followup_occurrences WHERE id='calendar-occurrence'").run()
  await db.prepare("UPDATE deals SET status='lead' WHERE id=?").run(dealId)
  assert.equal((await calendarFeed(rep,params)).events.length,0)
  await db.prepare("UPDATE deals SET status='missing_documents' WHERE id=?").run(dealId)
  await db.prepare("UPDATE mca_followup_policies SET enabled=0 WHERE id='calendar-policy'").run()
  assert.equal((await calendarFeed(rep,params)).events.length,0)
  await db.prepare("DELETE FROM mca_followup_policies WHERE id='calendar-policy'").run()
  await db.prepare("UPDATE deals SET status='lead' WHERE id=?").run(dealId)
})
test("submissions use delivery timestamps rather than queue creation and deduplicate attempts",async()=>{
  const db=getDatabase(),now=nowIso()
  await db.prepare("INSERT INTO mca_funders (id,workspace_id,idempotency_key,legal_name,created_at,updated_at) VALUES ('calendar-funder','workspace','calendar-funder','Example Funder',?,?)").run(now,now)
  await db.prepare(`INSERT INTO mca_submission_jobs (id,workspace_id,deal_id,funder_id,display_funder_name,route_kind,route_json,state,confirmation_key,attempt_key,deal_version,document_versions_json,package_json,preflight_errors_json,created_at,updated_at) VALUES ('calendar-job','workspace',?,'calendar-funder','Example Funder','email','{}','sent','calendar-confirm','attempt',1,'[]','[]','[]','2020-01-01',?)`).run(dealId,now)
  await db.prepare(`INSERT INTO mca_submission_attempts (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,created_at) VALUES ('calendar-attempt','workspace','calendar-job','attempt','email','queued','test','2020-01-01')`).run()
  await db.prepare("UPDATE mca_submission_attempts SET state='sent' WHERE id='calendar-attempt'").run()
  const saved=await db.prepare<{sent_at:string}>("SELECT sent_at FROM mca_submission_attempts WHERE id='calendar-attempt'").get()
  assert.ok(saved!.sent_at>=now)
  await db.prepare(`INSERT INTO mca_submission_attempts (id,workspace_id,job_id,attempt_key,transport,state,correlation_id,created_at) VALUES ('calendar-attempt2','workspace','calendar-job','attempt2','email','sent','test','2020-01-01')`).run()
  const params=new URLSearchParams({from:new Date(Date.parse(now)-86400000).toISOString(),to:new Date(Date.parse(now)+86400000).toISOString(),scope:"mine"})
  const sent=(await calendarFeed(rep,params)).events.filter(e=>e.kind==="submission")
  assert.equal(sent.length,1);assert.equal(sent[0].start,saved!.sent_at);assert.equal(sent[0].editable,false)
  assert.equal((await calendarFeed(otherRep,params)).events.filter(e=>e.kind==="submission").length,0)
})
test("a conflict changed again requires a fresh decision, and local resolution restores a single occurrence",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();await syncConnection(c.id)
  const key="fundlane:"+stableEventId(c.id,activity.id)
  await update(activity.id,{title:"Local edit"})
  remote.set(key,stamp({...remote.get(key)!,summary:"Remote edit"}))
  await syncConnection(c.id)
  let event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  await resolveCalendarConflict(rep,activity.id,{choice:"local",version:event.version!,etag:event.conflict!.etag})
  remote.set(key,stamp({...remote.get(key)!,summary:"New remote edit"}))
  await syncConnection(c.id)
  event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.ok(event.conflict?.reason?.includes("changed again"))
  await resolveCalendarConflict(rep,activity.id,{choice:"local",version:event.version!,etag:event.conflict!.etag})
  await syncConnection(c.id)
  assert.equal(remote.get(key)?.summary,"Local edit")
  remote.set(key,stamp({...remote.get(key)!,recurrence:["RRULE:FREQ=WEEKLY"]}))
  await syncConnection(c.id)
  event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.ok(event.conflict?.reason?.includes("unsupported"))
  await resolveCalendarConflict(rep,activity.id,{choice:"local",version:event.version!,etag:event.conflict!.etag})
  await syncConnection(c.id)
  assert.deepEqual(remote.get(key)?.recurrence,[])
})

test("ETag races do not overwrite remote edits, and returning assignment restores one active event",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();await syncConnection(c.id)
  await update(activity.id,{title:"Changed locally"});etagRace=true;await syncConnection(c.id)
  const event=(await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)!
  assert.equal(event.conflict?.title,"Concurrent remote edit")
  assert.equal(event.title,"Changed locally")
  await update(activity.id,{assigneeId:"admin"});await syncConnection(c.id)
  await update(activity.id,{assigneeId:"rep"});await syncConnection(c.id)
  assert.equal([...remote.entries()].filter(([key,e])=>key.startsWith("fundlane:")&&e.status!=="cancelled").length,1)
})
test("revoked Google credentials require reconnect while preserving pipeline activity",async()=>{
  const activity=await saveActivity(admin,input()),c=await connect();await syncConnection(c.id)
  unauthorized=true;await syncConnection(c.id)
  assert.equal((await connectionFor(rep))?.status,"reconnect")
  assert.equal((await calendarFeed(rep,query())).events.find(e=>e.id===activity.id)?.title,"Discuss funding")
  unauthorized=false;const reconnected=await connect();assert.equal(reconnected.id,c.id)
  await syncConnection(c.id)
  assert.equal((await connectionFor(rep))?.status,"connected");assert.equal(inserts,1)
})

test("additive calendar migration can replay without losing scheduled activity",async()=>{
 const activity=await saveActivity(admin,input())
 const migration=readFileSync("drizzle/0034_pipeline_calendar.sql","utf8")
 await database.query(migration)
 await database.query(migration)
 const tables=await database.query("SELECT count(*)::int count FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'mca_calendar_%' AND rowsecurity")
 assert.equal(tables.rows[0].count,6)
 assert.ok((await calendarFeed(admin,query("team"))).events.some(event=>event.id===activity.id))
})
