import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals, conflictBody, DealVersionConflictError, transitionDeal } from "@/lib/mca/deals/service"
import { assertDealStatus } from "@/lib/mca/deals/validation"
import type { TransitionDealInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  let input: TransitionDealInput | undefined
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:write"] })
    input = await request.json() as TransitionDealInput
    if (!assertDealStatus(input.status)) throw new AppError(422, "validation_failed", "Choose a valid deal status.")
    if (!Number.isInteger(input.expectedVersion)) throw new AppError(422, "validation_failed", "A record version is required.")
    return NextResponse.json(await transitionDeal(await actorForDeals(auth), (await context.params).id, input))
  } catch (error) {
    if (error instanceof DealVersionConflictError) {
      return NextResponse.json({ error: conflictBody(error, ["status"]) }, { status: 409 })
    }
    return apiError(error)
  }
}
