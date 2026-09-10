import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getCriteriaScan, requireCriteriaScanActor } from "@/lib/mca/funders/criteria-scan"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireCriteriaScanActor(request, "read")
    return NextResponse.json(await getCriteriaScan(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
