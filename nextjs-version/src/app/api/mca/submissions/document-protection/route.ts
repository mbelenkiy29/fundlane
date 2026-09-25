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
    let body: { enabled?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateDocumentProtectionSettings(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
