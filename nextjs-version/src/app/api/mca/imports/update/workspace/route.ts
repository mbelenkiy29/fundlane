import { NextResponse } from "next/server"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { ensureBulkUpdateRegistry } from "@/lib/mca/imports/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
    return NextResponse.json(await ensureBulkUpdateRegistry(actor), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
