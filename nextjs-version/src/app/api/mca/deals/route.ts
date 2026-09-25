import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { parseDealListFilters } from "@/lib/mca/deals/filters"
import { actorForDeals, createDeal, listDeals } from "@/lib/mca/deals/service"
import type { CreateDealInput, DealFilters } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"

function filtersFrom(url: URL): DealFilters {
  const parsed = parseDealListFilters(url.searchParams, "reject")
  if (!parsed.ok) throw new AppError(422, "invalid_filter", parsed.message)
  return parsed.filters
}

export async function GET(request: Request) {
  try {
    const context = await requireWorkspaceAccess(request, { scopes: ["deals:read"] })
    return NextResponse.json(await listDeals(await actorForDeals(context), filtersFrom(new URL(request.url))))
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireWorkspaceAccess(request, { anyScopes: ["deals:write", "intake:write"] })
    const input = await request.json() as CreateDealInput
    const result = await createDeal(await actorForDeals(context), input)
    return NextResponse.json(result.warnings.length ? { ...result.deal, warnings: result.warnings } : result.deal, {
      status: result.created ? 201 : 200,
      headers: { "x-idempotent-replay": result.created ? "false" : "true" },
    })
  } catch (error) {
    return apiError(error)
  }
}
