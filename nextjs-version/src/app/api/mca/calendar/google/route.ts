import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError, AppError } from "@/lib/mca/errors"
import { calendarActor } from "@/lib/mca/calendar/service"
import { changeGoogleConnection, googleConnectionView } from "@/lib/mca/calendar/google"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try { return NextResponse.json(await googleConnectionView(await calendarActor(request)),{headers:{"Cache-Control":"private, no-store"}}) } catch(error) { return apiError(error) }
}
export async function PATCH(request: Request) {
  try {
    const actor=await calendarActor(request,true)
    const input=z.object({action:z.enum(["disconnect","select","sync"]),calendarIds:z.array(z.string().max(500)).max(20).optional()}).strict().safeParse(await request.json())
    if(!input.success) throw new AppError(422,"invalid_calendar_settings","Choose a valid calendar setting.")
    await changeGoogleConnection(actor,input.data)
    return NextResponse.json(await googleConnectionView(actor))
  } catch(error) { return apiError(error) }
}
