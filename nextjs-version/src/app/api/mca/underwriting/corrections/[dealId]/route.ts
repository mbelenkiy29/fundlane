import { NextResponse } from "next/server"
import { apiError, AppError } from "@/lib/mca/errors"
import {
  correctExistingPosition,
  correctStatementMonth,
  getDealCorrections,
  requireCorrectionActor,
} from "@/lib/mca/underwriting/corrections"
import type { ExistingPositionCandidate } from "@/lib/mca/underwriting/contracts"

export const runtime = "nodejs"
const noStore = { "cache-control": "no-store" }

interface RouteContext { params: Promise<{ dealId: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const actor = await requireCorrectionActor(request, "read")
    return NextResponse.json(await getDealCorrections(actor, (await context.params).dealId), { headers: noStore })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const actor = await requireCorrectionActor(request, "write")
    const dealId = (await context.params).dealId
    const body = await readJson(request)
    if (typeof body.monthId === "string" && body.monthId.trim()) {
      return NextResponse.json(await correctStatementMonth(actor, {
        dealId,
        monthId: body.monthId.trim(),
        reason: String(body.reason ?? ""),
        ...(hasOwn(body, "deposits") ? { deposits: body.deposits as number | null } : {}),
        ...(hasOwn(body, "depositCount") ? { depositCount: body.depositCount as number | null } : {}),
        ...(hasOwn(body, "averageDailyBalance") ? { averageDailyBalance: body.averageDailyBalance as number | null } : {}),
        ...(hasOwn(body, "nsfCount") ? { nsfCount: body.nsfCount as number | null } : {}),
        ...(hasOwn(body, "negativeDays") ? { negativeDays: body.negativeDays as number | null } : {}),
        ...(hasOwn(body, "endingBalance") ? { endingBalance: body.endingBalance as number | null } : {}),
      }), { headers: noStore })
    }
    if (typeof body.positionId === "string" && body.positionId.trim()) {
      return NextResponse.json(await correctExistingPosition(actor, {
        dealId,
        positionId: body.positionId.trim(),
        reason: String(body.reason ?? ""),
        status: body.status as ExistingPositionCandidate["status"],
        ...(hasOwn(body, "estimatedPayment") ? { estimatedPayment: body.estimatedPayment as number | null } : {}),
      }), { headers: noStore })
    }
    throw new AppError(422, "validation_failed", "Choose a statement month or existing position to correct.", {
      monthId: ["Provide monthId or positionId."],
    })
  } catch (error) { return apiError(error) }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json() as unknown
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid")
    return body as Record<string, unknown>
  } catch {
    throw new AppError(422, "invalid_json", "Request body must be JSON.")
  }
}
