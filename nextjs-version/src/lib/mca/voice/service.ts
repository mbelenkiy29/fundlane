import "server-only"
import { getDatabase,withImmediateTransaction,newId,nowIso,type DbExecutor } from "../db"
import { encryptSensitive,decryptSensitive } from "../crypto"
import { AppError } from "../errors"
import { actorForDeals,getDealForDocument } from "../deals/service"
import { assertCompanyOperational } from "../company-access"
import { getWorkspaceSettings } from "../workspaces"
import { enqueueNotification } from "../notifications/service"
import { liveEmailActor } from "../email-conversations/service"
import { consumeRequestRateLimit } from "../auth"
import type { DealActor } from "../deals/schema"
import { assertVoiceActor,terminalOutcome } from "./policy"
import { readyVoice,resolveVoice,voiceOutcomeCredentials } from "./readiness"
import { createVoiceToken,identityFor,verifyVoiceWebhook,normalizedPhone,inboundTwiml,outboundTwiml,hangupTwiml } from "./provider"
import type { VoiceHistoryItem } from "./contracts"

interface Member {id:string;user_id:string;role:"rep"|"manager"|"admin"|"super_admin"}
async function activeActor(actor:DealActor){
 assertVoiceActor(actor);await assertCompanyOperational(actor.workspaceId)
 const m=await getDatabase().prepare<Member>("SELECT id,user_id,role FROM memberships WHERE workspace_id=? AND id=? AND user_id=? AND status='active'").get(actor.workspaceId,actor.membershipId,actor.userId)
 if(!m || m.role!==actor.role)throw new AppError(403,"voice_membership_required","An active company membership is required.")
 if(!(await getWorkspaceSettings(actor.workspaceId)).pageVisibility.deals)throw new AppError(403,"page_disabled","Calling is disabled for this company.")
 return m
}
export async function configureVoice(actor:DealActor,input:{numberId:string;applicationSid:string;callbacksConfirmed:boolean}){
 await activeActor(actor)
 if(!["admin","super_admin"].includes(actor.role??""))throw new AppError(403,"voice_admin_required","An administrator must configure calling.")
 const {getCompanyNumberOwnership}=await import("../sms/number-ownership")
 const number=await getCompanyNumberOwnership(actor.workspaceId,input.numberId)
 if(!number || ["released","releasing"].includes(number.state))throw new AppError(404,"voice_number_missing","Select an available company-owned number.")
 if(!/^AP[0-9a-f]{32}$/i.test(input.applicationSid))throw new AppError(422,"voice_application_invalid","A valid existing TwiML application SID is required.")
 await getDatabase().prepare(`INSERT INTO voice_config(workspace_id,number_id,application_sid,callbacks_confirmed,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET number_id=excluded.number_id,application_sid=excluded.application_sid,callbacks_confirmed=excluded.callbacks_confirmed,updated_at=excluded.updated_at`).run(actor.workspaceId,input.numberId,input.applicationSid,input.callbacksConfirmed?1:0,nowIso())
 return (await resolveVoice(actor.workspaceId)).readiness
}
export async function issueToken(actor:DealActor){
 await activeActor(actor);await consumeRequestRateLimit(`voice-token:${actor.workspaceId}:${actor.membershipId}`,10)
 const {credentials}=await readyVoice(actor.workspaceId),identity=identityFor(actor.workspaceId,actor.membershipId!)
 return {...createVoiceToken(credentials,identity),identity,recording:"off" as const}
}
export async function setPresence(actor:DealActor,enabled:boolean){
 await activeActor(actor)
 if(!enabled){await getDatabase().prepare("DELETE FROM voice_presence WHERE workspace_id=? AND membership_id=?").run(actor.workspaceId,actor.membershipId);return {enabled:false}}
 await readyVoice(actor.workspaceId)
 await getDatabase().prepare(`INSERT INTO voice_presence(workspace_id,membership_id,identity,expires_at) VALUES (?,?,?,?) ON CONFLICT(workspace_id,membership_id) DO UPDATE SET identity=excluded.identity,expires_at=excluded.expires_at`).run(actor.workspaceId,actor.membershipId,identityFor(actor.workspaceId,actor.membershipId!),new Date(Date.now()+300_000).toISOString())
 return {enabled:true}
}
export async function createDialIntent(actor:DealActor,dealId:string){
 await activeActor(actor);await consumeRequestRateLimit(`voice-dial:${actor.workspaceId}:${actor.membershipId}`,10)
 const {number}=await readyVoice(actor.workspaceId),deal=await getDealForDocument(actor,dealId),phone=normalizedPhone(deal.contactPhone??"")
 const id=newId(),expiresAt=new Date(Date.now()+60_000).toISOString()
 await getDatabase().prepare("INSERT INTO voice_dial_intents(id,workspace_id,membership_id,deal_id,number_id,phone_cipher,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id,actor.workspaceId,actor.membershipId,deal.id,number.numberId,encryptSensitive(phone,actor.workspaceId),expiresAt,nowIso())
 return {intentId:id,expiresAt}
}
export async function cancelDialIntent(actor:DealActor,id:string){await activeActor(actor);await getDatabase().prepare("UPDATE voice_dial_intents SET canceled_at=? WHERE workspace_id=? AND membership_id=? AND id=? AND consumed_at IS NULL").run(nowIso(),actor.workspaceId,actor.membershipId,id);return {canceled:true}}
const callbackUrl=(origin:string,workspaceId:string,kind:string)=>`${origin}/api/mca/voice/webhooks/${encodeURIComponent(workspaceId)}/${kind}`
async function verified(request:Request,workspaceId:string,kind:string){await assertCompanyOperational(workspaceId);if(!(await getWorkspaceSettings(workspaceId)).pageVisibility.deals)throw new AppError(403,"page_disabled","Calling is disabled for this company.");const ready=await readyVoice(workspaceId);const params=await verifyVoiceWebhook(request,ready.credentials,callbackUrl(ready.credentials.publicOrigin,workspaceId,kind));return {...ready,params}}
interface CallRow {id:string;workspace_id:string;number_id:string;account_sid:string;provider_call_sid:string;membership_id:string|null;recipient_memberships:string;deal_id:string|null;direction:"inbound"|"outbound";state:string;phone_cipher:string;company_phone_cipher:string;terminal_at:string|null;created_at:string}
async function enqueueMissed(row:CallRow,db:DbExecutor){
 const ids=JSON.parse(row.recipient_memberships) as string[]
 const clock=row.terminal_at??row.created_at
 for(const membershipId of ids){
  const member=await db.prepare<{user_id:string}>("SELECT user_id FROM memberships WHERE workspace_id=? AND id=? AND status='active'").get(row.workspace_id,membershipId)
  if(!member)continue
  try{
   const actor=await liveEmailActor(row.workspace_id,membershipId)
   await enqueueNotification(actor,{eventKey:`voice-missed:${row.provider_call_sid}`,kind:"missed_call",audience:"broker",channel:"email",recipientUserId:member.user_id,scheduledFor:clock,approvedAt:clock,payload:{title:"Missed company call",message:`Missed call from ${decryptSensitive(row.phone_cipher,row.workspace_id)} to ${decryptSensitive(row.company_phone_cipher,row.workspace_id)}. Open Fundlane call history to follow up.`}},{executor:db})
  }catch(error){if(!(error instanceof AppError)||!["notification_suppressed","notification_policy_disabled","notification_recipient_unavailable","email_member_inactive","page_disabled","company_access_paused","company_paused"].includes(error.code))throw error}
 }
 await db.prepare("UPDATE voice_calls SET alert_pending=0 WHERE workspace_id=? AND id=?").run(row.workspace_id,row.id)
}
export async function handleOutbound(request:Request,workspaceId:string){
 const {params,credentials,number}=await verified(request,workspaceId,"outbound")
 const callSid=params.get("CallSid")!,intentId=params.get("IntentId")??""
 return withImmediateTransaction(async db=>{
  const intent=await db.prepare<{id:string;membership_id:string;deal_id:string;number_id:string;phone_cipher:string;expires_at:string;consumed_at:string|null;canceled_at:string|null}>("SELECT * FROM voice_dial_intents WHERE workspace_id=? AND id=? FOR UPDATE").get(workspaceId,intentId)
  if(!intent || intent.canceled_at || intent.number_id!==number.numberId || params.get("From")!==`client:${identityFor(workspaceId,intent.membership_id)}`)throw new AppError(403,"voice_intent_invalid","The dial request is invalid.")
  const m=await db.prepare<Member>("SELECT id,user_id,role FROM memberships WHERE workspace_id=? AND id=? AND status='active'").get(workspaceId,intent.membership_id)
  if(!m)throw new AppError(403,"voice_membership_required","Calling membership is inactive.")
  const actor=await actorForDeals({authType:"session",workspaceId,userId:m.user_id,membershipId:m.id,role:m.role,scopes:[],sessionId:null})
  const deal=await getDealForDocument(actor,intent.deal_id),phone=decryptSensitive(intent.phone_cipher,workspaceId)
  if(normalizedPhone(deal.contactPhone??"")!==phone)throw new AppError(409,"voice_destination_changed","The merchant phone changed. Start a new call.")
  const existing=await db.prepare<CallRow>("SELECT * FROM voice_calls WHERE workspace_id=? AND provider_call_sid=?").get(workspaceId,callSid)
  if(intent.consumed_at){if(!existing||existing.deal_id!==intent.deal_id||existing.membership_id!==m.id||existing.terminal_at)throw new AppError(409,"voice_intent_used","The dial request was already used.");return outboundTwiml(number.phone,phone,callbackUrl(credentials.publicOrigin,workspaceId,"outcome"))}
  if(intent.expires_at<=nowIso())throw new AppError(410,"voice_intent_expired","The dial request expired.")
  await db.prepare("UPDATE voice_dial_intents SET consumed_at=? WHERE workspace_id=? AND id=?").run(nowIso(),workspaceId,intent.id)
  await db.prepare("INSERT INTO voice_calls(id,workspace_id,number_id,account_sid,provider_call_sid,membership_id,deal_id,direction,state,phone_cipher,company_phone_cipher,created_at) VALUES (?,?,?,?,?,?,?,'outbound','ringing',?,?,?)").run(newId(),workspaceId,number.numberId,credentials.accountSid,callSid,m.id,deal.id,intent.phone_cipher,encryptSensitive(number.phone,workspaceId),nowIso())
  return outboundTwiml(number.phone,phone,callbackUrl(credentials.publicOrigin,workspaceId,"outcome"))
 })
}
export async function handleInbound(request:Request,workspaceId:string){
 const {params,credentials,number}=await verified(request,workspaceId,"inbound")
 if(params.get("To")!==number.phone)throw new AppError(401,"voice_number_mismatch","The called number does not match the company.")
 const phone=normalizedPhone(params.get("From")??""),callSid=params.get("CallSid")!
 return withImmediateTransaction(async db=>{
  await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`voice-inbound:${workspaceId}:${callSid}`)
  let row=await db.prepare<CallRow>("SELECT * FROM voice_calls WHERE workspace_id=? AND provider_call_sid=?").get(workspaceId,callSid)
  if(row && (row.direction!=="inbound" || decryptSensitive(row.phone_cipher,workspaceId)!==phone || row.number_id!==number.numberId))throw new AppError(409,"voice_call_mismatch","Call identity mismatch.")
  if(row?.terminal_at)return hangupTwiml
  const recipients=await db.prepare<{membership_id:string;identity:string}>(`SELECT p.membership_id,p.identity FROM voice_presence p JOIN memberships m ON m.id=p.membership_id AND m.workspace_id=p.workspace_id WHERE p.workspace_id=? AND p.expires_at>? AND m.status='active' AND m.role IN ('rep','manager','admin','super_admin') ORDER BY p.membership_id LIMIT 10`).all(workspaceId,nowIso())
  const fallback=recipients.length?[]:await db.prepare<{id:string}>("SELECT id FROM memberships WHERE workspace_id=? AND status='active' AND role IN ('admin','super_admin') ORDER BY id LIMIT 10").all(workspaceId)
  const ids=row?JSON.parse(row.recipient_memberships) as string[]:[...recipients.map(r=>r.membership_id),...fallback.map(r=>r.id)]
  const identities=recipients.filter(r=>ids.includes(r.membership_id)).map(r=>r.identity)
  if(!row){await db.prepare("INSERT INTO voice_calls(id,workspace_id,number_id,account_sid,provider_call_sid,recipient_memberships,direction,state,phone_cipher,company_phone_cipher,terminal_at,alert_pending,created_at) VALUES (?,?,?,?,?,?,'inbound',?,?,?,?,?,?)").run(newId(),workspaceId,number.numberId,credentials.accountSid,callSid,JSON.stringify(ids),identities.length?"ringing":"missed",encryptSensitive(phone,workspaceId),encryptSensitive(number.phone,workspaceId),identities.length?null:nowIso(),identities.length?0:1,nowIso());row=await db.prepare<CallRow>("SELECT * FROM voice_calls WHERE workspace_id=? AND provider_call_sid=?").get(workspaceId,callSid)}
  if(!identities.length && row){const clock=nowIso();await db.prepare("UPDATE voice_calls SET state='missed',terminal_at=?,alert_pending=1 WHERE workspace_id=? AND id=? AND terminal_at IS NULL").run(clock,workspaceId,row.id);await enqueueMissed({...row,state:"missed",terminal_at:clock},db)}
  return inboundTwiml(identities,callbackUrl(credentials.publicOrigin,workspaceId,"outcome"))
 })
}
export async function handleOutcome(request:Request,workspaceId:string){
 const credentials=await voiceOutcomeCredentials(workspaceId),params=await verifyVoiceWebhook(request,credentials,callbackUrl(credentials.publicOrigin,workspaceId,"outcome"))
 return withImmediateTransaction(async db=>{
  const row=await db.prepare<CallRow>("SELECT * FROM voice_calls WHERE workspace_id=? AND provider_call_sid=? FOR UPDATE").get(workspaceId,params.get("CallSid"))
  if(!row || row.account_sid!==credentials.accountSid)throw new AppError(404,"voice_call_missing","Call history was not found.")
  if(row.direction==="inbound" && (params.get("To")!==decryptSensitive(row.company_phone_cipher,workspaceId)||params.get("From")!==decryptSensitive(row.phone_cipher,workspaceId)))throw new AppError(401,"voice_number_mismatch","Call endpoint mismatch.")
  if(row.direction==="outbound" && params.get("From")!==`client:${identityFor(workspaceId,row.membership_id!)}`)throw new AppError(401,"voice_identity_mismatch","Calling identity mismatch.")
  const state=terminalOutcome(row.direction,params.get("DialCallStatus")??"")
  if(!row.terminal_at){const clock=nowIso();await db.prepare("UPDATE voice_calls SET state=?,terminal_at=?,alert_pending=? WHERE workspace_id=? AND id=? AND terminal_at IS NULL").run(state,clock,state==="missed"?1:0,workspaceId,row.id)
   if(state==="missed")await enqueueMissed({...row,state,terminal_at:clock},db)
  }
  return hangupTwiml
 })
}
export async function listVoiceHistory(actor:DealActor):Promise<VoiceHistoryItem[]>{
 await activeActor(actor)
 const rows=await getDatabase().prepare<CallRow>("SELECT * FROM voice_calls WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(actor.workspaceId)
 return rows.filter(row=>["admin","super_admin"].includes(actor.role??"") || row.membership_id===actor.membershipId || (JSON.parse(row.recipient_memberships) as string[]).includes(actor.membershipId!)).map(row=>({id:row.provider_call_sid,direction:row.direction,state:row.state,phone:decryptSensitive(row.phone_cipher,actor.workspaceId),dealId:row.deal_id,createdAt:row.created_at}))
}
