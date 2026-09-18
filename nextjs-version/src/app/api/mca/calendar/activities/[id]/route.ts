import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { calendarActor, saveActivity } from "@/lib/mca/calendar/service"
export const runtime = "nodejs"
export async function PATCH(request: Request, context: {params:Promise<{id:string}>}) {
  try { return NextResponse.json(await saveActivity(await calendarActor(request,true),await request.json(),(await context.params).id)) } catch(error) { return apiError(error) }
}
