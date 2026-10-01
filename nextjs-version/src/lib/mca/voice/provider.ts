import "server-only"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { AppError } from "../errors"
import { validateTwilioFormSignature } from "../sms/twilio"

export interface VoiceCredentials {
  accountSid: string; authToken: string; apiKeySid: string; apiKeySecret: string
  applicationSid: string; publicOrigin: string
}
export const VOICE_TOKEN_SECONDS = 300
export function identityFor(workspaceId: string, membershipId: string): string {
  return `fl_${createHash("sha256").update(JSON.stringify([workspaceId,membershipId])).digest("hex")}`
}
export function createVoiceToken(c: VoiceCredentials, identity: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_]{1,121}$/.test(identity) || !/^AC[0-9a-f]{32}$/i.test(c.accountSid) || !/^SK[0-9a-f]{32}$/i.test(c.apiKeySid) || !/^AP[0-9a-f]{32}$/i.test(c.applicationSid) || !c.apiKeySecret) throw new AppError(503,"voice_unconfigured","Browser calling is not configured.")
  const iat=Math.floor(now/1000), exp=iat+VOICE_TOKEN_SECONDS
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString("base64url")
  const header=encode({typ:"JWT",alg:"HS256",cty:"twilio-fpa;v=1"})
  const body=encode({jti:`${c.apiKeySid}-${randomUUID()}`,iss:c.apiKeySid,sub:c.accountSid,iat,nbf:iat,exp,grants:{identity,voice:{incoming:{allow:true},outgoing:{application_sid:c.applicationSid}}}})
  return {token:`${header}.${body}.${createHmac("sha256",c.apiKeySecret).update(`${header}.${body}`).digest("base64url")}`,expiresAt:new Date(exp*1000).toISOString()}
}
const escape=(s:string)=>s.replace(/[&<>"']/g,v=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[v]!))
export function normalizedPhone(phone: string): string {
  const value=phone.replace(/[\s().-]/g,"")
  const normalized=/^\d{10}$/.test(value)?`+1${value}`:value
  if(!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new AppError(422,"voice_phone_invalid","A valid international phone number is required.")
  return normalized
}
function dial(content:string,actionUrl:string,callerId?:string){
  const url=new URL(actionUrl)
  if(url.protocol!=="https:" || url.username || url.password) throw new AppError(503,"voice_origin_invalid","Configure HTTPS Voice callbacks.")
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial record="do-not-record" answerOnBridge="true" timeout="25" method="POST" action="${escape(actionUrl)}"${callerId?` callerId="${escape(callerId)}"`:""}>${content}</Dial></Response>`
}
export function outboundTwiml(from:string,to:string,actionUrl:string){return dial(`<Number>${escape(normalizedPhone(to))}</Number>`,actionUrl,normalizedPhone(from))}
export function inboundTwiml(identities:string[],actionUrl:string){
  if(!identities.length)return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>'
  if(identities.length>10 || identities.some(id=>!/^[A-Za-z0-9_]{1,121}$/.test(id)))throw new AppError(422,"voice_identity_invalid","Invalid browser recipient.")
  return dial(identities.map(id=>`<Client>${escape(id)}</Client>`).join(""),actionUrl)
}
export const hangupTwiml='<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
export async function verifyVoiceWebhook(request:Request,c:VoiceCredentials,canonicalUrl:string):Promise<URLSearchParams>{
  if(request.method!=="POST" || !request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded"))throw new AppError(415,"voice_form_required","Twilio form POST required.")
  const reader=request.body?.getReader(); const chunks:Uint8Array[]=[]; let size=0
  if(reader){try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new AppError(413,"voice_body_large","Voice callback is too large.")}chunks.push(value)}}finally{reader.releaseLock()}}
  const params=new URLSearchParams(Buffer.concat(chunks).toString("utf8")), seen=new Set<string>()
  for(const key of params.keys()){if(seen.has(key))throw new AppError(400,"voice_duplicate_field","Repeated callback field.");seen.add(key)}
  if(!validateTwilioFormSignature({authToken:c.authToken,signature:request.headers.get("x-twilio-signature")??"",url:canonicalUrl,params}))throw new AppError(401,"voice_signature_invalid","Invalid Twilio signature.")
  if(params.get("AccountSid")!==c.accountSid)throw new AppError(401,"voice_account_mismatch","Twilio account mismatch.")
  if(!/^CA[0-9a-f]{32}$/i.test(params.get("CallSid")??""))throw new AppError(422,"voice_call_invalid","Invalid call identity.")
  return params
}
