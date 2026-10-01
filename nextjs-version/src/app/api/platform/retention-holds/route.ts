import { consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation, withSuperAdminAction } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { placeRetentionHold, placeRetentionHoldSchema, retentionHoldsEnabled } from "@/lib/mca/retention-holds"

export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    if (!retentionHoldsEnabled()) throw new AppError(404, "not_found", "Not found.")
    assertStrictPlatformMutation(request);assertTrustedMutation(request);await consumeRequestRateLimit(`platform-mutation:${actor.userId}`,20)
    const input = await readJson(request, placeRetentionHoldSchema)
    return NextResponse.json(await withSuperAdminAction({actor,action:"retention_hold.placed",workspaceId:input.workspaceId,targetType:"retention_hold",request},()=>placeRetentionHold(actor.userId, input)), { status: 201, headers: { "Cache-Control": "no-store" } })
  } catch (error) { return apiError(error) }
}
