import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  previewReplyExtraction,
  requireExtractWrite,
  type ExtractRunInput,
} from "@/lib/mca/submissions/extract-outcomes"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireExtractWrite(request)
    let input: ExtractRunInput
    try {
      input = await request.json() as ExtractRunInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await previewReplyExtraction(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
