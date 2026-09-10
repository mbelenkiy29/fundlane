import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getAnalysisSettings,
  requireAnalysisActor,
  requireAnalysisAdmin,
  updateAnalysisSettings,
  type AnalysisSettings,
} from "@/lib/mca/underwriting/analysis"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireAnalysisActor(request, "read")
    return NextResponse.json(await getAnalysisSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireAnalysisAdmin(request)
    let body: Partial<AnalysisSettings>
    try {
      body = await request.json() as Partial<AnalysisSettings>
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateAnalysisSettings(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
