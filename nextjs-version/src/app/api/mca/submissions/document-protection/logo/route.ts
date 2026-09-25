import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireDocumentProtectionAdmin, uploadShopLogo } from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentProtectionAdmin(request, "write")
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be a JSON object.")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(400, "invalid_json", "Request body must be a JSON object.")
    }
    return NextResponse.json(await uploadShopLogo(actor, body as {
      documentId?: unknown
      filename?: unknown
      mimeType?: unknown
      base64?: unknown
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
