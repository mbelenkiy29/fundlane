import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { analyzeDealStatementsForCorrections, requireCorrectionActor } from "@/lib/mca/underwriting/corrections"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireCorrectionActor(request, "write")
    const body = await readBody(request)
    return NextResponse.json(await analyzeDealStatementsForCorrections(actor, (await context.params).dealId, {
      replaceReviewed: body.replaceReviewed === true,
    }), { headers: noStore })
  } catch (error) { return apiError(error) }
}

async function readBody(request: Request): Promise<{ replaceReviewed?: unknown }> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid")
    return body as { replaceReviewed?: unknown }
  } catch {
    throw new AppError(422, "invalid_json", "Request body must be JSON.")
  }
}
