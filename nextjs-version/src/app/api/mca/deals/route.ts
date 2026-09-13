import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals, createDeal, listDeals } from "@/lib/mca/deals/service"
import { DEAL_STATUSES, type CreateDealInput, type DealFilters, type DealStatus } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"

function filtersFrom(url: URL): DealFilters {
  const statuses = url.searchParams.getAll("status")
  if (statuses.some((status) => !DEAL_STATUSES.includes(status as DealStatus))) {
    throw new AppError(422, "invalid_filter", "One or more status filters are invalid.")
  }
  const createdFrom = url.searchParams.get("from") || undefined
  const createdTo = url.searchParams.get("to") || undefined
  for (const [name, value] of [["from", createdFrom], ["to", createdTo]] as const) {
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(422, "invalid_filter", `${name} must use YYYY-MM-DD.`)
  }
  return {
    search: url.searchParams.get("q")?.trim() || undefined,
    statuses: statuses.length ? statuses as DealStatus[] : undefined,
    assignee: url.searchParams.get("assignee")?.trim() || undefined,
    createdFrom,
    createdTo,
    funder: url.searchParams.get("funder")?.trim() || undefined,
  }
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
