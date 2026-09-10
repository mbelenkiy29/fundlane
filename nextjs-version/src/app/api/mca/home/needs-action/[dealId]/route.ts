import { NextResponse } from "next/server"
import { nowIso } from "@/lib/mca/db"
import { apiError } from "@/lib/mca/errors"
import { parseHomeQueueQuery, requireHomeActor } from "@/lib/mca/home/http"
import { getHomeDealPanel } from "@/lib/mca/home/service"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireHomeActor(request)
    const query = parseHomeQueueQuery(new URL(request.url).searchParams, nowIso())
    const dealId = (await context.params).dealId?.trim()
    return NextResponse.json(await getHomeDealPanel(actor, dealId, query.nowIso), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
