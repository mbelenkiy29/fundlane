import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { configureIntegration, listEligibleRepLinks, listIntegrationStatuses, type IntegrationInput } from "@/lib/mca/intake/configuration"
import { privateEmailUiEnabled } from "@/lib/mca/intake/email-readiness"

export const runtime = "nodejs"

export async function GET(request: Request) {
  try {
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return NextResponse.json({ integrations: await listIntegrationStatuses(actor), members: await listEligibleRepLinks(actor), privateEmailUiEnabled: privateEmailUiEnabled() }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return NextResponse.json(await configureIntegration(actor, await request.json() as IntegrationInput), { status: 201 })
  } catch (error) { return apiError(error) }
}
