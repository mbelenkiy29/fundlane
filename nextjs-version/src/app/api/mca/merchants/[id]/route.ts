import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { actorForDeals } from "@/lib/mca/deals/service"
import { requestCorrelationId } from "@/lib/mca/http"
import { getAttachPayload } from "@/lib/mca/merchants/service"
import { getWorkspaceSettings } from "@/lib/mca/workspaces"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await requireWorkspaceAccess(request, { anyScopes: ["deals:read", "deals:write"] })
    if (access.authType === "session") {
      const settings = await getWorkspaceSettings(access.workspaceId)
      if (!settings.pageVisibility.dashboard && !settings.pageVisibility.deals) {
        throw new AppError(403, "page_disabled", "Home and deals are disabled for this workspace.")
      }
    }
    const actor = { ...await actorForDeals(access), correlationId: requestCorrelationId(request) }
    return NextResponse.json(await getAttachPayload(actor, (await context.params).id), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
