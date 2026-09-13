import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { confirmApplicationScan } from "@/lib/mca/documents/application-scan"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const input = await request.json() as { extractionId: string; confirmationId: string; mode: "create" | "merge"; targetDealId?: string; expectedVersion?: number; acceptedConflictFields?: string[]; manualFields?: DealWriteInput; forceDuplicate?: boolean; attachMerchantId?: string }
    return NextResponse.json(await confirmApplicationScan(actor, input), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
