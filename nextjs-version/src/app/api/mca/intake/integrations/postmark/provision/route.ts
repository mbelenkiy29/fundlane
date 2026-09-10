import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { provisionPostmarkIntegration, type ProvisionPostmarkInput } from "@/lib/mca/intake/configuration"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return NextResponse.json(await provisionPostmarkIntegration(actor, await request.json() as ProvisionPostmarkInput), { status: 201 })
  } catch (error) { return apiError(error) }
}
