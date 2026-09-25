import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  previewProtectedDocument,
  requireDocumentProtectionPreview,
} from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireDocumentProtectionPreview(request)
    let body: { documentId?: unknown; funderId?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await previewProtectedDocument(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
