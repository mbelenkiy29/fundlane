import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { getDealStatementUnderwriting, requireStatementActor } from "@/lib/mca/underwriting/statements"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireStatementActor(request, "read")
    const dealId = new URL(request.url).searchParams.get("dealId")?.trim()
    if (!dealId) throw new AppError(422, "deal_id_required", "Choose a deal to list statement underwriting.")
    return NextResponse.json(await getDealStatementUnderwriting(actor, dealId), { headers: noStore })
  } catch (error) { return apiError(error) }
}
