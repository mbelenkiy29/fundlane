import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { registrationEvents } from "@/lib/mca/sms/registration-events"
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  try {
    return NextResponse.json(
      await registrationEvents((await context.params).workspaceId, request)
    )
  } catch (e) {
    return apiError(e)
  }
}
