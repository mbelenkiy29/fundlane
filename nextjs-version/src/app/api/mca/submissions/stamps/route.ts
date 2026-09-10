import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getStampSettings,
  requireStampAdmin,
  updateStampSettings,
  type UpdateStampSettingsInput,
} from "@/lib/mca/submissions/stamps"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireStampAdmin(request, "read")
    return NextResponse.json(await getStampSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireStampAdmin(request, "write")
    let input: UpdateStampSettingsInput
    try {
      input = await request.json() as UpdateStampSettingsInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateStampSettings(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
