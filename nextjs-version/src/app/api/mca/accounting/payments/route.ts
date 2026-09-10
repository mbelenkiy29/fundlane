import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { canViewCompanyTotals, requirePaymentActor } from "@/lib/mca/accounting/access"
import { addManualPayment, listPayments } from "@/lib/mca/accounting/service"

export const runtime = "nodejs"
const createSchema = z.object({
  advanceId: z.string().min(1), type: z.enum(["commission", "fee"]), expectedAmountCents: z.number().int().nonnegative().safe(),
  expectedAt: z.string().datetime().optional(), originatorMembershipId: z.string().min(1).optional(), idempotencyKey: z.string().min(1).max(200),
}).strict()

export async function GET(request: Request) {
  try {
    const actor = await requirePaymentActor(request, "read")
    const query = new URL(request.url).searchParams
    const status = query.get("status") as "expected" | "partial" | "received" | "void" | null
    if (status && !["expected", "partial", "received", "void"].includes(status)) throw new AppError(400, "invalid_status", "Choose a valid payment status filter.")
    return NextResponse.json(await listPayments(actor, {
      ...(status ? { status } : {}), originatorMembershipId: query.get("originatorMembershipId") ?? undefined,
      from: query.get("from") ?? undefined, to: query.get("to") ?? undefined,
    }, await canViewCompanyTotals(actor)), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
    const result = await addManualPayment(actor, await readJson(request, createSchema))
    return NextResponse.json(result.payment, { status: result.created ? 201 : 200,
      headers: { "x-idempotent-replay": result.created ? "false" : "true" } })
  } catch (error) { return apiError(error) }
}
