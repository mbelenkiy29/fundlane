import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { extractionProviderStatus } from "@/lib/mca/documents/extraction"
import { requireDocumentActor } from "@/lib/mca/documents/http"
import { scannerConfiguration } from "@/lib/mca/documents/service"

export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    await requireDocumentActor(request, "read")
    return NextResponse.json({ scanner: scannerConfiguration(), extraction: extractionProviderStatus() }, { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
