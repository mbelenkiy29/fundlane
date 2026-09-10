import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requirePaymentActor } from "@/lib/mca/accounting/access"
import { applySplitTemplate } from "@/lib/mca/accounting/service"

const schema = z.object({ paymentId: z.string().min(1), templateId: z.string().min(1), version: z.number().int().positive(), idempotencyKey: z.string().min(1).max(200) }).strict()
export async function POST(request: Request) {
  try { assertTrustedMutation(request); const actor = await requirePaymentActor(request, "write"); return NextResponse.json(await applySplitTemplate(actor, await readJson(request, schema)), { status: 201 }) }
  catch (error) { return apiError(error) }
}
