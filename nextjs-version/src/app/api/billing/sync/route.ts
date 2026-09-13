import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { billingEnabled, syncWorkspaceBilling, getWorkspaceBilling } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    if (billingEnabled()) await syncWorkspaceBilling(context.workspaceId)
    return NextResponse.json(await getWorkspaceBilling(context.workspaceId))
  } catch (error) { return apiError(error) }
}
