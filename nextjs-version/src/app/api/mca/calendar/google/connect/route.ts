import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { calendarActor } from "@/lib/mca/calendar/service"
import { beginGoogleAuthorization } from "@/lib/mca/calendar/google"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor=await calendarActor(request,true)
    await consumeRequestRateLimit(`calendar-oauth:${actor.userId}`,10)
    return NextResponse.json({url:await beginGoogleAuthorization(actor)})
  } catch(error) { return apiError(error) }
}
