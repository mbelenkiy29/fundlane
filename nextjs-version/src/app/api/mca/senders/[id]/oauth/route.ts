import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSenderAdmin, startSenderOAuth } from "@/lib/mca/senders/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireSenderAdmin(request)
    return NextResponse.json(await startSenderOAuth(actor, (await context.params).id), { status: 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
