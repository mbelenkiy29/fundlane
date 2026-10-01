import { AppError } from "../errors"
import type { CompanyNumberOwnership } from "../sms/number-ownership"
export function assertVoiceActor(actor:{authType?:string;source?:string;userId:string|null;membershipId:string|null;role:string|null}){
 if((actor.source!==undefined?actor.source!=="user":actor.authType!=="session") || !actor.userId || !actor.membershipId || !["rep","manager","admin","super_admin"].includes(actor.role??""))throw new AppError(403,"voice_session_required","Calling requires an active company user session.")
}
export function numberBlockers(n:Pick<CompanyNumberOwnership,"state"|"companySuspended"|"providerConfigured"|"providerAccountSid">|undefined,accountSid?:string){
 const blockers:string[]=[]
 if(!n)blockers.push("Select an existing company-owned number.")
 else{if(!["active","registering","registration_failed"].includes(n.state))blockers.push("The designated number is unavailable.");if(n.companySuspended)blockers.push("Company communications are suspended.");if(!n.providerConfigured || n.providerAccountSid!==accountSid)blockers.push("Company Twilio credentials are unavailable.")}
 return blockers
}
export function terminalOutcome(direction:string,status:string):string{
 if(!["completed","busy","no-answer","failed","canceled"].includes(status))throw new AppError(422,"voice_status_invalid","Unsupported call outcome.")
 return direction==="inbound" && status!=="completed"?"missed":status
}
