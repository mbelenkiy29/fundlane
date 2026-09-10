import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getDataMerchConfig,
  requireDataMerchAdmin,
  saveDataMerchConfigWithDiagnostic,
  type SaveDataMerchConfigInput,
} from "@/lib/mca/datamerch/service"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireDataMerchAdmin(request, "read")
    return NextResponse.json(await getDataMerchConfig(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireDataMerchAdmin(request, "write")
    let input: SaveDataMerchConfigInput
    try {
      input = await request.json() as SaveDataMerchConfigInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await saveDataMerchConfigWithDiagnostic(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
