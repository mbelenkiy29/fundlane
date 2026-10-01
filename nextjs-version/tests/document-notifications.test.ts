import './helpers/business-auth'
import {Client} from 'pg'
import test,{before,after,beforeEach} from 'node:test'
import assert from 'node:assert/strict'
import {createPostgresTestDatabase} from './helpers/postgres-test-db.mjs'
import {getDatabase,closeDatabaseForTests} from '../src/lib/mca/db'
import {createDeal} from '../src/lib/mca/deals/service'
import type {DealActor} from '../src/lib/mca/deals/schema'
import {insertDocument,updateDocumentScan} from '../src/lib/mca/documents/repository'
import {createStipulation,createMerchantUploadLink} from '../src/lib/mca/closing/service'
import {createMessageTemplate,publishMessageTemplate,renderPublishedMessageTemplate,saveMessageTemplateDraft} from '../src/lib/mca/comms/templates'
import {enqueueDocumentNotifications,documentNotificationSnapshot} from '../src/lib/mca/documents/notification-service'
import {registerDocumentNotificationCondition} from '../src/lib/mca/documents/notification-condition'
import {enqueueNotification,getNotification,setNotificationPolicy} from '../src/lib/mca/notifications/service'
import {runScheduledNotifications,setNotificationTransportForTests,reconcileNotification} from '../src/lib/mca/notifications/worker'
import {recordSmsConsent} from '../src/lib/mca/sms/service'
import {registerNotificationCondition,checkNotificationCondition} from '../src/lib/mca/notifications/conditions'
import {hashOpaqueToken} from '../src/lib/mca/crypto'
import {GET as notificationsGet,POST as notificationsPost} from '../src/app/api/mca/documents/notifications/route'
import {GET as automationGet,PUT as automationPut} from '../src/app/api/mca/documents/notifications/automation/route'
import {readDocumentAutomation,saveDocumentAutomation} from '../src/lib/mca/documents/notification-automation'
import {discoverDocumentNotifications,releaseDocumentDiscoveryLease} from '../src/lib/mca/documents/notification-discovery'
const now=()=>new Date().toISOString()
const actor=(workspaceId='docs-alert-a'):DealActor=>({workspaceId,userId:`${workspaceId}-user`,membershipId:`${workspaceId}-member`,role:'admin',source:'user',managedMembershipIds:[],activeMembershipIds:[`${workspaceId}-member`],correlationId:'doc-alert-test'})
let cluster:Awaited<ReturnType<typeof createPostgresTestDatabase>>,dealId:string,templateId:string
before(async()=>{
 cluster=await createPostgresTestDatabase('t11_document_alerts');Object.assign(process.env,cluster.env());process.env.MCA_NOTIFICATION_RUNTIME='enabled'
 for(const wid of ['docs-alert-a','docs-alert-b']){
 await getDatabase().prepare(`INSERT INTO workspaces(id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at) VALUES(?,?,'UTC',8,'{"integrations":true}','{"deals":true,"integrations":true}','{"createDeal":true}',?,?)`).run(wid,wid,now(),now())
 await getDatabase().prepare('INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`${wid}-user`,`${wid}@example.test`,wid,wid,now(),now())
 await getDatabase().prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'admin','active',?,?)`).run(`${wid}-member`,wid,`${wid}-user`,now(),now())
 }
 for(const wid of ['docs-alert-a','docs-alert-b'])await getDatabase().prepare('INSERT INTO sessions(id,user_id,membership_id,token_hash,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?)').run(`${wid}-session-id`,`${wid}-user`,`${wid}-member`,hashOpaqueToken(`${wid}-session`),new Date(Date.now()+3600000).toISOString(),now(),now())
 dealId=(await createDeal(actor(),{idempotencyKey:'t11-deal',legalName:'Synthetic Docs LLC',contactEmail:'merchant@example.test',contactPhone:'+15551234567',owners:[{firstName:'Sam',lastName:'Fixture',isPrimary:true}],assignments:[{membershipId:actor().membershipId!,kind:'originator',isPrimary:true}]})).deal.id
 registerDocumentNotificationCondition()

})
beforeEach(async()=>{
 for(const table of ['mca_document_notification_discovery','mca_notification_receipts','mca_notifications','mca_notification_preferences','mca_notification_policies','mca_sms_consent_events','mca_merchant_upload_links','mca_closing_stipulations','mca_documents'])await getDatabase().prepare(`DELETE FROM ${table}`).run()
 await getDatabase().prepare("UPDATE memberships SET role='admin',status='active' WHERE id IN ('docs-alert-a-member','docs-alert-b-member')").run()
 process.env.MCA_NOTIFICATION_RUNTIME='enabled';setNotificationTransportForTests(async()=>({state:'accepted'}))
})
after(async()=>{setNotificationTransportForTests();await closeDatabaseForTests();await cluster?.close()})
async function doc(id='application-document',state='pending_scan',category='application'){
 await insertDocument({id,dealId,workspaceId:actor().workspaceId,idempotencyKey:id,lineageId:id,version:1,storageKey:`synthetic/${id}`,originalFilename:'fixture.pdf',displayFilename:'fixture.pdf',mimeType:'application/pdf',byteLength:10,checksum:'synthetic',category:category as 'application',source:'test',createdBy:null,createdAt:now(),updatedAt:now(),processingState:state as 'pending_scan'})
}
const input=(conditionKey='missing:application:required')=>({dealId,conditionKey,scheduledFor:now(),approvedAt:now()})
async function requestLink(category='other_stip'){
 const template=await createMessageTemplate(actor(),{name:`Document reminder ${Date.now()}`,channel:'sms',scope:'request_info',body:'Please upload {{document_request_label}}: {{document_request_url}}'})
 await publishMessageTemplate(actor(),template.id);templateId=template.id
 const stip=await createStipulation(actor(),{dealId,documentCategory:category,label:'Fixture tax return',idempotencyKey:`stip-${category}`})
 const link=await createMerchantUploadLink(actor(),{stipulationId:stip.id,idempotencyKey:`link-${category}`,origin:'http://localhost:3000'})
 return{stip,link}
}
test('company and unassigned rep cannot read or enqueue another deal',async()=>{
 await assert.rejects(documentNotificationSnapshot(actor('docs-alert-b'),dealId))
 await assert.rejects(enqueueDocumentNotifications(actor('docs-alert-b'),input()))
 await getDatabase().prepare(`UPDATE memberships SET role='rep' WHERE id=?`).run(actor('docs-alert-b').membershipId)
 await assert.rejects(documentNotificationSnapshot({...actor('docs-alert-b'),role:'rep'},dealId))
})
test('concurrent repeated broker events deduplicate even with later retry timestamps',async()=>{
 const rows=await Promise.all(Array.from({length:5},()=>enqueueDocumentNotifications(actor(),input())))
 assert.equal(new Set(rows.map(row=>row.broker?.id)).size,1)
 const first=rows[0].broker!
 const retried=await enqueueDocumentNotifications(actor(),{...input(),scheduledFor:new Date(Date.now()+10000).toISOString()})
 assert.equal(retried.broker?.id,first.id);assert.equal(retried.broker?.scheduledFor,first.scheduledFor)
})
test('pending and validation-only ready stay missing; resolution suppresses before dispatch',async()=>{
 await doc()
 assert.ok((await documentNotificationSnapshot(actor(),dealId)).conditions.some(condition=>condition.key==='missing:application:required'))
 await updateDocumentScan(actor().workspaceId,'application-document','ready','fixture',{},now())
 const row=await enqueueDocumentNotifications(actor(),input())
 await updateDocumentScan(actor().workspaceId,'application-document','clean','fixture',{malwareScanPerformed:true},now())
 let sends=0;setNotificationTransportForTests(async()=>{sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0)
 assert.equal((await getNotification(actor(),row.broker!.id!)).state,'suppressed')
})
test('merchant defaults disabled then requires current consent and persisted scoped request link',async()=>{
 const {stip,link}=await requestLink()
 const event={...input(`requested:${stip.id}`),merchant:{channel:'sms' as const,templateId,linkId:link.id}}
 const disabled=await enqueueDocumentNotifications(actor(),event)
 assert.equal(disabled.merchant?.state,'blocked');assert.equal(disabled.merchant?.errorCode,'notification_policy_disabled')
 await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 const noConsent=await enqueueDocumentNotifications(actor(),event)
 assert.equal(noConsent.merchant?.errorCode,'notification_consent_required')
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic optin',idempotencyKey:'t11-consent'})
 const row=await enqueueDocumentNotifications(actor(),event);assert.equal(row.merchant?.state,'queued')
 let body='';setNotificationTransportForTests(async message=>{if(message.audience==='merchant')body=message.text;return{state:'accepted'}})
 await runScheduledNotifications(now())
 assert.ok(body.includes(link.url!));assert.ok(!body.includes('template-upload:'))
})
test('expired revoked consumed and foreign request links cannot queue merchant reminder',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 const event={...input(`requested:${stip.id}`),merchant:{channel:'sms' as const,templateId,linkId:link.id}}
 for(const [field,value] of [['revoked_at',now()],['expires_at','2000-01-01T00:00:00Z'],['used_count',1]] as const){
  await getDatabase().prepare(`UPDATE mca_merchant_upload_links SET ${field}=? WHERE id=?`).run(value,link.id)
  const row=await enqueueDocumentNotifications(actor(),event);assert.equal(row.merchant?.errorCode,'document_request_link_invalid')
  await getDatabase().prepare(`UPDATE mca_merchant_upload_links SET revoked_at=NULL,expires_at=?,used_count=0 WHERE id=?`).run(new Date(Date.now()+3600000).toISOString(),link.id)
 }
 const row=await enqueueDocumentNotifications(actor(),{...event,merchant:{...event.merchant,linkId:'foreign-link'}});assert.equal(row.merchant?.errorCode,'document_request_link_invalid')
})
test('revocation after enqueue and SMS optout suppress instead of sending',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic optin',idempotencyKey:'t11-consent-live'})
 const row=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:link.id}})
 await getDatabase().prepare('UPDATE mca_merchant_upload_links SET revoked_at=? WHERE id=?').run(now(),link.id)
 let merchantSends=0;setNotificationTransportForTests(async message=>{if(message.audience==='merchant')merchantSends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(merchantSends,0);assert.equal((await getNotification(actor(),row.merchant!.id!)).state,'suppressed')
})
test('unknown broker send reconciles without repeat event replay',async()=>{
 const row=await enqueueDocumentNotifications(actor(),input());let sends=0
 setNotificationTransportForTests(async()=>{sends++;throw new Error('unknown')})
 await runScheduledNotifications(now());assert.equal((await getNotification(actor(),row.broker!.id!)).state,'uncertain')
 await reconcileNotification(actor(),row.broker!.id!,{outcome:'accepted',evidence:'Synthetic verified receipt'})
 await enqueueDocumentNotifications(actor(),input());await runScheduledNotifications(now());assert.equal(sends,1)
})

test('standalone scheduled runtime bootstraps document guard and unknown guard fails closed',async()=>{
 const row=await enqueueDocumentNotifications(actor(),input())
 registerNotificationCondition('document',async()=>false)
 let calls=0;setNotificationTransportForTests(async()=>{calls++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(calls,1);assert.equal((await getNotification(actor(),row.broker!.id!)).state,'accepted')
 await assert.rejects(enqueueNotification(actor(),{eventKey:'unknown-condition',kind:'document',dealId,audience:'broker',channel:'email',recipientUserId:actor().userId!,scheduledFor:now(),approvedAt:now(),condition:{type:'unknown_t11',key:'opaque'},payload:{title:'Review docs',message:'Missing document'}}),(error:{code?:string})=>error.code==='notification_condition_unavailable')
})
test('API authenticates rejects wrong company and cross-origin writes and preserves errors',async()=>{
 const request=(workspace='docs-alert-a',init:RequestInit={})=>new Request(`http://localhost/api/mca/documents/notifications?dealId=${dealId}`,{...init,headers:{cookie:`mca_session=${workspace}-session`,origin:'http://localhost','content-type':'application/json',...init.headers}})
 assert.equal((await notificationsGet(new Request('http://localhost/api/mca/documents/notifications'))).status,401)
 assert.equal((await notificationsGet(request('docs-alert-b'))).status,404)
 const response=await notificationsGet(request());assert.equal(response.status,200);assert.ok((await response.json()).conditions.length)
 assert.equal((await notificationsPost(request('docs-alert-a',{method:'POST',body:'{bad'}))).status,400)
 assert.equal((await notificationsPost(request('docs-alert-a',{method:'POST',body:JSON.stringify({dealId,arbitraryUrl:'https://bad.test'})}))).status,400)
 assert.equal((await notificationsPost(request('docs-alert-a',{method:'POST',headers:{origin:'https://foreign.test'},body:JSON.stringify(input())}))).status,403)
 const queued=await notificationsPost(request('docs-alert-a',{method:'POST',body:JSON.stringify(input())}));assert.equal(queued.status,202);assert.equal((await queued.json()).broker.state,'queued')
})

test('same-company unassigned rep and revoked membership cannot inspect alerts',async()=>{
 const db=getDatabase(),wid=actor().workspaceId
 await db.prepare('INSERT INTO users(id,email,name,application_identifier,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('t11-unassigned-user','unassigned@example.test','Unassigned','T11-UNASSIGNED',now(),now())
 await db.prepare(`INSERT INTO memberships(id,workspace_id,user_id,role,status,created_at,updated_at) VALUES(?,?,?,'rep','active',?,?)`).run('t11-unassigned-member',wid,'t11-unassigned-user',now(),now())
 const rep:DealActor={...actor(),userId:'t11-unassigned-user',membershipId:'t11-unassigned-member',role:'rep',activeMembershipIds:['t11-unassigned-member']}
 await assert.rejects(documentNotificationSnapshot(rep,dealId))
 await assert.rejects(enqueueDocumentNotifications(rep,input()))
 await db.prepare("UPDATE memberships SET status='deactivated' WHERE id=?").run(rep.membershipId)
 await assert.rejects(documentNotificationSnapshot(rep,dealId))
})
test('SMS optout after queue suppresses merchant condition without duplicate replay',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic merchant optin',idempotencyKey:'t11-optin-lifecycle'})
 const row=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:link.id}})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_out',evidence:'Synthetic merchant optout',idempotencyKey:'t11-optout-lifecycle'})
 let sends=0;setNotificationTransportForTests(async message=>{if(message.audience==='merchant')sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0);assert.equal((await getNotification(actor(),row.merchant!.id!)).state,'suppressed')
})
test('merchant reminders remain independent when broker company policy is disabled',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:false,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic merchant optin',idempotencyKey:'t11-optin-independent'})
 const result=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:link.id}})
 assert.equal(result.broker?.state,'blocked');assert.equal(result.merchant?.state,'queued')
})
test('guard denies malformed condition keys and renderer rejects off-origin upload URLs',async()=>{
 await assert.rejects(checkNotificationCondition(actor(),{type:'document',key:'not json',version:'1'}),(error:{code?:string})=>error.code==='notification_condition_resolved')
 const {link}=await requestLink()
 await assert.rejects(renderPublishedMessageTemplate(actor(),{templateId,dealId,origin:'http://localhost:3000',notificationValues:{document_request_url:`https://foreign.test/merchant-upload/${link.id.padEnd(40,'x')}`}}),(error:{code?:string})=>error.code==='document_request_url_invalid')
})

