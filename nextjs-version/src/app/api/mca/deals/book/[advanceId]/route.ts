import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { getDealBookRow } from "@/lib/mca/deals/book"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"

export async function GET(request: Request, context: { params: Promise<{ advanceId: string }> }) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    return NextResponse.json(await getDealBookRow(actor, (await context.params).advanceId), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
