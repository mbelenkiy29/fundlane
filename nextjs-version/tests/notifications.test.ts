import './helpers/business-auth'
import test, {before, after, beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createPostgresTestDatabase} from './helpers/postgres-test-db.mjs'
import {getDatabase,closeDatabaseForTests} from '../src/lib/mca/db'
import {createDeal} from '../src/lib/mca/deals/service'
import type {DealActor} from '../src/lib/mca/deals/schema'
import {enqueueNotification,getNotification,setNotificationPolicy,setNotificationConsent,suppressNotificationRecipient} from '../src/lib/mca/notifications/service'

let cluster: Awaited<ReturnType<typeof createPostgresTestDatabase>>
let dealId:string
const actor = (workspaceId='notify-a'):DealActor => ({workspaceId,userId:`${workspaceId}-user`,membershipId:`${workspaceId}-member`,role:'admin',source:'user',managedMembershipIds:[],activeMembershipIds:[`${workspaceId}-member`],correlationId:'notification-test'})
const now='2026-10-01T00:00:00.000Z'
const event = (eventKey:string) => ({eventKey,kind:'document' as const,dealId,audience:'broker' as const,channel:'email' as const,recipientUserId:'notify-a-user',scheduledFor:now,approvedAt:now,payload:{title:'Documents due',message:'Review requested documents.'}})
before(async()=>{
 cluster=await createPostgresTestDatabase('notifications');Object.assign(process.env,cluster.env())
 const db=getDatabase()
 for(const workspace of ['notify-a','notify-b']){
 await db.prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',8,'{"integrations":true}','{"deals":true,"integrations":true}','{"createDeal":true}',?,?)`).run(workspace,workspace,now,now)
 await db.prepare(`INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,? ,?,?,?)`).run(`${workspace}-user`,`${workspace}@example.test`,workspace,workspace,now,now)
 await db.prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'admin','active',?,?)`).run(`${workspace}-member`,workspace,`${workspace}-user`,now,now)
 }
 dealId=(await createDeal(actor(),{idempotencyKey:'notification-deal',legalName:'Synthetic Notification LLC',contactEmail:'merchant@example.test',contactPhone:'+15551234567',owners:[{firstName:'Pat',lastName:'Test',isPrimary:true}],assignments:[{membershipId:'notify-a-member',kind:'originator',isPrimary:true}]})).deal.id
})
beforeEach(async()=>{await getDatabase().prepare('DELETE FROM mca_notification_preferences').run();await getDatabase().prepare('DELETE FROM mca_notification_policies').run()})
after(async()=>{await closeDatabaseForTests();await cluster?.close()})
test('tenant references, broker recipient membership and reads are scoped',async()=>{
 await assert.rejects(enqueueNotification(actor('notify-b'),event('foreign-deal')))
 await assert.rejects(enqueueNotification(actor(),{...event('foreign-member'),recipientUserId:'notify-b-user'}))
 const row=await enqueueNotification(actor(),event('tenant-read'))
 await assert.rejects(getNotification(actor('notify-b'),row.id))
})
test('duplicate events deduplicate under concurrency and reject changed content',async()=>{
 const rows=await Promise.all(Array.from({length:8},()=>enqueueNotification(actor(),event('dedup'))))
 assert.equal(new Set(rows.map(row=>row.id)).size,1)
 await assert.rejects(enqueueNotification(actor(),{...event('dedup'),payload:{title:'Changed',message:'Changed'}}),/different/)
})
test('merchant policy and explicit email consent both default off',async()=>{
 const input={...event('merchant-disabled'),audience:'merchant' as const,recipientUserId:undefined,templateId:'not-a-template',payload:undefined}
 await assert.rejects(enqueueNotification(actor(),input),/enabled/)
 await setNotificationPolicy(actor(),{kind:'document',merchantEnabled:true,brokerEnabled:true})
 await assert.rejects(enqueueNotification(actor(),{...input,eventKey:'no-consent'}),/consent/)
 await setNotificationConsent(actor(),{dealId,channel:'email',enabled:true})
 await assert.rejects(enqueueNotification(actor(),{...input,eventKey:'wrong-template'}),/template/)
 await setNotificationPolicy(actor(),{kind:'document',merchantEnabled:false,brokerEnabled:true})
})
test('suppression prevents broker disclosure and admin settings reject reps',async()=>{
 await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id='notify-a-member'").run()
 await assert.rejects(setNotificationPolicy(actor(),{kind:'renewal',merchantEnabled:true,brokerEnabled:true}))
 await getDatabase().prepare("UPDATE memberships SET role='admin' WHERE id='notify-a-member'").run()
 await suppressNotificationRecipient(actor(),{dealId,channel:'email',audience:'broker',recipientUserId:'notify-a-user'})
 await assert.rejects(enqueueNotification(actor(),event('suppressed')),/suppressed/)
})
