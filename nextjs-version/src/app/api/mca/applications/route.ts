import { NextResponse } from "next/server"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { getWorkspaceSettings } from "@/lib/mca/workspaces"
import { isActionAllowed } from "@/lib/mca/policy"
import { invitationInput } from "@/lib/mca/applications/contracts"
import { availableApplicationForms, createApplicationInvitation, invitationEmailEnabled, listApplicationInvitations, requireApplicationActor } from "@/lib/mca/applications/service"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const actor = await requireApplicationActor(request)
    const [invitations, forms] = await Promise.all([listApplicationInvitations(actor), availableApplicationForms(actor)])
    const canCreate = Boolean(actor.role && isActionAllowed(actor.role, "createDeal", (await getWorkspaceSettings(actor.workspaceId)).actionVisibility))
    const canManageForm = actor.role === "admin" || actor.role === "super_admin"
    return NextResponse.json({ invitations, forms, canCreate, canManageForm, invitationEmailEnabled: invitationEmailEnabled() }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireApplicationActor(request, true)
    await consumeRequestRateLimit(`application-create:${actor.workspaceId}:${actor.membershipId}`, 30)
    return NextResponse.json(await createApplicationInvitation(actor, await readJson(request, invitationInput)), { status: 201 })
  } catch (error) { return apiError(error) }
}
