import 'server-only'
import {createHash} from 'node:crypto'
import {AppError} from '../errors'
import {Mailbox,EmailProviderError} from '../email-conversations/providers'
import {emailSender} from '../email-conversations/service'
import {sendSystemEmail,systemEmailCredentials} from '../system-email'
import {deliverClosingSms} from '../sms/service'
import type {NotificationMessage,NotificationOutcome} from './contracts'

/** Uses existing providers; uncertain acceptance must never be classified as retryable. */
export async function defaultNotificationTransport(message:NotificationMessage):Promise<NotificationOutcome>{
 if(message.channel==='sms'){
  if(!message.dealId)return{state:'failed',errorCode:'notification_deal_required'}
  const result=await deliverClosingSms(message.actor,{dealId:message.dealId,recipient:message.recipient,body:message.text,idempotencyKey:message.idempotencyKey,correlationId:message.id,payloadHash:createHash('sha256').update(message.text).digest('hex'),deliveryMode:'never_attempted'})
  return {state:result.state==='unknown'?'uncertain':result.state==='accepted'?'accepted':'failed',providerMessageId:result.externalId,errorCode:result.errorCode}
 }
 if(message.audience==='broker'){
  const credentials=systemEmailCredentials()
  if(!credentials)return{state:'failed',errorCode:'system_email_unconfigured'}
  try{
   const result=await sendSystemEmail({apiKey:credentials.apiKey,from:credentials.from,to:message.recipient,subject:message.subject??'Fundlane notification',text:message.text,html:`<p>${escapeHtml(message.text).replace(/\n/g,'<br>')}</p>`,idempotencyKey:message.idempotencyKey})
   return{state:'accepted',providerMessageId:result.emailId}
  }catch(error){
   const status=error instanceof AppError?error.extra?.providerStatus:undefined
   return{state:status===429?'retry':typeof status==='number'&&[400,401,403,422].includes(status)?'failed':'uncertain',errorCode:status===429?'rate_limited':'system_email_send_failed'}
  }
 }
 const sender=await emailSender(message.actor,message.senderId??'',true)
 const mailbox=new Mailbox(sender)
 try{
  await mailbox.connect()
  const result=await mailbox.send({id:message.id,internetId:`<${message.id}@notifications.fundlane>`,to:message.recipient,subject:message.subject??'Fundlane notification',body:message.text})
  return{state:'accepted',providerMessageId:result.id}
 }catch(error){
  if(error instanceof EmailProviderError)return{state:error.uncertain?'uncertain':error.status===429?'retry':'failed',errorCode:'mailbox_send_failed'}
  return{state:'uncertain',errorCode:'mailbox_outcome_unknown'}
 }
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!))
