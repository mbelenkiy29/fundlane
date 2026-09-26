import { NextResponse } from "next/server"
import { requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { requireAnalysisAdmin } from "@/lib/mca/underwriting/analysis"
import { autoSubmitEnabled, getAutoSubmitSettings, setAutoSubmitSettings } from "@/lib/mca/underwriting/auto-submit"
import { listFunders } from "@/lib/mca/funders/directory"
import { apiError, AppError } from "@/lib/mca/errors"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    if (!autoSubmitEnabled()) throw new AppError(404, "feature_unavailable", "Auto-submit is unavailable.")
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { roles: ["admin", "super_admin"], sessionOnly: true }))
    const settings = await getAutoSubmitSettings(actor.workspaceId)
    const funders = await listFunders(actor)
    return NextResponse.json({ settings, funders: funders.filter(funder => funder.active).map(funder => ({ id: funder.id, name: funder.legalName })) }, { headers: noStore })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    if (!autoSubmitEnabled()) throw new AppError(404, "feature_unavailable", "Auto-submit is unavailable.")
    const actor = await requireAnalysisAdmin(request)
    return NextResponse.json(await setAutoSubmitSettings(actor, await request.json()), { headers: noStore })
  } catch (error) { return apiError(error) }
}
