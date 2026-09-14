import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSmsActor, parseSmsQuery } from "@/lib/mca/sms/http"
import { z } from "zod"
const noStore = { "cache-control": "no-store" }
export const runtime = "nodejs"
import {
  emailMessages,
  markEmailRead,
  queueEmail,
} from "@/lib/mca/email-conversations/service"
import { emailReplySchema } from "@/lib/mca/email-conversations/contracts"
import { readJson } from "@/lib/mca/http"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, context: Context) {
  try {
    const q = parseSmsQuery(
      z.object({
        before: z
          .string()
          .regex(/^\d{1,18}$/)
          .optional(),
      }),
      request
    )
    return NextResponse.json(
      await emailMessages(
        await requireSmsActor(request, { mode: "read" }),
        (await context.params).id,
        q.before
      ),
      { headers: noStore }
    )
  } catch (error) {
    return apiError(error)
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" })
    return NextResponse.json(
      await queueEmail(
        actor,
        await readJson(request, emailReplySchema),
        (await context.params).id
      ),
      { status: 202, headers: noStore }
    )
  } catch (error) {
    return apiError(error)
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" }),
      input = await readJson(
        request,
        z.object({ sequence: z.string().regex(/^\d{1,18}$/) }).strict()
      )
    await markEmailRead(actor, (await context.params).id, input.sequence)
    return NextResponse.json({ ok: true }, { headers: noStore })
  } catch (error) {
    return apiError(error)
  }
}
