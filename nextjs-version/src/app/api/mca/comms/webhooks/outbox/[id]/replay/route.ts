import { NextResponse } from "next/server"
import { replayWebhookOutbox, requireWebhookAdmin } from "@/lib/mca/comms/webhooks"
import { apiError, AppError } from "@/lib/mca/errors"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireWebhookAdmin(request)
    const nowIso = new URL(request.url).searchParams.get("nowIso")
    if (nowIso && !Number.isFinite(Date.parse(nowIso))) {
      throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for webhook replay.")
    }
    return NextResponse.json(await replayWebhookOutbox(actor, (await context.params).id, nowIso ?? undefined), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
