import 'server-only'
import {z} from 'zod'
import {getDatabase,nowIso,recordAuditEvent,withImmediateTransaction} from '../db'
import {notificationActor,requireNotificationAdmin,setNotificationPolicy} from '../notifications/service'
import {getPublishedMessageTemplate,assertDocumentRequestTemplate} from '../comms/templates'
import {followupLocalScheduleSchema,isValidFollowupTimeZone} from '../comms/followups'
import {emailSender,liveEmailActor} from '../email-conversations/service'
import type {DealActor} from '../deals/schema'
import {AppError} from '../errors'
export const documentAutomationSchema=z.object({enabled:z.boolean(),brokerEnabled:z.boolean(),merchantEnabled:z.boolean(),reasons:z.array(z.enum(['missing','requested','stale'])).min(1).max(3),localSchedule:followupLocalScheduleSchema.refine(s=>isValidFollowupTimeZone(s.timezone),'Choose a valid IANA timezone.').refine(s=>s.frequency!=='weekly'||s.weekday!==undefined,'Choose a weekday.').refine(s=>s.frequency!=='monthly'||s.dayOfMonth!==undefined,'Choose a day of month.'),channel:z.enum(['email','sms']),templateId:z.string().min(1).max(80).optional(),senderId:z.string().min(1).max(80).optional()}).strict()
export type DocumentAutomationInput=z.infer<typeof documentAutomationSchema>
export interface DocumentAutomationRow {workspace_id:string;enabled:number;broker_enabled:number;merchant_enabled:number;reasons_json:string;local_schedule:string;channel:'email'|'sms';template_id:string|null;sender_id:string|null;approval_version:number;approved_by_membership_id:string;approved_at:string;last_deal_id:string;active_deal_id:string|null;last_item_key:string;cursor_occurrence_key:string|null;checked_at:string;lease_token:string|null;lease_until:string|null;updated_at:string}
export const automationView=(row:DocumentAutomationRow)=>({enabled:!!row.enabled,brokerEnabled:!!row.broker_enabled,merchantEnabled:!!row.merchant_enabled,reasons:JSON.parse(row.reasons_json) as DocumentAutomationInput['reasons'],localSchedule:JSON.parse(row.local_schedule) as DocumentAutomationInput['localSchedule'],channel:row.channel,templateId:row.template_id??undefined,senderId:row.sender_id??undefined,version:row.approval_version,approvedAt:row.approved_at,approvedByMembershipId:row.approved_by_membership_id})
export async function readDocumentAutomation(actor:DealActor){
 const live=await notificationActor(actor)
 const row=await getDatabase().prepare<DocumentAutomationRow>('SELECT * FROM mca_document_notification_discovery WHERE workspace_id=?').get(live.workspaceId)
 const defaults={enabled:false,brokerEnabled:true,merchantEnabled:false,reasons:['missing','requested','stale'] as DocumentAutomationInput['reasons'],localSchedule:{timezone:'UTC',frequency:'daily' as const,hour:9,minute:0},channel:'email' as const,version:0,approvedAt:undefined,approvedByMembershipId:undefined,templateId:undefined as string|undefined,senderId:undefined as string|undefined}
 return{...(row?automationView(row):defaults),canManage:['admin','super_admin'].includes(live.role??''),runtimeReady:process.env.MCA_NOTIFICATION_RUNTIME==='enabled'}
}
export async function saveDocumentAutomation(actor:DealActor,raw:DocumentAutomationInput){
 const input=documentAutomationSchema.parse(raw),live=await notificationActor(actor);requireNotificationAdmin(live)
 if(!input.brokerEnabled&&!input.merchantEnabled&&input.enabled)throw new AppError(422,'document_automation_audience_required','Choose at least one notification audience.')
 if(input.enabled&&input.merchantEnabled){
  if(!input.templateId)throw new AppError(422,'document_request_template_invalid','Choose a published document reminder template.')
  const template=await getPublishedMessageTemplate(live,input.templateId)
  if(template.channel!==input.channel||!template.published)throw new AppError(422,'document_request_template_invalid','Choose a published document template for this channel.')
  assertDocumentRequestTemplate({body:template.published.body,subject:template.published.subject,channel:template.channel,scope:template.scope})
  if(input.channel==='email')await emailSender(live,input.senderId??'',true)
 }
 return withImmediateTransaction(async()=>{
 const clock=nowIso()
 const row=await getDatabase().prepare<DocumentAutomationRow>(`INSERT INTO mca_document_notification_discovery(workspace_id,enabled,broker_enabled,merchant_enabled,reasons_json,local_schedule,channel,template_id,sender_id,approval_version,approved_by_membership_id,approved_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET enabled=excluded.enabled,broker_enabled=excluded.broker_enabled,merchant_enabled=excluded.merchant_enabled,reasons_json=excluded.reasons_json,local_schedule=excluded.local_schedule,channel=excluded.channel,template_id=excluded.template_id,sender_id=excluded.sender_id,approval_version=mca_document_notification_discovery.approval_version+1,approved_by_membership_id=excluded.approved_by_membership_id,approved_at=excluded.approved_at,last_deal_id='',active_deal_id=NULL,last_item_key='',cursor_occurrence_key=NULL,checked_at='1970-01-01T00:00:00.000Z',lease_token=NULL,lease_until=NULL,updated_at=excluded.updated_at RETURNING *`).get(live.workspaceId,input.enabled?1:0,input.brokerEnabled?1:0,input.merchantEnabled?1:0,JSON.stringify([...new Set(input.reasons)]),JSON.stringify(input.localSchedule),input.channel,input.templateId??null,input.senderId??null,live.membershipId,clock,clock)
 if(!row)throw new Error('Document automation approval did not persist.')
 // The explicit merchant automation checkbox is also the company document opt-in.
 const policy=await getDatabase().prepare<{broker_enabled:number}>('SELECT broker_enabled FROM mca_notification_policies WHERE workspace_id=? AND kind=?').get(live.workspaceId,'document')
 await setNotificationPolicy(live,{kind:'document',brokerEnabled:policy?.broker_enabled!==0,merchantEnabled:input.merchantEnabled&&input.enabled})
 await recordAuditEvent({context:live,action:'document.automation_approved',resourceType:'document_notification_policy',resourceId:live.workspaceId,metadata:{version:row.approval_version,enabled:input.enabled,merchantEnabled:input.merchantEnabled,reasons:input.reasons}})
 return{...automationView(row),canManage:true,runtimeReady:process.env.MCA_NOTIFICATION_RUNTIME==='enabled'}
 })
}
export async function liveDocumentAutomation(workspaceId:string,version:number){
 const row=await getDatabase().prepare<DocumentAutomationRow>('SELECT * FROM mca_document_notification_discovery WHERE workspace_id=? AND enabled=1 AND approval_version=?').get(workspaceId,version)
 if(!row)return
 const actor=await liveEmailActor(workspaceId,row.approved_by_membership_id)
 requireNotificationAdmin(actor)
 return{row,actor}
}
