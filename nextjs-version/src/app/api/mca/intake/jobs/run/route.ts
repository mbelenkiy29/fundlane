import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { runDueAttachmentJobs } from "@/lib/mca/intake/service"
import { intakeWorkerScope } from "@/lib/mca/intake/worker-auth"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const scope = await intakeWorkerScope(request)
    const jobs = await runDueAttachmentJobs(25, scope.workspaceId)
    return NextResponse.json({ jobs })
  } catch (error) { return apiError(error) }
}
