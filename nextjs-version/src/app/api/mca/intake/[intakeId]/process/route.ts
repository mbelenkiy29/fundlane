import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { retryIntakeProcessing } from "@/lib/mca/intake/processing"
export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ intakeId: string }> }) {
  try {
    assertTrustedMutation(request)
    const auth = await requireWorkspaceAccess(request, { scopes: ["deals:write"] })
    await retryIntakeProcessing(await actorForDeals(auth), (await context.params).intakeId)
    return NextResponse.json({ queued: true }, { status: 202 })
  } catch (error) { return apiError(error) }
}
