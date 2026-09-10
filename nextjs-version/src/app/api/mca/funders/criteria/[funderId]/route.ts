import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { listFunderCriteria, publishFunderCriteria, type EligibilityRuleInput } from "@/lib/mca/funders/criteria"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ funderId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    return NextResponse.json(await listFunderCriteria(actor, (await context.params).funderId), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let body: { rules?: EligibilityRuleInput[] }
    try {
      body = await request.json() as { rules?: EligibilityRuleInput[] }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await publishFunderCriteria(actor, (await context.params).funderId, body.rules ?? []), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
