import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { rotateIntegrationCredentials } from "@/lib/mca/intake/configuration"

export const runtime = "nodejs"
interface Context { params: Promise<{ integrationId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    return NextResponse.json(await rotateIntegrationCredentials(actor, (await context.params).integrationId, await request.json()))
  } catch (error) { return apiError(error) }
}
