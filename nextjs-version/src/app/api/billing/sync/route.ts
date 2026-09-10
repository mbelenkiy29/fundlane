import { NextResponse } from "next/server"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { syncWorkspaceBilling, getWorkspaceBilling } from "@/lib/mca/billing"
import { syncClerkMember } from "@/lib/mca/clerk-team"
import { apiError } from "@/lib/mca/errors"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    await syncClerkMember(context.workspaceId, context.membershipId)
    await syncWorkspaceBilling(context.workspaceId)
    return NextResponse.json(await getWorkspaceBilling(context.workspaceId))
  } catch (error) { return apiError(error) }
}
