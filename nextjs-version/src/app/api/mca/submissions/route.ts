import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"
import { listSubmissionDashboard } from "@/lib/mca/submissions/dashboard"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    return NextResponse.json(
      await listSubmissionDashboard(
        await requireSubmissionActor(request, "read"),
        new URL(request.url).searchParams
      ),
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}
