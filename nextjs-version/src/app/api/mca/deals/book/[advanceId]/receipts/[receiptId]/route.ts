import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { voidReceipt } from "@/lib/mca/deals/remittance"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"

const schema = z.object({
  status: z.literal("void"),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(160),
}).strict()

export async function PATCH(request: Request, context: { params: Promise<{ advanceId: string; receiptId: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin", "manager"] }))
    const params = await context.params
    const input = await readJson(request, schema)
    return NextResponse.json(await voidReceipt(actor, params.advanceId, params.receiptId, {
      reason: input.reason, idempotencyKey: input.idempotencyKey,
    }))
  } catch (error) { return apiError(error) }
}
