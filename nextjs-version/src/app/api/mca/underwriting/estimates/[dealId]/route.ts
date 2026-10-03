import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import { requireScoreActor } from "@/lib/mca/underwriting/scoring"
import { dealEstimatesEnabled, getDealEstimates } from "@/lib/mca/underwriting/estimates-loader"
import { ESTIMATE_FREQUENCIES, type EstimateAssumptions, type EstimateFrequency } from "@/lib/mca/underwriting/estimates"
export const runtime = "nodejs"

function number(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name)
  if (raw == null || raw === "") return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new AppError(422, "validation_failed", `${name} must be a number.`)
  return value
}

/** Out-of-range numbers are clamped by the formula, not rejected. */
function assumptions(params: URLSearchParams): EstimateAssumptions {
  const frequency = params.get("frequency") || undefined
  if (frequency && !(ESTIMATE_FREQUENCIES as readonly string[]).includes(frequency)) throw new AppError(422, "validation_failed", "frequency must be daily or weekly.")
  return { factor: number(params, "factor"), termMonths: number(params, "termMonths"), holdbackPct: number(params, "holdbackPct"), frequency: frequency as EstimateFrequency | undefined }
}

export async function GET(request: Request, context: { params: Promise<{ dealId: string }> }) {
  try {
    if (!dealEstimatesEnabled()) throw new AppError(404, "not_found", "Not found.")
    const actor = await requireScoreActor(request, "read")
    const input = assumptions(new URL(request.url).searchParams)
    return NextResponse.json(await getDealEstimates(actor, (await context.params).dealId, input), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
