import { NextResponse } from "next/server"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { acceptCriteriaScan, requireCriteriaScanActor } from "@/lib/mca/funders/criteria-scan"
import type { EligibilityRuleInput } from "@/lib/mca/funders/criteria"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireCriteriaScanActor(request, "write")
    await consumeRequestRateLimit(`funder-criteria-accept:${actor.workspaceId}:${actor.membershipId}`, 20)
    let body: { rules?: EligibilityRuleInput[] } = {}
    try {
      const text = await request.text()
      if (text.trim()) {
        const parsed = JSON.parse(text) as unknown
        if (parsed != null && (typeof parsed !== "object" || Array.isArray(parsed))) {
          throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
        }
        body = (parsed ?? {}) as { rules?: EligibilityRuleInput[] }
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await acceptCriteriaScan(actor, (await context.params).id, body.rules), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
