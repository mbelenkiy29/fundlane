import { NextResponse } from "next/server"
import { z } from "zod"
import { readJson } from "@/lib/mca/http"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { changeBillingSeats } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
const input = z.object({ selectedSeats: z.number().int().min(1).max(100000) }).strict()
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    const payload = await readJson(request, input)
    return NextResponse.json(await changeBillingSeats(context.workspaceId, payload.selectedSeats, context.userId))
  } catch (error) { return apiError(error) }
}
