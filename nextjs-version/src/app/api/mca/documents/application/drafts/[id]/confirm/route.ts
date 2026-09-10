import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { confirmApplicationDraft } from "@/lib/mca/documents/application-drafts"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const body = await request.json() as { confirmationId: string; mode: "create" | "merge"; targetDealId?: string; expectedVersion?: number; acceptedConflictFields?: string[]; manualFields?: DealWriteInput }
    return NextResponse.json(await confirmApplicationDraft(actor, { draftId: (await context.params).id, ...body }), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
