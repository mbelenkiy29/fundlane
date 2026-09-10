import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { listIndustryAliases, upsertIndustryAlias, type IndustryAliasInput } from "@/lib/mca/funders/criteria"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    return NextResponse.json({ aliases: await listIndustryAliases(actor) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    let input: IndustryAliasInput
    try {
      input = await request.json() as IndustryAliasInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    const existing = (await listIndustryAliases(actor)).some((item) => item.alias.toLowerCase() === String(input.alias ?? "").trim().toLowerCase())
    const alias = await upsertIndustryAlias(actor, input)
    return NextResponse.json(alias, { status: existing ? 200 : 201, headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
