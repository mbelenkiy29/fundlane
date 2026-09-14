import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireSubmissionActor } from "@/lib/mca/submissions/queue"
import { getSubmissionInsights } from "@/lib/mca/submissions/insights-query"
import { isInsightWindow } from "@/lib/mca/submissions/insights"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const window = new URL(request.url).searchParams.get("window") ?? "today"
    if (!isInsightWindow(window)) {
      throw new AppError(422, "invalid_filter", "window must be today, week, or month.")
    }
    return NextResponse.json(await getSubmissionInsights(await requireSubmissionActor(request, "read"), window), {
      headers: { "cache-control": "no-store" },
    })
  } catch (error) {
    return apiError(error)
  }
}
