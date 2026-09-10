import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { saveApplicationReview } from "@/lib/mca/documents/application-scan"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const input = await request.json() as { extractionId?: string; approvedFields?: DealWriteInput }
    return NextResponse.json(await saveApplicationReview(actor, String(input.extractionId ?? ""), input.approvedFields ?? {}), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