test('repeated event with changed broker payload reports idempotency conflict',async()=>{
 const {stip}=await requestLink()
 const first=await enqueueDocumentNotifications(actor(),input(`requested:${stip.id}`));assert.equal(first.broker?.state,'queued')
 await getDatabase().prepare('UPDATE mca_closing_stipulations SET label=? WHERE id=?').run('Changed request meaning',stip.id)
 const second=await enqueueDocumentNotifications(actor(),input(`requested:${stip.id}`))
 assert.equal(second.broker?.state,'blocked');assert.equal(second.broker?.errorCode,'notification_idempotency_conflict')
})
test('document reminder template cannot also materialize legacy nonpersisted upload variables',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic optin',idempotencyKey:'t11-legacy-optin'})
 const template=await createMessageTemplate(actor(),{name:'Mixed old links',scope:'request_info',channel:'sms',body:'{{document_request_url}} or {{auto_upload_url}}'})
 await publishMessageTemplate(actor(),template.id)
 const result=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId:template.id,linkId:link.id}})
 assert.equal(result.merchant?.state,'blocked');assert.equal(result.merchant?.errorCode,'document_request_template_invalid')
})

test('template changed after enqueue to legacy link is suppressed at dispatch',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic optin',idempotencyKey:'t11-template-edit-optin'})
 const result=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:link.id}})
 await saveMessageTemplateDraft(actor(),templateId,{body:'{{document_request_url}} or {{auto_upload_url}}'})
 await publishMessageTemplate(actor(),templateId)
 let sends=0;setNotificationTransportForTests(async message=>{if(message.audience==='merchant')sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0);assert.equal((await getNotification(actor(),result.merchant!.id!)).state,'suppressed')
})

