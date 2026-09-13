import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, requireWorkspaceAccess } from "@/lib/mca/auth"
import { actorForDeals } from "@/lib/mca/deals/service"
import { recordReceipt } from "@/lib/mca/deals/remittance"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

export const runtime = "nodejs"

const schema = z.object({
  amountCents: z.number().int().positive(),
  receivedAt: z.string().min(8),
  origin: z.enum(["manual", "csv", "system"]).optional(),
  idempotencyKey: z.string().trim().min(1).max(160),
}).strict()

export async function POST(request: Request, context: { params: Promise<{ advanceId: string }> }) {
  try {
    assertTrustedMutation(request)
    const actor = await actorForDeals(await requireWorkspaceAccess(request, { sessionOnly: true, roles: ["admin", "super_admin", "manager"] }))
    return NextResponse.json(await recordReceipt(actor, (await context.params).advanceId, await readJson(request, schema)))
  } catch (error) { return apiError(error) }
}
