import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { receiveGoogleNotification } from "@/lib/mca/calendar/google"
export const runtime = "nodejs"
export async function POST(request: Request) {
  try { await receiveGoogleNotification(request);return new NextResponse(null,{status:204}) } catch(error) { return apiError(error) }
}
