import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
import { getSmsConsent, recordSmsConsent } from "@/lib/mca/sms/service"

const schema = z.object({ dealId: z.string().min(1), recipient: z.string().min(1), state: z.enum(["opted_in", "opted_out"]), evidence: z.string().min(1).max(500), effectiveAt: z.string().datetime().optional(), idempotencyKey: z.string().min(1) }).strict()
export async function GET(request: Request) {
  try {
    const url = new URL(request.url), dealId = url.searchParams.get("dealId"), recipient = url.searchParams.get("recipient")
    if (!dealId || !recipient) throw new AppError(422, "validation_failed", "dealId and recipient are required.")
    return NextResponse.json(await getSmsConsent(await requireSmsActor(request, { mode: "read" }), dealId, recipient), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try { return NextResponse.json(await recordSmsConsent(await requireSmsActor(request, { mode: "write" }), await readJson(request, schema)), { status: 201, headers: { "cache-control": "no-store" } }) }
  catch (error) { return apiError(error) }
}

