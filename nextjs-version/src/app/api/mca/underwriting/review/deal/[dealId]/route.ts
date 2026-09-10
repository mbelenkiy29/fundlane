import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireAnalysisActor } from "@/lib/mca/underwriting/analysis"
import { confirmAnalysisReview, getDealReview } from "@/lib/mca/underwriting/review-mail"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireAnalysisActor(request, "read")
    return NextResponse.json(await getDealReview(actor, (await context.params).dealId), { headers: noStore })
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
      dealId: (await context.params).dealId,
      selectedFunderIds: body.selectedFunderIds,
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
