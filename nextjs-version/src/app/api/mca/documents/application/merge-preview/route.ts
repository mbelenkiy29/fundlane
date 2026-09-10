import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { reviewApplicationMerge } from "@/lib/mca/documents/application-scan"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const input = await request.json() as { extractionId?: string; targetDealId?: string; manualFields?: DealWriteInput }
    return NextResponse.json(await reviewApplicationMerge(actor, String(input.extractionId ?? ""), String(input.targetDealId ?? ""), input.manualFields), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
