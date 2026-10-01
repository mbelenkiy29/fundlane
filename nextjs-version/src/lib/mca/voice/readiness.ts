import "server-only"
import { getDatabase } from "../db"
import { company,provider } from "../sms/onboarding"
import { getCompanyNumberOwnership } from "../sms/number-ownership"
import { numberBlockers } from "./policy"
import { AppError } from "../errors"
import type { VoiceCredentials } from "./provider"
import type { VoiceReadiness } from "./contracts"
export interface VoiceConfig {workspace_id:string;number_id:string;application_sid:string;callbacks_confirmed:number}
export async function resolveVoice(workspaceId:string){
 const config=await getDatabase().prepare<VoiceConfig>("SELECT * FROM voice_config WHERE workspace_id=?").get(workspaceId)
 const c=await company(workspaceId),p=c?provider(c):undefined
 const number=config?await getCompanyNumberOwnership(workspaceId,config.number_id):undefined
 const blockers=numberBlockers(number,p?.accountSid)
 let publicOrigin=""
 try{const u=new URL(process.env.MCA_VOICE_PUBLIC_ORIGIN??process.env.MCA_APP_ORIGIN??"");if(u.protocol!=="https:"||u.username||u.password||u.pathname!=="/"||u.search||u.hash)throw Error();publicOrigin=u.origin}catch{blockers.push("Configure the public HTTPS Voice callback origin.")}
 if(!p?.apiKeySid||!/^SK[0-9a-f]{32}$/i.test(p.apiKeySid)||!p.apiKeySecret)blockers.push("Voice API signing credentials are not configured.")
 if(!config||!/^AP[0-9a-f]{32}$/i.test(config.application_sid))blockers.push("Select the company's existing TwiML Voice application.")
 if(!config?.callbacks_confirmed)blockers.push("An administrator must confirm the Voice application and number callbacks are configured.")
 const readiness:VoiceReadiness={ready:!blockers.length,numberId:config?.number_id??null,phone:number?.phone??null,recording:"off",blockers}
 const credentials:VoiceCredentials|undefined=!blockers.length?{accountSid:p!.accountSid,authToken:p!.authToken,apiKeySid:p!.apiKeySid!,apiKeySecret:p!.apiKeySecret!,applicationSid:config!.application_sid,publicOrigin}:undefined
 return {readiness,credentials,number,config}
}
export async function readyVoice(workspaceId:string){const result=await resolveVoice(workspaceId);if(!result.credentials||!result.number)throw new AppError(503,"voice_not_ready","Browser calling setup is incomplete.");return {...result,credentials:result.credentials,number:result.number}}
