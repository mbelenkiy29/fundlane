import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { listReplyQueue, requireReplyRead } from "@/lib/mca/submissions/replies"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireReplyRead(request)
    const dealId = new URL(request.url).searchParams.get("dealId") ?? undefined
    return NextResponse.json(await listReplyQueue(actor, dealId || undefined), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
