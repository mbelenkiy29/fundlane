import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { acceptCriteriaScan, requireCriteriaScanActor } from "@/lib/mca/funders/criteria-scan"
import type { EligibilityRuleInput } from "@/lib/mca/funders/criteria"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireCriteriaScanActor(request, "write")
    let body: { rules?: EligibilityRuleInput[] } = {}
    try {
      const text = await request.text()
      if (text.trim()) body = JSON.parse(text) as { rules?: EligibilityRuleInput[] }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await acceptCriteriaScan(actor, (await context.params).id, body.rules), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
