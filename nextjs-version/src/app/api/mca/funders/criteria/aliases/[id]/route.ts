import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { deleteIndustryAlias, getIndustryAlias, upsertIndustryAlias, type IndustryAliasInput } from "@/lib/mca/funders/criteria"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let input: Partial<IndustryAliasInput>
    try {
      input = await request.json() as Partial<IndustryAliasInput>
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const id = (await context.params).id
    const current = await getIndustryAlias(actor, id)
    return NextResponse.json(await upsertIndustryAlias(actor, {
      id,
      alias: input.alias ?? current.alias,
      naics: input.naics === undefined ? current.naics ?? null : input.naics,
      normalizedIndustry: input.normalizedIndustry ?? current.normalizedIndustry,
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    await deleteIndustryAlias(actor, (await context.params).id)
    return NextResponse.json({ ok: true }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
