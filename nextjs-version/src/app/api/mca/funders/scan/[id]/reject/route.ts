import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { rejectCriteriaScan, requireCriteriaScanActor } from "@/lib/mca/funders/criteria-scan"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireCriteriaScanActor(request, "write")
    return NextResponse.json(await rejectCriteriaScan(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
