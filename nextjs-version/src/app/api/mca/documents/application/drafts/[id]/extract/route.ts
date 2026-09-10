import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { extractApplicationDraft } from "@/lib/mca/documents/application-drafts"
import type { DealWriteInput } from "@/lib/mca/deals/schema"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const body = await request.json().catch(() => ({})) as { approvedFields?: DealWriteInput }
    return NextResponse.json(await extractApplicationDraft(actor, (await context.params).id, body.approvedFields), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
