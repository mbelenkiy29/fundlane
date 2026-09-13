import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals } from "@/lib/mca/deals/service"
import { requestCorrelationId } from "@/lib/mca/http"
import { lookupMerchants } from "@/lib/mca/merchants/service"
import type { MerchantLookupQuery } from "@/lib/mca/merchants/contracts"
import { getWorkspaceSettings } from "@/lib/mca/workspaces"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireWorkspaceAccess(request, { anyScopes: ["deals:read", "deals:write"] })
    if (context.authType === "session") {
      const settings = await getWorkspaceSettings(context.workspaceId)
      if (!settings.pageVisibility.dashboard && !settings.pageVisibility.deals) {
        throw new AppError(403, "page_disabled", "Home and deals are disabled for this workspace.")
      }
    }
    const actor = { ...await actorForDeals(context), correlationId: requestCorrelationId(request) }
    let query: MerchantLookupQuery = {}
    try {
      query = await request.json() as MerchantLookupQuery
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await lookupMerchants(actor, {
      ein: typeof query.ein === "string" ? query.ein : undefined,
      owners: Array.isArray(query.owners) ? query.owners : undefined,
    }), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
