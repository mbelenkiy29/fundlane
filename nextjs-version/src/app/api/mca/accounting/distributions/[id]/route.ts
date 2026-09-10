import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { setDistributionStatus } from "@/lib/mca/accounting/service"
const schema = z.object({ status: z.enum(["paid", "void"]), paidAt: z.string().datetime().optional() }).strict()
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try { assertTrustedMutation(request); const actor = await requirePaymentActor(request, "write"); const input = await readJson(request, schema); return NextResponse.json(await setDistributionStatus(actor, (await context.params).id, input.status, input.paidAt)) }
  catch (error) { return apiError(error) }
}
