import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin } from "@/lib/mca/http"
import { createJotformRepLink } from "@/lib/mca/intake/configuration"

export const runtime = "nodejs"
interface Context { params: Promise<{ integrationId: string }> }

export async function POST(request: Request, context: Context) {
  try {
    assertTrustedMutation(request)
    const actor = await requireMembershipAccess(request, ["admin", "super_admin"])
    const body = await request.json() as { membershipId?: string }
    if (!body.membershipId) throw new AppError(422, "membership_required", "Choose an active team member.")
    return NextResponse.json(await createJotformRepLink(actor, (await context.params).integrationId, body.membershipId, appOrigin(request)), { status: 201 })
  } catch (error) { return apiError(error) }
}
