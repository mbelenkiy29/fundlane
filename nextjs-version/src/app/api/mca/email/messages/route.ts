import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSmsActor } from "@/lib/mca/sms/http"
const noStore = { "cache-control": "no-store" }
export const runtime = "nodejs"
import { readJson } from "@/lib/mca/http"
import { emailSendSchema } from "@/lib/mca/email-conversations/contracts"
import { queueEmail } from "@/lib/mca/email-conversations/service"
export async function POST(request: Request) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" })
    return NextResponse.json(
      await queueEmail(actor, await readJson(request, emailSendSchema)),
      { status: 202, headers: noStore }
    )
  } catch (error) {
    return apiError(error)
  }
}
