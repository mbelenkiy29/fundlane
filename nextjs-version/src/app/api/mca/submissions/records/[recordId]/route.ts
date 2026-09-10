import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"
import { getSubmissionDashboardDetail } from "@/lib/mca/submissions/dashboard"
export const runtime = "nodejs"
export async function GET(
  request: Request,
  context: { params: Promise<{ recordId: string }> }
) {
  try {
    return NextResponse.json(
      await getSubmissionDashboardDetail(
        await requireSubmissionActor(request, "read"),
        (await context.params).recordId
      ),
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    return apiError(error)
  }
}
