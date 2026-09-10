import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getLeadRoiReport, parseReportFilters, requireLeadRoiActor } from "@/lib/mca/reports/lead-roi"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireLeadRoiActor(request)
    const report = await getLeadRoiReport(actor, parseReportFilters(new URL(request.url).searchParams))
    return NextResponse.json(report, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
