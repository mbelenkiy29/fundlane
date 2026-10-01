import {NextResponse} from 'next/server'
import {apiError,AppError} from '@/lib/mca/errors'
import {requireDocumentActor} from '@/lib/mca/documents/http'
import {documentNotificationSnapshot,enqueueDocumentNotifications,documentNotificationInputSchema} from '@/lib/mca/documents/notification-service'
import {readJson} from '@/lib/mca/http'
import {getDatabase} from '@/lib/mca/db'
import {listSenders} from '@/lib/mca/senders/service'
export const runtime='nodejs'
const headers={'cache-control':'no-store'}
export async function GET(request:Request){
 try{
  const actor=await requireDocumentActor(request,'read',{sessionOnly:true}),dealId=new URL(request.url).searchParams.get('dealId')
  if(!dealId)throw new AppError(422,'deal_id_required','Choose a deal to review document alerts.')
  const snapshot=await documentNotificationSnapshot(actor,dealId)
  const [templates,senders]=await Promise.all([
   getDatabase().prepare<{id:string;name:string;channel:'email'|'sms'}>(`SELECT t.id,t.name,t.channel FROM mca_message_templates t JOIN mca_message_template_versions v ON v.workspace_id=t.workspace_id AND v.id=t.published_version_id WHERE t.workspace_id=? AND t.scope IN ('merchant','followup','request_info') AND v.body LIKE ? ORDER BY t.name`).all(actor.workspaceId,'%{{document_request_url}}%'),
   listSenders(actor),
  ])
  return NextResponse.json({...snapshot,templates,senders:senders.senders.filter(sender=>sender.purpose==='merchant'&&sender.state==='verified').map(sender=>({id:sender.id,label:sender.fromAddress}))},{headers})
 }catch(error){return apiError(error)}
}
export async function POST(request:Request){
 try{
  const actor=await requireDocumentActor(request,'write',{sessionOnly:true})
  const input=await readJson(request,documentNotificationInputSchema)
  return NextResponse.json(await enqueueDocumentNotifications(actor,input),{headers,status:202})
 }catch(error){return apiError(error)}
}
