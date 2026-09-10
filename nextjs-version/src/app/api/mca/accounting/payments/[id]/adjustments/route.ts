import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { adjustPayment } from "@/lib/mca/accounting/service"

const schema = z.object({ amountCents: z.number().int().safe().refine((value) => value !== 0), reason: z.string().trim().min(1).max(500), idempotencyKey: z.string().min(1).max(200) }).strict()
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
    return NextResponse.json(await adjustPayment(actor, (await context.params).id, await readJson(request, schema)), { status: 201 })
  } catch (error) { return apiError(error) }
}
