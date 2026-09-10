import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals, addDealNote, conflictBody, DealVersionConflictError } from "@/lib/mca/deals/service"

export const runtime = "nodejs"

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  let input: { body: string; expectedVersion: number } | undefined
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:write"] })
    input = await request.json() as { body: string; expectedVersion: number }
    if (!Number.isInteger(input.expectedVersion)) throw new AppError(422, "validation_failed", "A record version is required.")
    return NextResponse.json(await addDealNote(await actorForDeals(auth), (await context.params).id, input))
  } catch (error) {
    if (error instanceof DealVersionConflictError) {
      return NextResponse.json({ error: conflictBody(error, ["notes"]) }, { status: 409 })
    }
    return apiError(error)
  }
}
