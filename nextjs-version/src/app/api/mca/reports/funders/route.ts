import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getFunderAnalyticsReport, parseReportFilters, requireFunderAnalyticsActor } from "@/lib/mca/reports/funder-analytics"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireFunderAnalyticsActor(request)
    const report = await getFunderAnalyticsReport(actor, parseReportFilters(new URL(request.url).searchParams))
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
