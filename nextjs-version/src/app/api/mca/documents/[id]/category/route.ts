import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { categorizeDocument } from "@/lib/mca/documents/service"
import type { DocumentCategory } from "@/lib/mca/documents/contracts"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const body = await request.json() as { category: DocumentCategory }
    return NextResponse.json(await categorizeDocument(actor, (await context.params).id, body.category), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
