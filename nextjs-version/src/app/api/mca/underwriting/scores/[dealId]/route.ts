import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getDealScores, requireScoreActor, scoreDeal } from "@/lib/mca/underwriting/scoring"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireScoreActor(request, "read")
    return NextResponse.json(await getDealScores(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireScoreActor(request, "write")
    return NextResponse.json(await scoreDeal(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
