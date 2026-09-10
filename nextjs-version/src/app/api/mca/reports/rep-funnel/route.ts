import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getRepFunnelReport, parseReportFilters, requireRepFunnelActor } from "@/lib/mca/reports/rep-funnel"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireRepFunnelActor(request)
    const report = await getRepFunnelReport(actor, parseReportFilters(new URL(request.url).searchParams))
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
