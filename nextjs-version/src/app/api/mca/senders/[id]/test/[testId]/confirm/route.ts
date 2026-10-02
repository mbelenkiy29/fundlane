import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSenderUse, confirmSenderTestReceipt } from "@/lib/mca/senders/service"
import { readJson } from "@/lib/mca/http"
import { z } from "zod"
export const runtime = "nodejs"
export async function POST(request: Request, context: { params: Promise<{ id: string; testId: string }> }) {
  try { const actor = await requireSenderUse(request), { id, testId } = await context.params; return NextResponse.json(await confirmSenderTestReceipt(actor, id, testId, await readJson(request, z.object({ received: z.literal(true) }).strict())), { headers: { "cache-control": "no-store" } }) } catch (e) { return apiError(e) }
}
