import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  getRequiredStatementMonths,
  requireCompletenessActor,
  requireCompletenessAdmin,
  setRequiredStatementMonths,
} from "@/lib/mca/underwriting/completeness"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function GET(request: Request) {
  try {
    const actor = await requireCompletenessActor(request, "read")
    return NextResponse.json({ requiredStatementMonths: await getRequiredStatementMonths(actor) }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireCompletenessAdmin(request)
    const body = await request.json() as { requiredStatementMonths?: unknown }
    const n = body.requiredStatementMonths
    if (typeof n !== "number") throw new AppError(422, "validation_failed", "Required statement months must be an integer between 1 and 24.", { requiredStatementMonths: ["Enter a whole number from 1 to 24."] })
    return NextResponse.json(await setRequiredStatementMonths(actor, n), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
