import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  compressSubmissionPackage,
  getCompressSettings,
  requireCompressAdmin,
  requireCompressManual,
  updateCompressSettings,
  type UpdateCompressSettingsInput,
} from "@/lib/mca/submissions/compress"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireCompressAdmin(request, "read")
    return NextResponse.json(await getCompressSettings(actor), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireCompressAdmin(request, "write")
    let input: UpdateCompressSettingsInput
    try {
      input = await request.json() as UpdateCompressSettingsInput
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateCompressSettings(actor, input), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireCompressManual(request)
    let body: { documentId?: unknown; documentIds?: unknown; funderId?: unknown }
    try {
      body = await request.json() as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await compressSubmissionPackage(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
