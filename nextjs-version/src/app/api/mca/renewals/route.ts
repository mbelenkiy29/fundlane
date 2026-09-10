import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { listRenewalActions, runRenewalEligibility } from "@/lib/mca/renewals/service"

async function actor(request: Request) {
  return actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
}
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams
    const state = query.get("state") as "eligible" | "contacted" | "documents_requested" | "converted" | "dismissed" | null
    return NextResponse.json({ actions: await listRenewalActions(await actor(request), { ...(state ? { state } : {}), eligibleBefore: query.get("eligibleBefore") ?? undefined }) })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try { assertTrustedMutation(request); return NextResponse.json(await runRenewalEligibility(await actor(request), new URL(request.url).searchParams.get("asOf") ?? undefined)) }
  catch (error) { return apiError(error) }
}
