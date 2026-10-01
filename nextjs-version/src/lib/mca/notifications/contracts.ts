import {z} from 'zod'
import type {DealActor} from '../deals/schema'

export const notificationInputSchema=z.object({
 eventKey:z.string().trim().min(1).max(160),kind:z.enum(['document','renewal']),dealId:z.string().min(1).max(80),
 audience:z.enum(['broker','merchant']),channel:z.enum(['email','sms']),recipientUserId:z.string().min(1).max(80).optional(),
 templateId:z.string().min(1).max(80).optional(),senderId:z.string().min(1).max(80).optional(),
 scheduledFor:z.iso.datetime(),approvedAt:z.iso.datetime(),
 payload:z.object({title:z.string().trim().min(1).max(200).refine(v=>!/[\r\n]/.test(v)),message:z.string().trim().min(1).max(2000)}).strict().optional(),
}).strict()
export type NotificationInput=z.infer<typeof notificationInputSchema>
export type NotificationState='queued'|'sending'|'retry'|'accepted'|'delivered'|'suppressed'|'failed'|'uncertain'
export type NotificationOutcome={state:'accepted'|'delivered'|'retry'|'failed'|'uncertain';providerMessageId?:string;errorCode?:string}
export type NotificationView={id:string;state:NotificationState;attempts:number;scheduledFor:string;providerMessageId?:string;errorCode?:string}
export type NotificationContent={recipient:string;subject?:string;text:string}
export type NotificationMessage=NotificationContent & {id:string;workspaceId:string;actor:DealActor;dealId:string;audience:'broker'|'merchant';channel:'email'|'sms';senderId?:string;approvedAt:string;idempotencyKey:string}
export type NotificationTransport=(message:NotificationMessage)=>Promise<NotificationOutcome>
export type NotificationRow={
 id:string;workspace_id:string;deal_id:string;event_key:string;kind:NotificationInput['kind'];audience:NotificationInput['audience'];channel:NotificationInput['channel'];
 recipient_user_id:string|null;actor_membership_id:string;template_id:string|null;sender_id:string|null;approved_at:string;scheduled_for:string;
 payload_cipher:string;content_cipher:string|null;recipient_hash:string;payload_hash:string;state:NotificationState;attempts:number;
 next_attempt_at:string;claim_token:string|null;lease_until:string|null;provider_message_id:string|null;error_code:string|null;created_at:string;updated_at:string;
}
