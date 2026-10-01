import {NextResponse} from "next/server"
import {apiError} from "@/lib/mca/errors"
import {requireVoiceActor} from "@/lib/mca/voice/http"
import {cancelDialIntent} from "@/lib/mca/voice/service"
import {z} from "zod"
import {readJson} from "@/lib/mca/http"
export const runtime="nodejs"
const noStore={"cache-control":"no-store"}
const schema=z.object({intentId:z.string().min(1).max(80)}).strict()
export async function POST(request:Request){try{const actor=await requireVoiceActor(request,true);return NextResponse.json(await cancelDialIntent(actor,(await readJson(request,schema)).intentId),{headers:noStore})}catch(error){return apiError(error)}}
