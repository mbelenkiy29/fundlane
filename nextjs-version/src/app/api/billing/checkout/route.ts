import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { createBillingCheckout } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
const input = z.object({ planSlug: z.enum(["mca_starter_test", "mca_team_test"]), onboarding: z.boolean().optional() }).strict()
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    const payload = input.parse(await request.json())
    return NextResponse.json(await createBillingCheckout(context.workspaceId, payload.planSlug, payload.onboarding))
  } catch (error) { return apiError(error) }
}