test('expiry and request resolution after queue suppress merchant sends',async()=>{
 const {stip,link}=await requestLink();await setNotificationPolicy(actor(),{kind:'document',brokerEnabled:true,merchantEnabled:true})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic optin',idempotencyKey:'t11-expiring-optin'})
 const result=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:link.id}})
 await getDatabase().prepare('UPDATE mca_merchant_upload_links SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z',link.id)
 let sends=0;setNotificationTransportForTests(async message=>{if(message.audience==='merchant')sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0);assert.equal((await getNotification(actor(),result.merchant!.id!)).state,'suppressed')
})
test('real foreign-company request link id denies reminder in current deal',async()=>{
 const foreignDeal=(await createDeal(actor('docs-alert-b'),{idempotencyKey:'t11-foreign-link-deal',legalName:'Other synthetic company',assignments:[{membershipId:actor('docs-alert-b').membershipId!,kind:'originator',isPrimary:true}]})).deal.id
 const foreignStip=await createStipulation(actor('docs-alert-b'),{dealId:foreignDeal,documentCategory:'other_stip',label:'Other request',idempotencyKey:'t11-foreign-stip'})
 const foreignLink=await createMerchantUploadLink(actor('docs-alert-b'),{stipulationId:foreignStip.id,idempotencyKey:'t11-foreign-link',origin:'http://localhost:3000'})
 const {stip}=await requestLink()
 const result=await enqueueDocumentNotifications(actor(),{...input(`requested:${stip.id}`),merchant:{channel:'sms',templateId,linkId:foreignLink.id}})
 assert.equal(result.merchant?.errorCode,'document_request_link_invalid')
})

