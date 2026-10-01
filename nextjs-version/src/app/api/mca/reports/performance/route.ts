import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { getPerformanceReport, performanceCsv } from "@/lib/mca/reports/performance"
import { parseReportFilters, requireRepFunnelActor } from "@/lib/mca/reports/rep-funnel"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const actor = await requireRepFunnelActor(request)
    const search = new URL(request.url).searchParams
    const format = search.get("format") ?? "json"
    if (format !== "json" && format !== "csv") throw new AppError(422, "invalid_filter", "format must be json or csv.")
    const report = await getPerformanceReport(actor, parseReportFilters(search))
    const csvSnapshot = performanceCsv(report)
    if (format === "csv") return new Response(csvSnapshot, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="fundlane-performance.csv"', "cache-control": "no-store" } })
    return NextResponse.json({ report, csvSnapshot }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
