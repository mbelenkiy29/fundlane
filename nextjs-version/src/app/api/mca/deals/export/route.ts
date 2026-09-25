import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { parseDealListFilters } from "@/lib/mca/deals/filters"
import { actorForDeals, exportDeals } from "@/lib/mca/deals/service"
import { canViewCompanyFinancials, isActionAllowed } from "@/lib/mca/policy"
import { getWorkspaceSettings } from "@/lib/mca/workspaces"
import type { DealFilters } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"

function filtersFrom(url: URL): DealFilters {
  const parsed = parseDealListFilters(url.searchParams, "reject")
  if (!parsed.ok) throw new AppError(422, "invalid_filter", parsed.message)
  return parsed.filters
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
