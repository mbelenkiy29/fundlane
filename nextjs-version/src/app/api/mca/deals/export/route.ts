import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals, exportDeals } from "@/lib/mca/deals/service"
import { canViewCompanyFinancials, isActionAllowed } from "@/lib/mca/policy"
import { getWorkspaceSettings } from "@/lib/mca/workspaces"
import { DEAL_STATUSES, type DealFilters, type DealStatus } from "@/lib/mca/deals/schema"

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
    const context = await requireWorkspaceAccess(request, { scopes: ["deals:export"] })
    const actions = (await getWorkspaceSettings(context.workspaceId)).actionVisibility
    if (context.authType === "session") {
      if (!context.role || !canViewCompanyFinancials(context.role)) {
        throw new AppError(403, "permission_denied", "Only workspace administrators can export deal data.")
      }
      if (!isActionAllowed(context.role, "exportDeals", actions)) {
        throw new AppError(403, "action_disabled", "Deal exports are disabled for this workspace.")
      }
    } else if (!actions.exportDeals) {
      throw new AppError(403, "action_disabled", "Deal exports are disabled for this workspace.")
    }
    const csv = await exportDeals(await actorForDeals(context), filtersFrom(new URL(request.url)))
    return new NextResponse(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="mca-deals.csv"',
      },
    })
  } catch (error) {
    return apiError(error)
  }
}
