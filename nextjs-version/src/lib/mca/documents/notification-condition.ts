import 'server-only'
import {registerNotificationCondition} from '../notifications/conditions'
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
  if(!await activeDocumentCondition(actor,key))return false
  return key.linkId?{eligible:true,templateValues:await documentRequestValues(actor,key)}:true
 })
}
