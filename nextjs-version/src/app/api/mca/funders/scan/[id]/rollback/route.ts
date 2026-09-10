import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireCriteriaScanActor, rollbackCriteriaScan } from "@/lib/mca/funders/criteria-scan"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireCriteriaScanActor(request, "write")
    return NextResponse.json(await rollbackCriteriaScan(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
