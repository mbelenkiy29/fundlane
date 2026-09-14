import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError, AppError } from "@/lib/mca/errors"
import { calendarActor } from "@/lib/mca/calendar/service"
import { resolveCalendarConflict } from "@/lib/mca/calendar/sync"
export const runtime = "nodejs"
export async function POST(request: Request, context: {params:Promise<{id:string}>}) {
  try {
    const actor=await calendarActor(request,true)
    const input=z.object({choice:z.enum(["local","google"]),version:z.number().int().positive(),etag:z.string().max(500)}).strict().safeParse(await request.json())
    if(!input.success) throw new AppError(422,"invalid_resolution","Choose a version of the current conflict.")
    await resolveCalendarConflict(actor,(await context.params).id,input.data)
    return NextResponse.json({queued:true})
  } catch(error) { return apiError(error) }
}
