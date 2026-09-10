import { NextResponse } from "next/server"
import { requireMembershipAccess } from "@/lib/mca/auth"
import { getWorkspaceBilling } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
export async function GET(request: Request) {
  try { const context = await requireMembershipAccess(request, ["admin", "super_admin"]); return NextResponse.json(await getWorkspaceBilling(context.workspaceId)) }
  catch (error) { return apiError(error) }
}
