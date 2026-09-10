import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getTeamProfitReport, parseTeamProfitFilters, requireTeamProfitActor } from "@/lib/mca/reports/team-profit"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireTeamProfitActor(request)
    const parsed = parseTeamProfitFilters(new URL(request.url).searchParams)
    const report = await getTeamProfitReport(actor, parsed.filters, new Date().toISOString(), parsed.recognition)
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