test('dedicated automation opt-in is durable admin approval and existing defaults stay off',async()=>{
 assert.equal((await readDocumentAutomation(actor())).enabled,false)
 assert.equal((await discoverDocumentNotifications({clock:now()})).enqueued,0)
 const config=await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing','requested','stale'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0,minute:0},channel:'sms'})
 assert.equal(config.version,1);assert.equal(config.approvedByMembershipId,actor().membershipId);assert.ok(config.approvedAt)
 await assert.rejects(saveDocumentAutomation({...actor(),userId:'t11-unassigned-user',membershipId:'t11-unassigned-member',role:'rep'}, {...config,enabled:true} as never))
 const next=await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['requested'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 assert.equal(next.version,2)
})
test('automatic broker discovery is bounded resumes cursor and deduplicates concurrent ticks',async()=>{
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 for(let i=0;i<3;i++)await createDeal(actor(),{idempotencyKey:`t11-auto-${i}`,legalName:`Synthetic auto ${i}`,assignments:[{membershipId:actor().membershipId!,kind:'originator',isPrimary:true}]})
 const first=await discoverDocumentNotifications({clock:now(),limit:2});assert.ok(first.enqueued<=2);assert.ok(first.enqueued>0)
 const initial=(await getDatabase().prepare<{count:string}>("SELECT count(*) count FROM mca_notifications WHERE event_key LIKE 'document-auto:%'").get())!.count
 await Promise.all([discoverDocumentNotifications({clock:now(),limit:2}),discoverDocumentNotifications({clock:now(),limit:2})])
 const later=(await getDatabase().prepare<{count:string}>("SELECT count(*) count FROM mca_notifications WHERE event_key LIKE 'document-auto:%'").get())!.count
 assert.ok(Number(later)>Number(initial));assert.ok(Number(later)<=Number(initial)+4)
 for(let i=0;i<20;i++)await discoverDocumentNotifications({clock:now(),limit:10})
 const rows=await getDatabase().prepare<{count:string;unique:string}>("SELECT count(*) count,count(DISTINCT event_key||recipient_key) AS unique FROM mca_notifications WHERE event_key LIKE 'document-auto:%'").get();assert.equal(rows!.count,rows!.unique)
})
test('automatic merchant uses dedicated configured policy consent and live request; generic followup is not opt-in',async()=>{
 const {stip,link}=await requestLink()
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:false,merchantEnabled:true,reasons:['requested'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms',templateId})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic automatic optin',idempotencyKey:'t11-auto-consent'})
 const found=await discoverDocumentNotifications({clock:now(),limit:20});assert.equal(found.enqueued,1)
 const rows=await getDatabase().prepare<{id:string;audience:string}>('SELECT id,audience FROM mca_notifications WHERE workspace_id=?').all(actor().workspaceId)
 assert.equal(rows.length,1);assert.equal(rows[0].audience,'merchant')
 await getDatabase().prepare('UPDATE mca_closing_stipulations SET status=? WHERE id=?').run('waived',stip.id)
 let sends=0;setNotificationTransportForTests(async()=>{sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0);assert.equal((await getNotification(actor(),rows[0].id)).state,'suppressed')
 assert.ok(link.id)
})
test('automatic settings version disable and shared deadline prevent unsafe work',async()=>{
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 assert.equal((await discoverDocumentNotifications({clock:now(),limit:20,deadlineMs:Date.now()-1})).enqueued,0)
 await discoverDocumentNotifications({clock:now(),limit:20})
 await saveDocumentAutomation(actor(),{enabled:false,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 let sends=0;setNotificationTransportForTests(async()=>{sends++;return{state:'accepted'}})
 await runScheduledNotifications(now());assert.equal(sends,0)
})

test('automatic broker assignment is live at dispatch even for an administrator',async()=>{
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 await discoverDocumentNotifications({clock:now(),limit:100})
 const rows=await getDatabase().prepare<{id:string}>('SELECT id FROM mca_notifications WHERE workspace_id=? AND deal_id=?').all(actor().workspaceId,dealId)
 assert.ok(rows.length>0)
 await getDatabase().prepare('DELETE FROM deal_assignments WHERE workspace_id=? AND deal_id=?').run(actor().workspaceId,dealId)
 let sends=0;setNotificationTransportForTests(async message=>{if(message.dealId===dealId)sends++;return{state:'accepted'}})
 try{await runScheduledNotifications(now());assert.equal(sends,0);for(const row of rows)assert.equal((await getNotification(actor(),row.id)).state,'suppressed')}
 finally{await getDatabase().prepare("INSERT INTO deal_assignments(id,workspace_id,deal_id,membership_id,kind,is_primary,assigned_at) VALUES(?,?,?,?,'originator',1,?)").run('t11-restored-assignment',actor().workspaceId,dealId,actor().membershipId,now())}
})
test('automatic config API rejects forged approvals bad cadence and foreign origin',async()=>{
 const base={enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['requested'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'}
 const request=(wid='docs-alert-a',input?:unknown)=>new Request('http://localhost:3000/api/mca/documents/notifications/automation',{method:input?'PUT':'GET',headers:{cookie:`mca_session=${wid}-session`,origin:'http://localhost:3000','content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})})
 assert.equal((await automationPut(request('docs-alert-a',{...base,approvedAt:'2020-01-01T00:00:00Z'}))).status,400)
 assert.equal((await automationPut(request('docs-alert-a',{...base,localSchedule:{timezone:'wrong/timezone',frequency:'weekly',hour:0}}))).status,400)
 const saved=await automationPut(request('docs-alert-a',base));assert.equal(saved.status,200)
 const other=await automationGet(request('docs-alert-b'));assert.equal((await other.json()).version,0)
 const hostile=request('docs-alert-a',base);hostile.headers.set('origin','https://foreign.test');assert.equal((await automationPut(hostile)).status,403)
 await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id=?").run(actor().membershipId)
 try{assert.equal((await automationPut(request('docs-alert-a',base))).status,403)}finally{await getDatabase().prepare("UPDATE memberships SET role='admin' WHERE id=?").run(actor().membershipId)}
})
test('missing assignments do not broadcast and other companies are cursor isolated',async()=>{
 await saveDocumentAutomation(actor('docs-alert-b'),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 const foreign=(await createDeal(actor('docs-alert-b'),{idempotencyKey:'t11-unassigned-auto',legalName:'Synthetic unassigned'})).deal.id
 await getDatabase().prepare('DELETE FROM deal_assignments WHERE workspace_id=? AND deal_id=?').run(actor('docs-alert-b').workspaceId,foreign)
 await discoverDocumentNotifications({clock:now()})
 assert.equal((await getDatabase().prepare<{count:string}>('SELECT count(*) count FROM mca_notifications WHERE workspace_id=? AND deal_id=?').get(actor('docs-alert-b').workspaceId,foreign))!.count,'0')
 assert.equal((await readDocumentAutomation(actor())).version,0)
})
test('unknown automatic merchant outcome blocks new approval version until reconciliation',async()=>{
 const {stip,link}=await requestLink()
 const settings={enabled:true,brokerEnabled:false,merchantEnabled:true,reasons:['requested'] as const,localSchedule:{timezone:'UTC',frequency:'daily' as const,hour:0},channel:'sms' as const,templateId}
 await saveDocumentAutomation(actor(),{...settings,reasons:[...settings.reasons]})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic unknown optin',idempotencyKey:'t11-auto-unknown-consent'})
 await discoverDocumentNotifications({clock:now()});setNotificationTransportForTests(async()=>({state:'uncertain',errorCode:'synthetic_unknown'}));await runScheduledNotifications(now())
 const unknown=await getDatabase().prepare<{id:string}>("SELECT id FROM mca_notifications WHERE workspace_id=? AND state='uncertain'").get(actor().workspaceId);assert.ok(unknown)
 await saveDocumentAutomation(actor(),{...settings,reasons:[...settings.reasons]})
 const next=await discoverDocumentNotifications({clock:now()});assert.equal(next.enqueued,0);assert.ok(next.blocked)
 assert.equal((await getDatabase().prepare<{count:string}>('SELECT count(*) count FROM mca_notifications WHERE workspace_id=?').get(actor().workspaceId))!.count,'1')
 await reconcileNotification(actor(),unknown.id,{outcome:'failed',evidence:'Synthetic provider evidence confirmed no send'})
 for(let i=0;i<3;i++)await discoverDocumentNotifications({clock:now()})
 assert.equal((await getDatabase().prepare<{count:string}>('SELECT count(*) count FROM mca_notifications WHERE workspace_id=?').get(actor().workspaceId))!.count,'2');assert.ok(stip.id&&link.id)
})

test('locked cursor cleanup returns within bounded time and leaves recoverable lease',async()=>{
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 await getDatabase().prepare('UPDATE mca_document_notification_discovery SET lease_token=?,lease_until=? WHERE workspace_id=?').run('locked-cleanup',new Date(Date.now()+30000).toISOString(),actor().workspaceId)
 const lock=new Client({connectionString:cluster.databaseUrl});await lock.connect();await lock.query('BEGIN');await lock.query('SELECT workspace_id FROM mca_document_notification_discovery WHERE workspace_id=$1 FOR UPDATE',[actor().workspaceId])
 const watchdog=setTimeout(()=>{void lock.query('ROLLBACK')},2500)
 try{
  const started=Date.now();await releaseDocumentDiscoveryLease({workspaceId:actor().workspaceId,version:1,token:'locked-cleanup',lastDeal:'',activeDeal:null,lastItem:''});assert.ok(Date.now()-started<2000)
 }finally{clearTimeout(watchdog);await lock.query('ROLLBACK');await lock.end()}
 const lease=await getDatabase().prepare<{lease_token:string}>('SELECT lease_token FROM mca_document_notification_discovery WHERE workspace_id=?').get(actor().workspaceId);assert.equal(lease!.lease_token,'locked-cleanup')
 await releaseDocumentDiscoveryLease({workspaceId:actor().workspaceId,version:1,token:'locked-cleanup',lastDeal:'',activeDeal:null,lastItem:''})
 assert.equal((await getDatabase().prepare<{lease_token:string|null}>('SELECT lease_token FROM mca_document_notification_discovery WHERE workspace_id=?').get(actor().workspaceId))!.lease_token,null)
})

test('company leases are exclusive fenced and recover after expiry; another tenant makes progress',async()=>{
 const settings={enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'] as const,localSchedule:{timezone:'UTC',frequency:'daily' as const,hour:0},channel:'sms' as const}
 await saveDocumentAutomation(actor(),{...settings,reasons:[...settings.reasons]});await saveDocumentAutomation(actor('docs-alert-b'),{...settings,reasons:[...settings.reasons]})
 await getDatabase().prepare('UPDATE mca_document_notification_discovery SET lease_token=?,lease_until=? WHERE workspace_id=?').run('running-pass',new Date(Date.now()+30000).toISOString(),actor().workspaceId)
 await discoverDocumentNotifications({clock:now(),limit:2})
 assert.equal((await getDatabase().prepare<{count:string}>('SELECT count(*) count FROM mca_notifications WHERE workspace_id=?').get(actor().workspaceId))!.count,'0')
 assert.ok(Number((await getDatabase().prepare<{count:string}>('SELECT count(*) count FROM mca_notifications WHERE workspace_id=?').get(actor('docs-alert-b').workspaceId))!.count)>0)
 await getDatabase().prepare('UPDATE mca_document_notification_discovery SET lease_until=? WHERE workspace_id=?').run('2000-01-01T00:00:00Z',actor().workspaceId)
 assert.ok((await discoverDocumentNotifications({clock:now(),limit:2})).enqueued>0)
 await saveDocumentAutomation(actor(),{...settings,reasons:[...settings.reasons]})
 await getDatabase().prepare('UPDATE mca_document_notification_discovery SET lease_token=? WHERE workspace_id=?').run('new-pass',actor().workspaceId)
 await releaseDocumentDiscoveryLease({workspaceId:actor().workspaceId,version:1,token:'running-pass',lastDeal:'old',activeDeal:null,lastItem:'old'})
 const current=await getDatabase().prepare<{lease_token:string;last_deal_id:string}>('SELECT lease_token,last_deal_id FROM mca_document_notification_discovery WHERE workspace_id=?').get(actor().workspaceId);assert.equal(current!.lease_token,'new-pass');assert.equal(current!.last_deal_id,'')
})
test('runtime off and future local schedule produce no events; revoked approver fails closed',async()=>{
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:23,minute:59},channel:'sms'})
 assert.equal((await discoverDocumentNotifications({clock:new Date().toISOString().slice(0,10)+'T00:00:00.000Z'})).enqueued,0)
 process.env.MCA_NOTIFICATION_RUNTIME='disabled';assert.equal((await discoverDocumentNotifications({clock:now()})).companies,0)
 process.env.MCA_NOTIFICATION_RUNTIME='enabled'
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:true,merchantEnabled:false,reasons:['missing'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms'})
 await discoverDocumentNotifications({clock:now()})
 await getDatabase().prepare("UPDATE memberships SET role='rep' WHERE id=?").run(actor().membershipId)
 let sends=0;setNotificationTransportForTests(async()=>{sends++;return{state:'accepted'}})
 try{await runScheduledNotifications(now());assert.equal(sends,0)}finally{await getDatabase().prepare("UPDATE memberships SET role='admin' WHERE id=?").run(actor().membershipId)}
})

test('unknown first cadence outcome suppresses another already queued automatic occurrence',async()=>{
 const {stip,link}=await requestLink()
 await saveDocumentAutomation(actor(),{enabled:true,brokerEnabled:false,merchantEnabled:true,reasons:['requested'],localSchedule:{timezone:'UTC',frequency:'daily',hour:0},channel:'sms',templateId})
 await recordSmsConsent(actor(),{dealId,recipient:'+15551234567',state:'opted_in',evidence:'Synthetic backlog optin',idempotencyKey:'t11-backlog-consent'})
 const raw={...input(`requested:${stip.id}`),merchant:{channel:'sms' as const,templateId,linkId:link.id}}
 const first=await enqueueDocumentNotifications(actor(),raw,{occurrenceKey:'daily:previous',automationVersion:1,broker:false})
 const second=await enqueueDocumentNotifications(actor(),raw,{occurrenceKey:'daily:current',automationVersion:1,broker:false});assert.equal(second.merchant?.state,'queued')
 let sends=0;setNotificationTransportForTests(async()=>{sends++;return{state:'uncertain',errorCode:'synthetic_backlog_unknown'}})
 await runScheduledNotifications(now());assert.equal(sends,1)
 const states=await Promise.all([first.merchant!.id!,second.merchant!.id!].map(id=>getNotification(actor(),id)));assert.ok(states.every(row=>['uncertain','suppressed'].includes(row.state)));assert.ok(states.some(row=>row.state==='suppressed'));assert.equal((await getDatabase().prepare<{count:string}>("SELECT count(*) count FROM mca_notifications WHERE workspace_id=? AND state='uncertain'").get(actor().workspaceId))!.count,'1')
})
