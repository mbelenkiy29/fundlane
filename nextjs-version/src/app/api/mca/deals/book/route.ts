import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { listDealBook, parseBookWindow, parseServicingStatuses } from "@/lib/mca/deals/book"
import { apiError } from "@/lib/mca/errors"

export const runtime = "nodejs"

function integerParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

export async function GET(request: Request) {
  try {
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { scopes: ["deals:read"] }))
    const query = new URL(request.url).searchParams
    return NextResponse.json(await listDealBook(actor, {
      search: query.get("q")?.trim() || undefined,
      statuses: parseServicingStatuses(query.get("status")),
      funder: query.get("funder")?.trim() || undefined,
      assignee: query.get("assignee")?.trim() || undefined,
      frequency: query.get("frequency")?.trim() || undefined,
      renewalEligible: query.get("renewal") === "1" || query.get("renewal") === "true" ? true : undefined,
      paidDownMin: integerParam(query.get("paidDownMin")),
      paidDownMax: integerParam(query.get("paidDownMax")),
      missedWindow: parseBookWindow(query.get("missedWindow")),
      completedWindow: parseBookWindow(query.get("completedWindow")),
      asOf: query.get("asOf") || undefined,
    }), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
