import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { previewDraftMerge } from "@/lib/mca/documents/application-drafts"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const body = await request.json() as { targetDealId?: string; manualFields?: DealWriteInput }
    return NextResponse.json(await previewDraftMerge(actor, (await context.params).id, String(body.targetDealId ?? ""), body.manualFields), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
