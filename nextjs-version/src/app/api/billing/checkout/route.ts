import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { createBillingCheckout } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
import { recordAuditEvent } from "@/lib/mca/db"
const input = z.object({ selectedSeats: z.number().int().min(1).max(100000), onboarding: z.boolean().optional() }).strict()
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    const payload = input.parse(await request.json())
    const result = await createBillingCheckout(context.workspaceId, payload.selectedSeats, payload.onboarding)
    await recordAuditEvent({ context, action: "billing.checkout_opened", resourceType: "workspace", resourceId: context.workspaceId, metadata: { selectedSeats: payload.selectedSeats } })
    return NextResponse.json(result)
  } catch (error) { return apiError(error) }
}
