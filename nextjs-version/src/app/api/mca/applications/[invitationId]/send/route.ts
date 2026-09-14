import { NextResponse } from "next/server"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"
import { sendInput } from "@/lib/mca/applications/contracts"
import { queueInvitationEmail, requireApplicationActor } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ invitationId: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await requireApplicationActor(request, true)
    const input = await readJson(request, sendInput)
    await consumeRequestRateLimit(`application-email:${actor.workspaceId}:${actor.membershipId}`, 20)
    return NextResponse.json(await queueInvitationEmail(actor, (await context.params).invitationId, input.requestKey, appOrigin(request)), { status: 202 })
  } catch (error) { return apiError(error) }
}
