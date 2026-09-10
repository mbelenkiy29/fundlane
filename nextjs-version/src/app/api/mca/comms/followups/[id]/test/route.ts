import { NextResponse } from "next/server"
import {
  followupTestSchema,
  requireFollowupAdmin,
  testFollowupPolicy,
} from "@/lib/mca/comms/followups"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireFollowupAdmin(request)
    const input = await readJson(request, followupTestSchema)
    if (input.nowIso && !Number.isFinite(Date.parse(input.nowIso))) {
      throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for follow-up schedules.")
    }
    return NextResponse.json(await testFollowupPolicy(actor, (await context.params).id, {
      dealId: input.dealId,
      nowIso: input.nowIso,
      origin: appOrigin(request),
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
