import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation, withSuperAdminAction } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { releaseRetentionHold, retentionHoldsEnabled } from "@/lib/mca/retention-holds"

type Context = { params: Promise<{ id: string }> }
export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireSuperAdmin(request)
    if (!retentionHoldsEnabled()) throw new AppError(404, "not_found", "Not found.")
    assertStrictPlatformMutation(request);assertTrustedMutation(request);await consumeRequestRateLimit(`platform-mutation:${actor.userId}`,20)
    const { id } = await context.params
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(404, "not_found", "Not found.")
    return NextResponse.json(await withSuperAdminAction({actor,action:"retention_hold.released",targetType:"retention_hold",targetId:id,request},()=>releaseRetentionHold(id, actor.userId)), { headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
