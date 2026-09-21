import "./helpers/business-auth"
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { createPostgresTestDatabase } from "./helpers/postgres-test-db.mjs"
import { closeDatabaseForTests, getDatabase, newId } from "../src/lib/mca/db"
import { actorForDeals } from "../src/lib/mca/deals/service"
import { ingestApplication } from "../src/lib/mca/intake/service"
import { syncApplicationNotifications, listApplicationNotifications, markApplicationNotificationRead } from "../src/lib/mca/intake/notifications"
import { getApplicationReview, protectIntakeAnswers } from "../src/lib/mca/intake/review"
import { hashOpaqueToken } from "../src/lib/mca/crypto"
import { GET as reviewGet } from "../src/app/api/mca/intake/[intakeId]/review/route"
import { POST as previewPost } from "../src/app/api/mca/intake/[intakeId]/review/preview/route"
import { POST as sendPost } from "../src/app/api/mca/intake/[intakeId]/review/send/route"
import { GET as noticesGet } from "../src/app/api/mca/intake/notifications/route"
import type { DealActor } from "../src/lib/mca/deals/schema"
let database: Awaited<ReturnType<typeof createPostgresTestDatabase>>
const workspaceId = newId(), adminId = newId(), repId = newId(), otherId = newId()
const adminMember = newId(), repMember = newId(), otherMember = newId()
let admin: DealActor, rep: DealActor, other: DealActor
before(async () => {
  database = await createPostgresTestDatabase("application_review")
  Object.assign(process.env, database.env())
  const db = getDatabase(), now = new Date().toISOString()
  await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES (?, 'Review', 'UTC', 10, '{}', '{"deals":true}', '{"createDeal":true}', ?, ?)`).run(workspaceId, now, now)
  for (const [id, membership, role] of [[adminId,adminMember,"admin"],[repId,repMember,"rep"],[otherId,otherMember,"rep"]]) {
    await db.prepare(`INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(id, `${id}@example.test`, role, id, now, now)
    await db.prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)`).run(membership,workspaceId,id,role,now,now)
  }
  const actor = (userId:string,membershipId:string,role:"admin"|"rep") => actorForDeals({authType:"session",userId,membershipId,role,workspaceId,sessionId:"fixture",scopes:[]})
  admin=await actor(adminId,adminMember,"admin");rep=await actor(repId,repMember,"rep");other=await actor(otherId,otherMember,"rep")
})
after(async () => { await closeDatabaseForTests(); await database?.close() })
async function application(assigned = true) {
  const result=await ingestApplication(admin, {schemaVersion:1,provider:"custom",eventId:newId(),application:{legalName:"Review Bakery",monthlyRevenue:0,requestedAmount:25000,...(assigned?{assignments:[{membershipId:repMember,kind:"originator" as const,isPrimary:true}]}:{})}, answers:[{key:"custom",label:"How will you use funding?",value:"New ovens"},{key:"ein",label:"EIN",value:"123456789"}]})
  if(!assigned) await getDatabase().prepare("DELETE FROM deal_assignments WHERE deal_id=?").run(result.dealId)
  return result
}
test("original answers retained privately, historical fields explicit, unauthorized review denied", async () => {
  const item=await application()
  const review=await getApplicationReview(rep,item.intakeId)
  assert.equal(review.originalAnswersAvailable,true)
  assert.equal(review.answers.find(a=>a.key==="custom")?.value,"New ovens")
  assert.notEqual(review.answers.find(a=>a.key==="ein")?.value,"123456789")
  assert.equal(review.summary.reportedMonthlyRevenue,0)
  assert.equal(review.summary.statementMonthlyRevenue,null)
  assert.equal(review.canPrepare,false)
  await assert.rejects(()=>getApplicationReview(other,item.intakeId),{code:"deal_not_found"})
  await assert.rejects(()=>getApplicationReview({...admin,workspaceId:newId()},item.intakeId),{code:"intake_not_found"})
  await getDatabase().prepare("UPDATE intake_events SET answers_cipher=NULL WHERE id=?").run(item.intakeId)
  const legacy=await getApplicationReview(rep,item.intakeId)
  assert.equal(legacy.originalAnswersAvailable,false)
  assert.ok(legacy.answers.some(a=>a.value==="Review Bakery"))
})
test("one durable notice per recipient; mark read checks ownership", async () => {
  const item=await application()
  await Promise.all([syncApplicationNotifications(workspaceId,item.intakeId),syncApplicationNotifications(workspaceId,item.intakeId)])
  const notices=(await listApplicationNotifications(rep)).notifications.filter(n=>n.intakeId===item.intakeId)
  assert.equal(notices.length,1)
  assert.equal(notices[0].readAt,null)
  assert.equal((await listApplicationNotifications(admin)).notifications.some(n=>n.intakeId===item.intakeId),false)
  await assert.rejects(()=>markApplicationNotificationRead(other,notices[0].id),{code:"notification_not_found"})
  await markApplicationNotificationRead(rep,notices[0].id)
  assert.ok((await listApplicationNotifications(rep)).notifications.find(n=>n.id===notices[0].id)?.readAt)
})
test("assignment changes remove former recipient access and notify current rep; unassigned falls back to admins",async()=>{
  const item=await application(false)
  await syncApplicationNotifications(workspaceId,item.intakeId)
  assert.ok((await listApplicationNotifications(admin)).notifications.find(n=>n.intakeId===item.intakeId))
  await getDatabase().prepare(`INSERT INTO deal_assignments(id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES (?,?,?,?,'originator',1,?)`).run(newId(),workspaceId,item.dealId,repMember,new Date().toISOString())
  assert.ok((await listApplicationNotifications(rep)).notifications.find(n=>n.intakeId===item.intakeId))
  assert.equal((await listApplicationNotifications(admin)).notifications.some(n=>n.intakeId===item.intakeId),false)
  await getDatabase().prepare("UPDATE deal_assignments SET membership_id=? WHERE deal_id=?").run(otherMember,item.dealId)
  assert.equal((await listApplicationNotifications(rep)).notifications.some(n=>n.intakeId===item.intakeId),false)
  assert.ok((await listApplicationNotifications(other)).notifications.find(n=>n.intakeId===item.intakeId))
})
test("sensitive answer fields and nested identity values stay masked",()=>{
  const protectedAnswers=protectIntakeAnswers([{key:"owner",label:"Owner",value:JSON.stringify({name:"A",ssn:"123-45-6789",dateOfBirth:"1980-01-01"})},{key:"tax_id",label:"Tax identifier",value:"123456789"},{key:"website",label:"Website",value:"https://example.test"}])
  const text=JSON.stringify(protectedAnswers)
  assert.ok(!text.includes("123-45-6789"));assert.ok(!text.includes("1980-01-01"));assert.ok(!text.includes("123456789"));assert.ok(text.includes("https://example.test"))
})

test("review HTTP enforces authentication, page visibility, origin and JSON boundaries",async()=>{
  const item=await application()
  const url=`https://mca.example.test/api/mca/intake/${item.intakeId}/review`
  const context={params:Promise.resolve({intakeId:item.intakeId})}
  assert.equal((await reviewGet(new Request(url),context)).status,401)
  assert.equal((await sendPost(new Request(url+"/send",{method:"POST",headers:{origin:"https://foreign.example.test"},body:"{}"}),context)).status,403)
  const token="review-http-fixture",now=new Date().toISOString()
  await getDatabase().prepare(`INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?,?)`).run(newId(),repId,repMember,hashOpaqueToken(token),new Date(Date.now()+3600000).toISOString(),now,now)
  const headers={cookie:`mca_session=${token}`}
  assert.equal((await reviewGet(new Request(url,{headers}),context)).status,200)
  assert.equal((await previewPost(new Request(url+"/preview",{method:"POST",headers,body:"null"}),context)).status,400)
  await getDatabase().prepare(`UPDATE workspaces SET page_visibility='{"deals":false}' WHERE id=?`).run(workspaceId)
  try {
    assert.equal((await reviewGet(new Request(url,{headers}),context)).status,403)
    assert.equal((await noticesGet(new Request("https://mca.example.test/api/mca/intake/notifications",{headers}))).status,403)
  } finally { await getDatabase().prepare(`UPDATE workspaces SET page_visibility='{"deals":true}' WHERE id=?`).run(workspaceId) }
})

 test("camelCase, opaque provider mappings and owner contact labels are protected",()=>{
  const answers=protectIntakeAnswers([
    {key:"businessEin",label:"Business identifier",value:"secret-ein"},
    {key:"ownerSsn",label:"Owner identifier",value:"secret-ssn"},
    {key:"q123",label:"Question 123",value:"secret-mapped"},
    {key:"q124",label:"Owner email",value:"secret-email"},
    {key:"oldQuestion",label:"Old question",value:"secret-old-mapping"},
    {key:"group",label:"Group",value:JSON.stringify({q125:"secret-nested",ordinary:"visible"})},
  ],{ein:"q123","owners.0.dateOfBirth":"group.q125"},{ein:"secret-old-mapping"})
  assert.ok(!JSON.stringify(answers).includes("secret-"))
  assert.ok(JSON.stringify(answers).includes("visible"))
})
