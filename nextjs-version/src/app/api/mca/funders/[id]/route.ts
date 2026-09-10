import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { assertSelectableFunder, getFunder, updateFunder, type UpdateFunderInput } from "@/lib/mca/funders/directory"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    const selectable = new URL(request.url).searchParams.get("selectable") === "true"
    const id = (await context.params).id
    const funder = selectable ? await assertSelectableFunder(actor, id) : await getFunder(actor, id)
    return NextResponse.json(funder, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    return NextResponse.json(await assertSelectableFunder(actor, (await context.params).id), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let input: UpdateFunderInput
    try {
      input = await request.json() as UpdateFunderInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateFunder(actor, (await context.params).id, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
