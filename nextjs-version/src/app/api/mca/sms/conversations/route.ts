import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import {
  listConversations,
  conversationDetail,
  readConversation,
  associateConversation,
} from "@/lib/mca/sms/inbox"
export async function GET(request: Request) {
  try {
    const actor = await requireSmsActor(request, { mode: "read" }),
      q = new URL(request.url).searchParams
    return json(
      q.get("id")
        ? await conversationDetail(actor, q.get("id")!)
        : await listConversations(actor, q.get("dealId") ?? undefined)
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireSmsActor(request, { mode: "write" }),
      input = await readJson(
        request,
        z
          .object({
            id: z.string().min(1),
            dealId: z.string().min(1).optional(),
          })
          .strict()
      )
    return json(
      input.dealId
        ? await associateConversation(actor, input.id, input.dealId)
        : await readConversation(actor, input.id)
    )
  } catch (e) {
    return apiError(e)
  }
}
