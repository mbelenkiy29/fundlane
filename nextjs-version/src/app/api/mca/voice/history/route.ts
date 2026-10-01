import {NextResponse} from "next/server"
import {apiError} from "@/lib/mca/errors"
import {requireVoiceActor} from "@/lib/mca/voice/http"
import {listVoiceHistory} from "@/lib/mca/voice/service"
export const runtime="nodejs"
const noStore={"cache-control":"no-store"}
export async function GET(request:Request){try{return NextResponse.json({calls:await listVoiceHistory(await requireVoiceActor(request))},{headers:noStore})}catch(error){return apiError(error)}}
