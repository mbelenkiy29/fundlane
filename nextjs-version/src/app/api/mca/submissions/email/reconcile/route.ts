import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireReplyAdmin } from "@/lib/mca/submissions/replies"
import { reconcileUncertainEmailDelivery } from "@/lib/mca/submissions/outbox"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const actor = await requireReplyAdmin(request)
    let input: { jobId?: unknown; outcome?: unknown; evidence?: unknown }
    try { input = await request.json() as typeof input }
    catch { throw new AppError(400, "invalid_json", "Request body must be valid JSON.") }
    if (typeof input.jobId !== "string" || !input.jobId.trim()) throw new AppError(422, "validation_failed", "Choose a submission job.")
    const job = await reconcileUncertainEmailDelivery(actor, input.jobId, input)
    return NextResponse.json({ jobId: job.id, state: job.state, reason: job.reason }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
