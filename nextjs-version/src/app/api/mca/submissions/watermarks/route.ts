import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getWatermarkSettings,
  requireWatermarkAdmin,
  updateWatermarkSettings,
  type UpdateWatermarkSettingsInput,
} from "@/lib/mca/submissions/watermarks"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireWatermarkAdmin(request, "read")
    return NextResponse.json(await getWatermarkSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireWatermarkAdmin(request, "write")
    let input: UpdateWatermarkSettingsInput
    try {
      input = await request.json() as UpdateWatermarkSettingsInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateWatermarkSettings(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
