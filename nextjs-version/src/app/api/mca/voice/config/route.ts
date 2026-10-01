import {NextResponse} from "next/server"
import {apiError} from "@/lib/mca/errors"
import {requireVoiceActor} from "@/lib/mca/voice/http"
import {configureVoice} from "@/lib/mca/voice/service"
import {z} from "zod"
import {readJson} from "@/lib/mca/http"
export const runtime="nodejs"
const noStore={"cache-control":"no-store"}
const schema=z.object({numberId:z.string().min(1).max(80),applicationSid:z.string().regex(/^AP[0-9a-f]{32}$/i),callbacksConfirmed:z.boolean()}).strict()
export async function POST(request:Request){try{const actor=await requireVoiceActor(request,true);return NextResponse.json(await configureVoice(actor,await readJson(request,schema)),{headers:noStore})}catch(error){return apiError(error)}}
