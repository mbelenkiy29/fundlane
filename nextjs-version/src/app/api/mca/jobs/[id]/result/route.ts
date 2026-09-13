import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError, AppError } from "@/lib/mca/errors"
import { getBackgroundJob } from "@/lib/mca/jobs/queue"
import { signedArtifactDownload } from "@/lib/mca/jobs/artifacts"

export const runtime = "nodejs"
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { anyScopes: ["deals:read", "deals:write", "deals:export", "intake:write"] }))
    const job = await getBackgroundJob(actor, (await context.params).id)
    const result = JSON.parse(job.result_json ?? "null")
    if (job.state !== "complete" || !result?._resultObjectKey || !String(result._resultObjectKey).startsWith(`${actor.workspaceId}/jobs/${job.id}/`)) throw new AppError(404, "job_result_not_found", "The operation result was not found.")
    return NextResponse.redirect(await signedArtifactDownload(result._resultObjectKey), { status: 307, headers: { "cache-control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
