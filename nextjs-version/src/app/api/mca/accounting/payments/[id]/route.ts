import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { reconcilePayment } from "@/lib/mca/accounting/service"

const schema = z.object({ receivedAmountCents: z.number().int().nonnegative().safe(), receivedAt: z.string().datetime() }).strict()
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await requirePaymentActor(request, "write")
    return NextResponse.json(await reconcilePayment(actor, (await context.params).id, await readJson(request, schema)))
  } catch (error) { return apiError(error) }
}

