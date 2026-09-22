import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireMembershipAccess } from "@/lib/mca/auth"
import { cancelBillingSubscription } from "@/lib/mca/billing"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const context = await requireMembershipAccess(request, ["admin", "super_admin"])
    await readJson(request, z.object({}).strict())
    return NextResponse.json(await cancelBillingSubscription(context.workspaceId, context.userId))
  } catch (error) { return apiError(error) }
}
