import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getDealAnalysis,
  requireAnalysisActor,
  runAnalysis,
  runAnalysisIfReady,
  type AnalysisRunOverride,
} from "@/lib/mca/underwriting/analysis"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireAnalysisActor(request, "read")
    return NextResponse.json(await getDealAnalysis(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAnalysisActor(request, "write")
    const dealId = (await context.params).dealId
    let body: AnalysisRunOverride = {}
    try {
      const parsed = await request.json() as AnalysisRunOverride
      if (parsed && typeof parsed === "object") body = parsed
    } catch (error) {
      if (request.headers.get("content-type")?.includes("application/json")) {
        throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
      }
      if (error instanceof AppError) throw error
    }
    if (body.trigger === "readiness") {
      const result = await runAnalysisIfReady(actor, dealId)
      if (!result.run) throw new AppError(409, "deal_not_ready", "Document completeness is not ready for automatic analysis.")
      return NextResponse.json({ ...await getDealAnalysis(actor, dealId), run: result.run, ran: result.ran }, { headers: noStore })
    }
    return NextResponse.json(await runAnalysis(actor, dealId, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
