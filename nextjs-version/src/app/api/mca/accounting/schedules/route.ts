import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { createReverseConsolidation, listReverseConsolidations } from "@/lib/mca/accounting/schedules"

export const runtime = "nodejs"

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
const createSchema = z.object({
  dealId: z.string().min(1),
  referencedAdvanceIds: z.array(z.string().min(1)).min(1),
  startDate: calendarDate,
  installmentCount: z.number().int().positive().safe(),
  installmentCents: z.number().int().positive().safe(),
  splitTemplateId: z.string().min(1),
  splitTemplateVersion: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(200),
}).strict()

export async function GET(request: Request) {
  try {
    const actor = await requirePaymentActor(request, "read")
    return NextResponse.json(await listReverseConsolidations(actor), { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
    const result = await createReverseConsolidation(actor, await readJson(request, createSchema))
    return NextResponse.json(
      { consolidation: result.consolidation, schedule: result.schedule },
      { status: result.created ? 201 : 200, headers: { "x-idempotent-replay": result.created ? "false" : "true" } },
    )
  } catch (error) {
    return apiError(error)
  }
}
