import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getReply,
  requireReplyRead,
  requireReplyWrite,
  reviewReply,
  type ReviewReplyInput,
} from "@/lib/mca/submissions/replies"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireReplyRead(request)
    return NextResponse.json(await getReply(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const actor = await requireReplyWrite(request)
    let input: ReviewReplyInput
    try {
      input = await request.json() as ReviewReplyInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await reviewReply(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
