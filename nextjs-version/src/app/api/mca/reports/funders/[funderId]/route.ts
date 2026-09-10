import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getFunderAnalyticsReport, parseReportFilters, requireFunderAnalyticsActor } from "@/lib/mca/reports/funder-analytics"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ funderId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireFunderAnalyticsActor(request)
    const funderId = (await context.params).funderId
    const filters = parseReportFilters(new URL(request.url).searchParams)
    const report = await getFunderAnalyticsReport(actor, { ...filters, funderIds: [funderId] })
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
