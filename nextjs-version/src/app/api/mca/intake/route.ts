import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import type { NormalizedIntakeInput } from "@/lib/mca/intake/contracts"
import { ingestApplication, listIntakeSummaries } from "@/lib/mca/intake/service"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const context = await requireWorkspaceAccess(request, { anyScopes: ["deals:read", "intake:write"] })
    return NextResponse.json({ intakes: await listIntakeSummaries(await actorForDeals(context)) }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireWorkspaceAccess(request, { scopes: ["intake:write"] })
    const result = await ingestApplication(await actorForDeals(context), await request.json() as NormalizedIntakeInput)
    return NextResponse.json(result, { status: result.created ? 201 : 200 })
  } catch (error) { return apiError(error) }
}
