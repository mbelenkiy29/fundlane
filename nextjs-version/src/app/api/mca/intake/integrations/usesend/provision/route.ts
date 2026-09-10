import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { provisionUsesendIntegration, type ProvisionUsesendInput } from "@/lib/mca/intake/configuration"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return NextResponse.json(await provisionUsesendIntegration(actor, await request.json() as ProvisionUsesendInput), { status: 201 })
  } catch (error) { return apiError(error) }
}
