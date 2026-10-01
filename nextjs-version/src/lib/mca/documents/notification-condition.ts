import 'server-only'
import {getDatabase} from '../db'
import {registerNotificationCondition} from '../notifications/conditions'
import {liveDocumentAutomation} from './notification-automation'
import {activeDocumentCondition,documentConditionKeySchema,documentRequestValues} from './notification-state'
/** Called by both document producer and scheduled-runtime bootstrap in each process. */
export function registerDocumentNotificationCondition(){
 registerNotificationCondition('document',async(actor,condition)=>{
  if(condition.version!=='1')return false
  let raw:unknown
  try{raw=JSON.parse(condition.key)}catch{return false}
  const parsed=documentConditionKeySchema.safeParse(raw)
  if(!parsed.success)return false
  const key=parsed.data
  const current=await activeDocumentCondition(actor,key)
  if(!current)return false
  if(key.automationVersion){
   if(!key.audience)return false
   const config=await liveDocumentAutomation(actor.workspaceId,key.automationVersion)
   if(!config||!JSON.parse(config.row.reasons_json).includes(current.reason))return false
   if(key.audience==='merchant'?!config.row.merchant_enabled:!config.row.broker_enabled)return false
   const unknown=await getDatabase().prepare<{id:string}>(`SELECT id FROM mca_notifications WHERE workspace_id=? AND deal_id=? AND kind='document' AND audience=? AND state='uncertain' AND (audience='merchant' OR recipient_user_id=?) LIMIT 1`).get(actor.workspaceId,key.dealId,key.audience,key.recipientUserId??null)
   if(unknown)return false
   if(key.audience==='broker'){
    if(!key.recipientUserId)return false
    const assignment=await getDatabase().prepare<{id:string}>(`SELECT m.id FROM deal_assignments a JOIN memberships m ON m.workspace_id=a.workspace_id AND m.id=a.membership_id WHERE a.workspace_id=? AND a.deal_id=? AND a.kind IN ('originator','closer') AND m.status='active' AND m.user_id=? LIMIT 1`).get(actor.workspaceId,key.dealId,key.recipientUserId)
    if(!assignment)return false
   }
  }
  return key.linkId?{eligible:true,templateValues:await documentRequestValues(actor,key)}:true
 })
}
