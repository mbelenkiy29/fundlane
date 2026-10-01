import {NextResponse} from 'next/server'
import {apiError} from '@/lib/mca/errors'
import {requireDocumentActor} from '@/lib/mca/documents/http'
import {documentAutomationSchema,readDocumentAutomation,saveDocumentAutomation} from '@/lib/mca/documents/notification-automation'
import {readJson} from '@/lib/mca/http'
export const runtime='nodejs'
const headers={'cache-control':'no-store'}
export async function GET(request:Request){
 try{return NextResponse.json(await readDocumentAutomation(await requireDocumentActor(request,'read',{sessionOnly:true})),{headers})}catch(error){return apiError(error)}
}
export async function PUT(request:Request){
 try{
  const actor=await requireDocumentActor(request,'write',{sessionOnly:true})
  return NextResponse.json(await saveDocumentAutomation(actor,await readJson(request,documentAutomationSchema)),{headers})
 }catch(error){return apiError(error)}
}
