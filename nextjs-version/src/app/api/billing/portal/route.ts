import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { createBillingPortal } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
const input = z.object({ onboarding: z.boolean().optional() }).strict()
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    const payload = input.parse(await request.json())
    return NextResponse.json(await createBillingPortal(context.workspaceId, payload.onboarding))
  } catch (error) { return apiError(error) }
}
