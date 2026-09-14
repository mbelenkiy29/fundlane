import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin } from "@/lib/mca/http"
import { brokerIntakeLink, sendBrokerIntakeEmail } from "@/lib/mca/intake/native-apply"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireSubmissionActor(request, "read")
    return NextResponse.json(await brokerIntakeLink(actor, appOrigin(request)), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireSubmissionActor(request, "write")
    let body: { email?: string; membershipId?: string } = {}
    try {
      body = await request.json() as { email?: string; membershipId?: string }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (!body.email?.trim()) {
      return NextResponse.json(await brokerIntakeLink(actor, appOrigin(request), body.membershipId), { headers: { "cache-control": "no-store" } })
    }
    return NextResponse.json(await sendBrokerIntakeEmail(actor, appOrigin(request), body.email, body.membershipId))
  } catch (error) {
    return apiError(error)
  }
}
