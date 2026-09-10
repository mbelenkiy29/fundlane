import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import {
  checkCompleteness,
  getCompleteness,
  getRequiredStatementMonths,
  listReadinessEvents,
  requireCompletenessActor,
} from "@/lib/mca/underwriting/completeness"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireCompletenessActor(request, "read")
    const dealId = (await context.params).dealId
    const [result, events, requiredStatementMonths] = await Promise.all([
      getCompleteness(actor, dealId),
      listReadinessEvents(actor, dealId),
      getRequiredStatementMonths(actor),
    ])
    return NextResponse.json({
      result,
      events,
      requiredStatementMonths,
    }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireCompletenessActor(request, "write")
    return NextResponse.json(await checkCompleteness(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
