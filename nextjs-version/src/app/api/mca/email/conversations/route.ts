import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { requireSmsActor, parseSmsQuery } from "@/lib/mca/sms/http"
import { z } from "zod"
const noStore = { "cache-control": "no-store" }
export const runtime = "nodejs"
import { listEmailConversations } from "@/lib/mca/email-conversations/service"
export async function GET(request: Request) {
  try {
    const q = parseSmsQuery(
      z.object({
        dealId: z.string().min(1).optional(),
        cursor: z
          .string()
          .max(500)
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
      }),
      request
    )
    return NextResponse.json(
      await listEmailConversations(
        await requireSmsActor(request, { mode: "read" }),
        q.dealId,
        q.cursor
      ),
      { headers: noStore }
    )
  } catch (error) {
    return apiError(error)
  }
}
