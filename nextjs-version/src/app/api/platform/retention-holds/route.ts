import { NextResponse } from "next/server"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePlatformAdmin } from "@/lib/mca/platform-auth"
import { placeRetentionHold, placeRetentionHoldSchema, retentionHoldsEnabled } from "@/lib/mca/retention-holds"

export async function POST(request: Request) {
  try {
    if (!retentionHoldsEnabled()) throw new AppError(404, "not_found", "Not found.")
    const actor = await requirePlatformAdmin()
    assertTrustedMutation(request)
    const input = await readJson(request, placeRetentionHoldSchema)
    return NextResponse.json(await placeRetentionHold(actor.userId, input), { status: 201 })
  } catch (error) { return apiError(error) }
}
