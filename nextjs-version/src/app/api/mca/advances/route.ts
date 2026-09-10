import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { listAdvances } from "@/lib/mca/advances/service"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    const asOf = new URL(request.url).searchParams.get("asOf") ?? undefined
    return NextResponse.json({ advances: await listAdvances(actor, asOf) }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

