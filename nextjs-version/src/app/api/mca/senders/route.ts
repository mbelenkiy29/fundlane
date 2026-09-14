import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  createSender,
  listSenders,
  requireSenderUse,
  requireSenderRead,
  type CreateSenderInput,
} from "@/lib/mca/senders/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireSenderRead(request)
    return NextResponse.json(await listSenders(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireSenderUse(request)
    let input: CreateSenderInput
    try {
      input = await request.json() as CreateSenderInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await createSender(actor, input), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
