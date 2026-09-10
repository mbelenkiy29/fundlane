import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { leadsHeaders, requireLeadsActor } from "@/lib/mca/leads/http"
import { attachImportRunAcquisitions } from "@/lib/mca/leads/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext { params: Promise<{ runId: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireLeadsActor(request, "write")
    const events = await attachImportRunAcquisitions(actor, (await context.params).runId)
    return NextResponse.json({ events, attachedDealIds: events.map((event) => event.dealId) }, { headers: leadsHeaders() })
  } catch (error) {
    return apiError(error)
  }
}
