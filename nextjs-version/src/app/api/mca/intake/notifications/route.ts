import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireApplicationActor } from "@/lib/mca/intake/review"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { listApplicationNotifications, markApplicationNotificationRead } from "@/lib/mca/intake/notifications"
export const runtime="nodejs"
const headers={"cache-control":"no-store"}
export async function GET(request:Request) {
  try {
    const actor=await requireApplicationActor(request,"read")
    return NextResponse.json(await listApplicationNotifications(actor),{headers})
  } catch(error) { return apiError(error) }
}
export async function POST(request:Request) {
  try {
    assertTrustedMutation(request)
    const actor=await requireApplicationActor(request,"read")
    let body:{id?:unknown}
    try { body=await request.json();if(!body || typeof body!=="object" || Array.isArray(body)) throw new Error() }
    catch { throw new AppError(400,"invalid_json","Request body must be a JSON object.") }
    await markApplicationNotificationRead(actor,body.id)
    return NextResponse.json({ok:true},{headers})
  } catch(error) { return apiError(error) }
}
