import { NextResponse } from "next/server"
import { z } from "zod"
import { readJson } from "@/lib/mca/http"
import { assertTrustedMutation, consumeRequestRateLimit, requireMembershipAccess } from "@/lib/mca/auth"
import { billingManualSeatPreviewEnabled, billingSeatSyncEnabled, previewBillingSeatIncrease } from "@/lib/mca/billing"
import { apiError, AppError } from "@/lib/mca/errors"

const input=z.object({selectedSeats:z.number().int().min(2).max(100000)}).strict()
export async function POST(request:Request) {
  try {
    assertTrustedMutation(request)
    if (!billingSeatSyncEnabled() && !billingManualSeatPreviewEnabled()) throw new AppError(404,"billing_preview_disabled","Seat price previews are unavailable.")
    const context=await requireMembershipAccess(request,["admin","super_admin"])
    await consumeRequestRateLimit(`billing-seat-preview:${context.workspaceId}:${context.membershipId}`, 30)
    const payload=await readJson(request, input)
    return NextResponse.json(await previewBillingSeatIncrease(context.workspaceId,payload.selectedSeats),{headers:{"Cache-Control":"no-store"}})
  } catch(error) { return apiError(error) }
}
