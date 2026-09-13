import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { getAdvance, recordAdvanceStatus } from "@/lib/mca/advances/service"

export const runtime = "nodejs"
const patchSchema = z.object({
  status: z.enum(["on_track", "missed_payment", "default", "renewed", "closed", "in_collections"]),
  reason: z.string().trim().min(1).max(500), effectiveAt: z.string().datetime().optional(),
}).strict()

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    return NextResponse.json(await getAdvance(actor, (await context.params).id), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    return NextResponse.json(await recordAdvanceStatus(actor, (await context.params).id, await readJson(request, patchSchema)))
  } catch (error) { return apiError(error) }
}
