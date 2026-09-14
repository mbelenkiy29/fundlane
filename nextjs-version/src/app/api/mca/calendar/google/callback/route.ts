import { NextResponse } from "next/server"
import { calendarActor } from "@/lib/mca/calendar/service"
import { finishGoogleAuthorization } from "@/lib/mca/calendar/google"
export const runtime = "nodejs"
export async function GET(request: Request) {
  const url=new URL(request.url)
  const destination=new URL("/calendar",process.env.MCA_APP_ORIGIN??url.origin)
  try {
    const actor=await calendarActor(request)
    if(url.searchParams.has("error")) throw new Error("Authorization declined")
    await finishGoogleAuthorization(actor,url.searchParams.get("state")??"",url.searchParams.get("code")??"")
    destination.searchParams.set("google","connected")
  } catch { destination.searchParams.set("google","failed") }
  return NextResponse.redirect(destination)
}
