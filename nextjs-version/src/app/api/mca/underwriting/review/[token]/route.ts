import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireAnalysisActor } from "@/lib/mca/underwriting/analysis"
import { confirmAnalysisReview, getReviewByToken } from "@/lib/mca/underwriting/review-mail"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ token: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireAnalysisActor(request, "read")
    return NextResponse.json(await getReviewByToken(actor, (await context.params).token), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAnalysisActor(request, "write")
    let body: { selectedFunderIds?: unknown }
    try {
      body = await request.json() as { selectedFunderIds?: unknown }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await confirmAnalysisReview(actor, {
      token: (await context.params).token,
      selectedFunderIds: body.selectedFunderIds,
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
