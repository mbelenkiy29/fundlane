import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { completePortalTask, listPortalBoard, openPortalTask } from "@/lib/mca/submissions/portal"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireSubmissionActor(request, "read")
    const dealId = (await context.params).dealId
    return NextResponse.json(await listPortalBoard(actor, dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireSubmissionActor(request, "write")
    const dealId = (await context.params).dealId
    let body: { jobId?: unknown; action?: unknown; externalRef?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const action = typeof body.action === "string" ? body.action.trim() : ""
    if (action === "open") {
      return NextResponse.json(await openPortalTask(actor, dealId, body.jobId), { headers: noStore })
    }
    if (action === "complete") {
      return NextResponse.json(await completePortalTask(actor, dealId, body), { headers: noStore })
    }
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", { action: ["Choose open or complete."] })
  } catch (error) {
    return apiError(error)
  }
}
