import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { apiError } from "@/lib/mca/errors"
import { getMailboxReadiness } from "@/lib/mca/senders/readiness"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    const auth = await requireWorkspaceAccess(request, { sessionOnly: true })
    return NextResponse.json(await getMailboxReadiness(await actorForDeals(auth)), {
      headers: { "cache-control": "no-store" },
    })
  } catch (error) { return apiError(error) }
}
