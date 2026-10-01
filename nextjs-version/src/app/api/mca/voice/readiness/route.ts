import {NextResponse} from "next/server"
import {apiError} from "@/lib/mca/errors"
import {requireVoiceActor} from "@/lib/mca/voice/http"
import {resolveVoice} from "@/lib/mca/voice/readiness"
export const runtime="nodejs"
const noStore={"cache-control":"no-store"}
export async function GET(request:Request){try{const actor=await requireVoiceActor(request);return NextResponse.json((await resolveVoice(actor.workspaceId)).readiness,{headers:noStore})}catch(error){return apiError(error)}}
