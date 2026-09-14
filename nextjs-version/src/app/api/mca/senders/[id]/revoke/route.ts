import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSenderUse, revokeSender } from "@/lib/mca/senders/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireSenderUse(request)
    return NextResponse.json(await revokeSender(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
