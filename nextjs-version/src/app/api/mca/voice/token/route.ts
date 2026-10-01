import {NextResponse} from "next/server"
import {apiError} from "@/lib/mca/errors"
import {requireVoiceActor} from "@/lib/mca/voice/http"
import {issueToken} from "@/lib/mca/voice/service"
export const runtime="nodejs"
const noStore={"cache-control":"no-store"}
export async function POST(request:Request){try{return NextResponse.json(await issueToken(await requireVoiceActor(request,true)),{headers:noStore})}catch(error){return apiError(error)}}
