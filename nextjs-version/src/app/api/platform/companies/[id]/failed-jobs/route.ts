import { NextResponse } from "next/server"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { readJson } from "@/lib/mca/http"
import { apiError, AppError } from "@/lib/mca/errors"
import { failedJobs, recoverFailedJob, recoveryActionSchema } from "@/lib/mca/operations/job-recovery"
import { z } from "zod"

type Context = { params: Promise<{ id: string }> }
function enabled() {
  if (process.env.MCA_JOB_RECOVERY_ENABLED !== "true") throw new AppError(404, "not_found", "Job recovery is unavailable.")
}
export async function GET(_request: Request, context: Context) {
  try {
    enabled()
    const actor = await requirePlatformAdmin()
    await consumeRequestRateLimit(`platform-job-review:${actor.userId}`, 60)
    return NextResponse.json({ jobs: await failedJobs((await context.params).id) }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request, context: Context) {
  try {
    enabled()
    const actor = await requirePlatformAdmin()
    assertTrustedMutation(request)
    await consumeRequestRateLimit(`platform-job-recovery:${actor.userId}`, 10)
    const input = await readJson(request, recoveryActionSchema.extend({ jobId: z.string().min(1).max(200) }))
    return NextResponse.json(await recoverFailedJob((await context.params).id, input.jobId, actor.userId, input.action))
  } catch (error) { return apiError(error) }
}
