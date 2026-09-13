import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { MULTIPART_TASK_ENDPOINTS } from "@/lib/mca/jobs/contracts"
import { backgroundJobView, enqueueBackgroundJob } from "@/lib/mca/jobs/queue"
import { authorize } from "@/lib/mca/assistant/operations"

const schema = z.object({ endpoint: z.enum(MULTIPART_TASK_ENDPOINTS), fields: z.record(z.string().max(100), z.string().max(200_000)), files: z.array(z.object({ field: z.enum(["file", "archives"]), uploadId: z.string().uuid() })).min(1).max(10) }).strict()
export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const input = schema.parse(await request.json())
    const actor = input.endpoint === "/api/mca/assistant/files" ? await authorize(request) : await actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
    const key = createHash("sha256").update(JSON.stringify(input)).digest("hex")
    return NextResponse.json(backgroundJobView(await enqueueBackgroundJob({ actor, kind: "multipart_task", resourceId: key, idempotencyKey: key, payload: { ...input } })), { status: 202, headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
