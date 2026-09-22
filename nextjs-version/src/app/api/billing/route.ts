import { NextResponse } from "next/server"
import { requireMembershipAccess } from "@/lib/mca/auth"
import { getCompanyBillingPresentation } from "@/lib/mca/billing-presentation"
import { apiError } from "@/lib/mca/errors"
export async function GET(request: Request) {
  try { const context = await requireMembershipAccess(request, ["admin", "super_admin"]); return NextResponse.json(await getCompanyBillingPresentation(context.workspaceId),{headers:{"Cache-Control":"no-store"}}) }
  catch (error) { return apiError(error) }
}
