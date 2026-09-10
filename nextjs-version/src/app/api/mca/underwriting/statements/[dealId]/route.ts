import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { getDealStatementUnderwriting, requireStatementActor } from "@/lib/mca/underwriting/statements"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request, context: { params: Promise<{ dealId: string }> }) {
  try {
    const actor = await requireStatementActor(request, "read")
    return NextResponse.json(await getDealStatementUnderwriting(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) { return apiError(error) }
}
