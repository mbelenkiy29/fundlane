import 'server-only'
import {createHash} from 'node:crypto'
import {z} from 'zod'
import {getDatabase,nowIso} from '../db'
import type {DealActor} from '../deals/schema'
import {enqueueNotification,notificationActor,getNotification,notificationInput} from '../notifications/service'
import {notificationInputSchema,type NotificationView,type NotificationRow,type NotificationInput} from '../notifications/contracts'
import {getPublishedMessageTemplate,assertDocumentRequestTemplate} from '../comms/templates'
import {AppError} from '../errors'
import {activeDocumentCondition,documentConditionSnapshot,documentRequestValues} from './notification-state'
import {registerDocumentNotificationCondition} from './notification-condition'
export const documentNotificationInputSchema=z.object({dealId:z.string().min(1).max(80),conditionKey:z.string().min(1).max(200),scheduledFor:z.iso.datetime(),approvedAt:z.iso.datetime(),recipientUserId:z.string().min(1).max(80).optional(),merchant:z.object({channel:z.enum(['email','sms']),templateId:z.string().min(1).max(80),senderId:z.string().min(1).max(80).optional(),linkId:z.string().min(1).max(80)}).strict().optional()}).strict()
export type DocumentNotificationInput=z.infer<typeof documentNotificationInputSchema>
export type DocumentNotificationResult={broker?:Partial<Omit<NotificationView,'state'>>&{state:NotificationView['state']|'blocked'};merchant?:Partial<Omit<NotificationView,'state'>>&{state:NotificationView['state']|'blocked'};resolved?:boolean}
export async function documentNotificationSnapshot(actor:DealActor,dealId:string,clock=nowIso()){
 return documentConditionSnapshot(await notificationActor(actor),dealId,clock)
}
function sameEvent(row:NotificationRow,input:NotificationInput){
 const {scheduledFor: _savedSchedule,approvedAt: _savedApproval,...saved}=notificationInput(row)
 const {scheduledFor: _requestedSchedule,approvedAt: _requestedApproval,...requested}=notificationInputSchema.parse(input)
 void _savedSchedule;void _savedApproval;void _requestedSchedule;void _requestedApproval
 return JSON.stringify(saved)===JSON.stringify(requested)
}
async function enqueueOnce(actor:DealActor,input:NotificationInput){
 const existing=await getDatabase().prepare<NotificationRow>(`SELECT * FROM mca_notifications WHERE workspace_id=? AND event_key=? AND audience=? AND channel=? AND recipient_key=?`).get(actor.workspaceId,input.eventKey,input.audience,input.channel,input.audience==='broker'?input.recipientUserId!:'merchant')
 if(existing){
  // Retry cannot silently change the recipient/template/condition originally approved.
  if(!sameEvent(existing,input))throw new AppError(409,'notification_idempotency_conflict','This event was approved with a different template or sender.')
  return getNotification(actor,existing.id)
 }
 try{return await enqueueNotification(actor,input)}catch(error){
  // Concurrent producers can have distinct clocks. Return the first fenced event only.
  if(error instanceof AppError&&error.code==='notification_idempotency_conflict'){
   const row=await getDatabase().prepare<NotificationRow>('SELECT * FROM mca_notifications WHERE workspace_id=? AND event_key=? AND audience=? AND channel=? AND recipient_key=?').get(actor.workspaceId,input.eventKey,input.audience,input.channel,input.audience==='broker'?input.recipientUserId!:'merchant')
   if(row&&sameEvent(row,input))return getNotification(actor,row.id)
  }
  throw error
 }
}
export async function enqueueDocumentNotifications(actor:DealActor,raw:DocumentNotificationInput):Promise<DocumentNotificationResult>{
 const input=documentNotificationInputSchema.parse(raw),live=await notificationActor(actor)
 registerDocumentNotificationCondition()
 const key={dealId:input.dealId,key:input.conditionKey},condition=await activeDocumentCondition(live,key)
 if(!condition)return{resolved:true}
 const eventKey=`document:${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`
 const base={kind:'document' as const,dealId:input.dealId,scheduledFor:input.scheduledFor,approvedAt:input.approvedAt}
 const result:DocumentNotificationResult={}
 const recipientUserId=input.recipientUserId??live.userId!
 try{
 result.broker=await enqueueOnce(live,{...base,eventKey,channel:'email',audience:'broker',recipientUserId,condition:{type:'document',key:JSON.stringify(key),version:'1'},payload:{title:`Documents ${condition.reason}: ${condition.label}`,message:`${condition.label}${condition.requiredPeriod?` for ${condition.requiredPeriod} (completed UTC month)`:''} is ${condition.reason}. Review the document vault for this deal.`}})
 }catch(error){if(!(error instanceof AppError))throw error;result.broker={state:'blocked',errorCode:error.code}}
 if(input.merchant){
  try{
   const merchant=input.merchant,merchantKey={...key,linkId:merchant.linkId}
   await documentRequestValues(live,merchantKey)
   const template=await getPublishedMessageTemplate(live,merchant.templateId)
   if(!template.published)throw new AppError(422,'document_request_template_invalid','Choose a published document reminder template.')
   assertDocumentRequestTemplate({body:template.published.body,subject:template.published.subject,channel:template.channel,scope:template.scope})
   result.merchant=await enqueueOnce(live,{...base,eventKey:`${eventKey}:${createHash('sha256').update(merchant.linkId).digest('hex').slice(0,16)}`,audience:'merchant',channel:merchant.channel,templateId:merchant.templateId,senderId:merchant.senderId,condition:{type:'document',key:JSON.stringify(merchantKey),version:'1'}})
  }catch(error){if(!(error instanceof AppError))throw error;result.merchant={state:'blocked',errorCode:error.code}}
 }
 return result
}
