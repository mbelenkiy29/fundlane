import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { runMissedPaymentAlerts } from "@/lib/mca/deals/remittance"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin"] }))
    return NextResponse.json(await runMissedPaymentAlerts(actor, new URL(request.url).searchParams.get("asOf") ?? undefined))
  } catch (error) { return apiError(error) }
}
