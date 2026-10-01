import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { confirmSubmissions, getSubmissionSelection, requireSubmissionActor } from "@/lib/mca/submissions/queue"

import { prepareDealSubmission } from "@/lib/mca/submissions/broker-preview"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireSubmissionActor(request, "read")
    const dealId = (await context.params).dealId
    return NextResponse.json(await getSubmissionSelection(actor, dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireSubmissionActor(request, "write")
    const dealId = (await context.params).dealId
    let body: {
      action?: unknown
      previewId?: unknown
      funderIds?: unknown
      confirmationKey?: unknown
      analysisRunId?: unknown
      privilegedRetry?: unknown
      privilegedReason?: unknown
    }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (body.action === "preview") return NextResponse.json(await prepareDealSubmission(actor, dealId, body.funderIds), { headers: noStore })
    return NextResponse.json(await confirmSubmissions(actor, dealId, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
