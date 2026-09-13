import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { backgroundJobView, getBackgroundJob } from "@/lib/mca/jobs/queue"

export const runtime = "nodejs"
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { anyScopes: ["deals:read", "deals:write", "deals:export", "intake:write"] }))
    return NextResponse.json(backgroundJobView(await getBackgroundJob(actor, (await context.params).id)), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
