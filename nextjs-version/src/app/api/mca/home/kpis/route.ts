import { NextResponse } from "next/server"
import { nowIso } from "@/lib/mca/db"
import { apiError } from "@/lib/mca/errors"
import { parseHomeKpiQuery, requireHomeActor } from "@/lib/mca/home/http"
import { getHomeKpis } from "@/lib/mca/home/kpis"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireHomeActor(request)
    const query = parseHomeKpiQuery(new URL(request.url).searchParams, nowIso())
    return NextResponse.json(await getHomeKpis(actor, query), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
