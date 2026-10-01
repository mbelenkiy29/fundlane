import {apiError} from "@/lib/mca/errors"
import {handleOutbound} from "@/lib/mca/voice/service"
export const runtime="nodejs"
export async function POST(request:Request,context:{params:Promise<{workspaceId:string}>}){try{const {workspaceId}=await context.params;return new Response(await handleOutbound(request,workspaceId),{headers:{"content-type":"text/xml; charset=utf-8","cache-control":"no-store"}})}catch(error){return apiError(error)}}
