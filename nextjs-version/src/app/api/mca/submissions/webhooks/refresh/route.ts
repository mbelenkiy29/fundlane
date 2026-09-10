import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { getSubmissionStatusBoard, pollActiveSubmissions, refreshSubmissionStatus } from "@/lib/mca/submissions/poll"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireSubmissionActor(request, "read")
    const dealId = new URL(request.url).searchParams.get("dealId") ?? ""
    return NextResponse.json(await getSubmissionStatusBoard(actor, dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireSubmissionActor(request, "write")
    let body: { jobId?: unknown; dealId?: unknown } = {}
    try {
      const text = await request.text()
      if (text.trim()) body = JSON.parse(text) as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : ""
    const dealId = typeof body.dealId === "string" ? body.dealId.trim() : ""
    if (jobId) {
      return NextResponse.json({ state: "success", ...await refreshSubmissionStatus(actor, jobId) }, { headers: noStore })
    }
    if (dealId) {
      const polled = await pollActiveSubmissions(actor, dealId)
      return NextResponse.json(polled, { headers: noStore })
    }
    throw new AppError(422, "validation_failed", "Review the highlighted fields.", {
      jobId: ["Select a submission job or deal to refresh."],
    })
  } catch (error) {
    return apiError(error)
  }
}
