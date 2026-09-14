import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSmsActor } from "@/lib/mca/sms/http"
import { retryEmail } from "@/lib/mca/email-conversations/service"
export const runtime = "nodejs"
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" })
    return NextResponse.json(
      await retryEmail(actor, (await context.params).id),
      { status: 202, headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}
