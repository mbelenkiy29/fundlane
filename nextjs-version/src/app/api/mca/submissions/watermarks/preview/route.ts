import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { previewWatermark, requireWatermarkPreview } from "@/lib/mca/submissions/watermarks"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireWatermarkPreview(request)
    let body: { documentId?: unknown; funderId?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await previewWatermark(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
