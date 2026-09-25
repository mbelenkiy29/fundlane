import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { previewDocumentProtection, requireDocumentProtectionPreview } from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentProtectionPreview(request)
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be a JSON object.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "invalid_json", "Request body must be a JSON object.")
    }
    return NextResponse.json(await previewDocumentProtection(actor, body as {
      documentId?: unknown
      funderId?: unknown
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
