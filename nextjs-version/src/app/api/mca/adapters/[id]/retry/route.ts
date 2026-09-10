import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireAdapterAdmin } from "@/lib/mca/submissions/adapters/credentials"
import { retryAdapterAction } from "@/lib/mca/submissions/adapters/framework"
import type { AdapterAction } from "@/lib/mca/submissions/adapters/contracts"
import type { SubmissionJob } from "@/lib/mca/submissions/contracts"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireAdapterAdmin(request)
    let body: {
      action?: AdapterAction
      job?: Partial<SubmissionJob>
      correlationId?: string
      externalRef?: string
    } = {}
    try {
      const text = await request.text()
      if (text.trim()) body = JSON.parse(text) as typeof body
    } catch {
      throw new AppError(400, "invalid_json", "Request body must be valid JSON.")
    }
    return NextResponse.json(await retryAdapterAction(actor, (await context.params).id, body), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
