import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { analyzeDealStatements, requireStatementActor } from "@/lib/mca/underwriting/statements"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request, context: { params: Promise<{ dealId: string }> }) {
  try {
    const actor = await requireStatementActor(request, "write")
    return NextResponse.json(await analyzeDealStatements(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) { return apiError(error) }
}
