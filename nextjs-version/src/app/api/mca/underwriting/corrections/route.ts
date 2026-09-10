import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { getDealCorrections, requireCorrectionActor } from "@/lib/mca/underwriting/corrections"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireCorrectionActor(request, "read")
    const dealId = new URL(request.url).searchParams.get("dealId")?.trim()
    if (!dealId) throw new AppError(422, "deal_id_required", "Choose a deal to list underwriting corrections.")
    return NextResponse.json(await getDealCorrections(actor, dealId), { headers: noStore })
  } catch (error) { return apiError(error) }
}
