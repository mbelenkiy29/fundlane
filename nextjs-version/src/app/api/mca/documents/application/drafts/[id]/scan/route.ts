import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { retryApplicationDraftScan } from "@/lib/mca/documents/application-drafts"

export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { return NextResponse.json(await retryApplicationDraftScan(await requireDocumentActor(request, "write"), (await context.params).id), { headers: { "cache-control": "no-store" } }) }
  catch (error) { return apiError(error) }
}
