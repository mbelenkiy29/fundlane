import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireReplyWrite, runReplyIngest, type RunReplyIngestInput } from "@/lib/mca/submissions/replies"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireReplyWrite(request)
    let input: RunReplyIngestInput = {}
    const raw = await request.text()
    if (raw.trim()) {
      try {
        input = JSON.parse(raw) as RunReplyIngestInput
      } catch {
        throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
      }
    }
    return NextResponse.json(await runReplyIngest(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
