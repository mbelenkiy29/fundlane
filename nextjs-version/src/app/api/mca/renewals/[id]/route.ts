import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { updateRenewalAction } from "@/lib/mca/renewals/service"

const schema = z.object({
  messageSubject: z.string().trim().min(1).max(200).optional(), messageBody: z.string().trim().min(1).max(5000).optional(),
  state: z.enum(["eligible", "contacted", "documents_requested", "converted", "dismissed"]).optional(),
  renewedDealId: z.string().min(1).nullable().optional(), requestDocumentation: z.boolean().optional(),
}).strict()
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    return NextResponse.json(await updateRenewalAction(actor, (await context.params).id, await readJson(request, schema)))
  } catch (error) { return apiError(error) }
}
