import 'server-only'
import {getDatabase,newId,nowIso,withImmediateTransaction} from '../db'
import {AppError} from '../errors'
import {followupOccurrenceFor,followupLocalScheduleSchema} from '../comms/followups'
import {liveDocumentAutomation,type DocumentAutomationRow} from './notification-automation'
import {documentConditionSnapshot} from './notification-state'
import {enqueueDocumentNotifications} from './notification-service'
import {withExecutionDeadline,executionSignal,executionFence,executionRemainingMs,outsideExecutionScope} from '../jobs/execution'
import type {DocumentCondition} from './notification-facts'
export interface DocumentDiscoveryOptions {clock:string;limit?:number;deadlineMs?:number}
/** One bounded producer pass; the foundation remains the only delivery runtime. */
export async function discoverDocumentNotifications(options:DocumentDiscoveryOptions){
 if(process.env.MCA_NOTIFICATION_RUNTIME!=='enabled')return{companies:0,deals:0,enqueued:0,blocked:0}
 const duration=Math.min(14000,(options.deadlineMs??Infinity)-Date.now()-1000,(executionRemainingMs()??Infinity)-1000)
 if(duration<1000)return{companies:0,deals:0,enqueued:0,blocked:0}
 try{return await withExecutionDeadline(()=>discoverBounded(options),executionSignal(),duration,executionFence())}
 catch(error){if(error instanceof AppError&&error.code==='execution_expired')return{companies:0,deals:0,enqueued:0,blocked:1};throw error}
}
async function discoverBounded(options:DocumentDiscoveryOptions){
 const result={companies:0,deals:0,enqueued:0,blocked:0}
 if(process.env.MCA_NOTIFICATION_RUNTIME!=='enabled')return result
 const cap=options.limit??20,clock=options.clock,deadline=Math.min(options.deadlineMs??Infinity,Date.now()+15000)
 if(!Number.isFinite(Date.parse(clock))||!Number.isInteger(cap)||cap<1||cap>100)throw new AppError(422,'document_discovery_limit_invalid','Use a valid clock and event cap between1 and100.')
 if(deadline-Date.now()<1000)return result
 const fence=executionFence(),operationClock=nowIso(),token=newId()
 const row=await withImmediateTransaction(async db=>{
  const candidate=await db.prepare<DocumentAutomationRow>(`SELECT * FROM mca_document_notification_discovery WHERE enabled=1 AND (lease_until IS NULL OR lease_until<=?) ORDER BY checked_at,workspace_id LIMIT 1 FOR UPDATE SKIP LOCKED`).get(operationClock)
  if(!candidate)return
  return db.prepare<DocumentAutomationRow>('UPDATE mca_document_notification_discovery SET lease_token=?,lease_until=? WHERE workspace_id=? RETURNING *').get(token,new Date(Date.now()+30000).toISOString(),candidate.workspace_id)
 })
 if(!row)return result
 result.companies++
 let lastDeal=row.last_deal_id,activeDeal=row.active_deal_id,lastItem=row.last_item_key,occurrenceKey=row.cursor_occurrence_key
 try{
  const live=await liveDocumentAutomation(row.workspace_id,row.approval_version)
  if(!live)return result
  const schedule=followupLocalScheduleSchema.parse(JSON.parse(row.local_schedule))
  const occurrence=followupOccurrenceFor({...schedule,minute:schedule.minute??0},clock)
  if(!occurrence?.due)return result
  if(occurrenceKey!==occurrence.occurrenceKey){lastDeal='';activeDeal=null;lastItem='';occurrenceKey=occurrence.occurrenceKey}
  const reasons=JSON.parse(row.reasons_json) as string[]
  const deals=await getDatabase().prepare<{id:string}>(`SELECT id FROM deals WHERE workspace_id=? AND status NOT IN ('closed','funded') AND id ${activeDeal?'>=':'>'} ? ORDER BY id LIMIT 10`).all(row.workspace_id,activeDeal??lastDeal)
  if(!deals.length){lastDeal='';activeDeal=null;lastItem='';return result}
  let handled=0
  for(const deal of deals){
   if(deadline-Date.now()<1000||handled>=cap)break
   result.deals++
   const snapshot=await documentConditionSnapshot(live.actor,deal.id,clock)
   const recipients=row.broker_enabled?await getDatabase().prepare<{userId:string}>(`SELECT DISTINCT m.user_id AS "userId" FROM deal_assignments a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=? AND a.deal_id=? AND a.kind IN ('originator','closer') AND m.status='active' ORDER BY m.user_id`).all(row.workspace_id,deal.id):[]
   const items:Array<{key:string;condition:DocumentCondition;recipientUserId?:string;linkId?:string;merchant:boolean}>=[]
   for(const condition of snapshot.conditions.filter(item=>reasons.includes(item.reason))){
    for(const recipient of recipients)items.push({key:`${condition.key}:broker:${recipient.userId}`,condition,recipientUserId:recipient.userId,merchant:false})
    if(row.merchant_enabled){
     const link=snapshot.links.find(item=>item.category===condition.category&&(!condition.stipulationId||item.stipulationId===condition.stipulationId))
     if(link)items.push({key:`${condition.key}:merchant:${link.id}`,condition,linkId:link.id,merchant:true})
     else result.blocked++
    }
   }
   items.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)
   let complete=true
   for(const item of items){
    if(activeDeal===deal.id&&item.key<=lastItem)continue
    if(deadline-Date.now()<1000||handled>=cap){complete=false;break}
    const produced=await enqueueDocumentNotifications(live.actor,{dealId:deal.id,conditionKey:item.condition.key,recipientUserId:item.recipientUserId,scheduledFor:occurrence.scheduledFor,approvedAt:row.approved_at,...(item.merchant?{merchant:{channel:row.channel,templateId:row.template_id??'',senderId:row.sender_id??undefined,linkId:item.linkId!}}:{})},{occurrenceKey:occurrence.occurrenceKey,automationVersion:row.approval_version,broker:!item.merchant})
    const notification=item.merchant?produced.merchant:produced.broker
    if(notification?.id)result.enqueued++;else result.blocked++
    handled++;activeDeal=deal.id;lastItem=item.key
   }
   if(!complete)break
   lastDeal=deal.id;activeDeal=null;lastItem=''
  }
  return result
 }catch(error){
  if(!(error instanceof AppError))throw error
  result.blocked++;return result
 }finally{
  await releaseDocumentDiscoveryLease({workspaceId:row.workspace_id,version:row.approval_version,token,lastDeal,activeDeal,lastItem,occurrenceKey},fence)
 }
}

/** Internal fenced cleanup; a locked row may be recovered after the lease expires. */
export async function releaseDocumentDiscoveryLease(cursor:{workspaceId:string;version:number;token:string;lastDeal:string;activeDeal:string|null;lastItem:string;occurrenceKey?:string|null},fence=executionFence()){
 try{await outsideExecutionScope(()=>withExecutionDeadline(()=>getDatabase().prepare('UPDATE mca_document_notification_discovery SET last_deal_id=?,active_deal_id=?,last_item_key=?,cursor_occurrence_key=?,checked_at=?,lease_token=NULL,lease_until=NULL WHERE workspace_id=? AND approval_version=? AND lease_token=?').run(cursor.lastDeal,cursor.activeDeal,cursor.lastItem,cursor.occurrenceKey??null,nowIso(),cursor.workspaceId,cursor.version,cursor.token),undefined,1000,fence))}
 catch(error){if(!(error instanceof AppError)||error.code!=='execution_expired')throw error}
}
