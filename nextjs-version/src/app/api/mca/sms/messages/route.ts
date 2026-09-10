import { createHash } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { parseSmsQuery, requireSmsActor } from "@/lib/mca/sms/http"
import { deliverClosingSms, getSmsComposerContext, previewDirectSms } from "@/lib/mca/sms/service"

const querySchema = z.object({ dealId: z.string().min(1) })
const schema = z.object({
  dealId: z.string().min(1),
  recipient: z.string().min(1),
  body: z.string().min(1).max(1600),
  senderAccountId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  preview: z.boolean().optional(),
}).strict()

export async function GET(request: Request) {
  try {
    const { dealId } = parseSmsQuery(querySchema, request)
    return NextResponse.json(await getSmsComposerContext(await requireSmsActor(request, { mode: "read" }), dealId), { headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" })
    const input = await readJson(request, schema)
    if (input.preview) {
      return NextResponse.json(await previewDirectSms(actor, input), { headers: { "cache-control": "no-store" } })
    }
    const payloadHash = createHash("sha256").update(input.body).digest("hex")
    return NextResponse.json(await deliverClosingSms(actor, { ...input, correlationId: actor.correlationId, payloadHash, deliveryMode: "never_attempted" }), { status: 201, headers: { "cache-control": "no-store" } })
  } catch (error) { return apiError(error) }
}
