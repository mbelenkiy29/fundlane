import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  correctReplyExtraction,
  getReplyExtraction,
  requireExtractRead,
  requireExtractWrite,
  type ExtractCorrectionInput,
} from "@/lib/mca/submissions/extract-outcomes"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireExtractRead(request)
    return NextResponse.json(await getReplyExtraction(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireExtractWrite(request)
    let input: ExtractCorrectionInput
    try {
      input = await request.json() as ExtractCorrectionInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await correctReplyExtraction(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
