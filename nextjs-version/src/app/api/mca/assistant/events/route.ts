import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { authorize } from "@/lib/mca/assistant/operations"
import { ownedConversation } from "@/lib/mca/assistant/repository"
import { savedEvents } from "@/lib/mca/assistant/experience"
export async function GET(request: Request) {
  try {
    const q = new URL(request.url).searchParams,
      actor = await authorize(request)
    const c = await ownedConversation(
      actor,
      z.string().uuid().parse(q.get("conversationId"))
    )
    return NextResponse.json(
      {
        events: await savedEvents(
          c,
          z.string().uuid().parse(q.get("runId")),
          z.coerce
            .number()
            .int()
            .min(0)
            .parse(q.get("after") ?? 0)
        )
      },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
