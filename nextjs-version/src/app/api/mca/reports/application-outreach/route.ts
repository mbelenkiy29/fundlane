import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireRepFunnelActor } from "@/lib/mca/reports/rep-funnel"
import { getApplicationOutreachReport } from "@/lib/mca/applications/report"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    return NextResponse.json(await getApplicationOutreachReport(await requireRepFunnelActor(request), new URL(request.url).searchParams), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
