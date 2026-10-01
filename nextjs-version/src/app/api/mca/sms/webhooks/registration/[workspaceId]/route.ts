import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { registrationEvents } from "@/lib/mca/sms/registration-events"
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const result = await registrationEvents((await context.params).workspaceId, request)
    return result.received ? NextResponse.json(result) : new Response(null, { status: 204 })
  } catch (e) {
    return apiError(e)
  }
}
