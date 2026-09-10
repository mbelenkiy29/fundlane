import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { scanApplicationDocument } from "@/lib/mca/documents/application-scan"

export const runtime = "nodejs"
export async function POST(request: Request) {
  try {
    const actor = await requireDocumentActor(request, "write")
    const input = await request.json() as { documentId?: string }
    return NextResponse.json(await scanApplicationDocument(actor, String(input.documentId ?? "")), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
