import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { retryDocumentScan } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDocumentActor(request, "write")
    return NextResponse.json(await retryDocumentScan(actor, (await context.params).id), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
