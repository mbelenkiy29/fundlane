import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin } from "@/lib/mca/http"
import { requireAnalysisActor } from "@/lib/mca/underwriting/analysis"
import { getReviewSettings, sendAnalysisReview } from "@/lib/mca/underwriting/review-mail"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireAnalysisActor(request, "read")
    return NextResponse.json(await getReviewSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAnalysisActor(request, "write")
    let body: { dealId?: unknown; origin?: unknown }
    try {
      body = await request.json() as { dealId?: unknown; origin?: unknown }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    if (typeof body.dealId !== "string" || !body.dealId.trim()) {
      throw new AppError(422, "validation_failed", "A deal is required to send a review email.", {
        dealId: ["Choose a deal with a pending analysis review."],
      })
    }
    const origin = typeof body.origin === "string" && body.origin.trim() ? body.origin.trim() : appOrigin(request)
    return NextResponse.json(await sendAnalysisReview(actor, body.dealId.trim(), { origin }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
