import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals, conflictBody, DealVersionConflictError, getDeal, updateDealRecord } from "@/lib/mca/deals/service"
import type { UpdateDealInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
    return NextResponse.json(await getDeal(await actorForDeals(auth), (await context.params).id))
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  let input: UpdateDealInput | undefined
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:write"] })
    input = await request.json() as UpdateDealInput
    if (!Number.isInteger(input.expectedVersion)) throw new AppError(422, "validation_failed", "A record version is required.")
    return NextResponse.json(await updateDealRecord(await actorForDeals(auth), (await context.params).id, input))
  } catch (error) {
    if (error instanceof DealVersionConflictError) {
      return NextResponse.json({ error: conflictBody(error, Object.keys(input ?? {}).filter((key) => key !== "expectedVersion")) }, { status: 409 })
    }
    return apiError(error)
  }
}
