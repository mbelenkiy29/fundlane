import { NextResponse } from "next/server"
import { z } from "zod"
import { previewFollowupPolicy, requireFollowupAdminRead } from "@/lib/mca/comms/followups"
import { apiError, AppError } from "@/lib/mca/errors"
import { appOrigin, readJson } from "@/lib/mca/http"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

const bodySchema = z.object({
  policyId: z.string().trim().min(1).max(80),
  dealId: z.string().trim().min(1).max(80).optional(),
  nowIso: z.string().min(1).optional(),
}).strict()

function clockFrom(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  if (!Number.isFinite(Date.parse(value))) {
    throw new AppError(422, "invalid_clock", "Provide a valid ISO-8601 nowIso for follow-up schedules.")
  }
  return value
}

export async function GET(request: Request) {
  try {
    const actor = await requireFollowupAdminRead(request)
    const url = new URL(request.url)
    const policyId = url.searchParams.get("policyId")
    if (!policyId?.trim()) {
      throw new AppError(422, "validation_failed", "Review the highlighted fields.", { policyId: ["Choose a follow-up policy."] })
    }
    return NextResponse.json(await previewFollowupPolicy(actor, {
      policyId,
      dealId: url.searchParams.get("dealId") ?? undefined,
      nowIso: clockFrom(url.searchParams.get("nowIso")),
      origin: appOrigin(request),
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireFollowupAdminRead(request)
    const input = await readJson(request, bodySchema)
    return NextResponse.json(await previewFollowupPolicy(actor, {
      policyId: input.policyId,
      dealId: input.dealId,
      nowIso: clockFrom(input.nowIso),
      origin: appOrigin(request),
    }), { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
