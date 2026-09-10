import { NextResponse } from "next/server"
import { completeCompanyOnboarding } from "@/lib/mca/clerk-auth"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { billingEnabled } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await completeCompanyOnboarding()
    return NextResponse.json({
      workspaceId: context.workspaceId,
      role: context.role,
      billingEnabled: billingEnabled(),
    })
  } catch (error) {
    return apiError(error)
  }
}
