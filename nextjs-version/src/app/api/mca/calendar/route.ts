import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { calendarActor, calendarFeed, saveActivity } from "@/lib/mca/calendar/service"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try { return NextResponse.json(await calendarFeed(await calendarActor(request),new URL(request.url).searchParams),{headers:{"Cache-Control":"private, no-store"}}) } catch(error) { return apiError(error) }
}
export async function POST(request: Request) {
  try { return NextResponse.json(await saveActivity(await calendarActor(request,true),await request.json()),{status:201}) } catch(error) { return apiError(error) }
}
