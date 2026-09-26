import { NextResponse } from "next/server"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { AppError, apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { reconcileDeliveryInput } from "@/lib/mca/applications/contracts"
import { reconcileInvitationDelivery, requireApplicationActor } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  try {
    if (process.env.MCA_JOB_RUNTIME !== "vercel_cron") throw new AppError(404, "reconciliation_unavailable", "Invitation delivery reconciliation is unavailable.")
    assertTrustedMutation(request)
    const actor = await requireApplicationActor(request, true)
    const input = await readJson(request, reconcileDeliveryInput)
    await consumeRequestRateLimit(`application-reconcile:${actor.workspaceId}:${actor.membershipId}`, 20)
    await reconcileInvitationDelivery(actor, (await context.params).invitationId, input)
    return NextResponse.json({ reconciled: true })
  } catch (error) { return apiError(error) }
}
