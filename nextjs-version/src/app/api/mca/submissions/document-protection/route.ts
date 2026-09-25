import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getDocumentProtectionSettings,
  requireDocumentProtectionAdmin,
  requireDocumentProtectionRead,
  updateDocumentProtectionSettings,
} from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireDocumentProtectionRead(request)
    return NextResponse.json(await getDocumentProtectionSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
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
    return NextResponse.json(await updateDocumentProtectionSettings(actor, body as { enabled?: unknown }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
