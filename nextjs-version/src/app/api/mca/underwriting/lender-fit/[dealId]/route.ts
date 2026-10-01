import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireScoreActor } from "@/lib/mca/underwriting/scoring"
import { getLenderFit } from "@/lib/mca/underwriting/lender-fit"
export const runtime = "nodejs"
export async function GET(request: Request, context: { params: Promise<{ dealId: string }> }) {
  try {
    return NextResponse.json(await getLenderFit(await requireScoreActor(request, "read"), (await context.params).dealId), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
