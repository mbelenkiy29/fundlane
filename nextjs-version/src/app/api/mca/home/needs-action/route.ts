import { NextResponse } from "next/server"
import { nowIso } from "@/lib/mca/db"
import { apiError } from "@/lib/mca/errors"
import { parseHomeQueueQuery, requireHomeActor } from "@/lib/mca/home/http"
import { getHomeNeedsActionQueue } from "@/lib/mca/home/service"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireHomeActor(request)
    const query = parseHomeQueueQuery(new URL(request.url).searchParams, nowIso())
    return NextResponse.json(await getHomeNeedsActionQueue(actor, query), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
