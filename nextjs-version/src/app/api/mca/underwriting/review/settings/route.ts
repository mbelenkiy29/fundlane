import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireAnalysisAdmin } from "@/lib/mca/underwriting/analysis"
import { updateReviewSettings } from "@/lib/mca/underwriting/review-mail"
import type { Role } from "@/lib/mca/types"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

export async function POST(request: Request) {
  try {
    const actor = await requireAnalysisAdmin(request)
    let body: { recipientRoles?: Role[]; ccEmails?: string[] }
    try {
      body = await request.json() as { recipientRoles?: Role[]; ccEmails?: string[] }
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await updateReviewSettings(actor, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
