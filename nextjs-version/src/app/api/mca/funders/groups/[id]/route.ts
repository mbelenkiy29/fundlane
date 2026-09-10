import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { getGroup, resolveGroup, updateGroup, type UpdateGroupInput } from "@/lib/mca/funders/directory"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    const id = (await context.params).id
    const group = await getGroup(actor, id)
    return NextResponse.json({ group, resolvedFunderIds: await resolveGroup(actor, id) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let input: UpdateGroupInput
    try {
      input = await request.json() as UpdateGroupInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const group = await updateGroup(actor, (await context.params).id, input)
    return NextResponse.json({ group, resolvedFunderIds: await resolveGroup(actor, group.id) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
