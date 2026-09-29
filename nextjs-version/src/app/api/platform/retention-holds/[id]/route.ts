import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { releaseRetentionHold, retentionHoldsEnabled } from "@/lib/mca/retention-holds"

type Context = { params: Promise<{ id: string }> }
export async function POST(request: Request, context: Context) {
  try {
    if (!retentionHoldsEnabled()) throw new AppError(404, "not_found", "Not found.")
    const actor = await requirePlatformAdmin()
    assertTrustedMutation(request)
    const { id } = await context.params
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(404, "not_found", "Not found.")
    return NextResponse.json(await releaseRetentionHold(id, actor.userId))
  } catch (error) { return apiError(error) }
}
