import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getDocumentProtectionSettings,
  requireDocumentProtectionAdmin,
  updateDocumentProtectionSettings,
  type UpdateDocumentProtectionInput,
} from "@/lib/mca/submissions/document-protection"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireDocumentProtectionAdmin(request, "read")
    return NextResponse.json(await getDocumentProtectionSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireDocumentProtectionAdmin(request, "write")
    let input: UpdateDocumentProtectionInput
    try {
      input = await request.json() as UpdateDocumentProtectionInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateDocumentProtectionSettings(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
