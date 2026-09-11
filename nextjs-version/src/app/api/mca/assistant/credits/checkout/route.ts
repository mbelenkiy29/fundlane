import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { createCreditCheckout } from "@/lib/mca/assistant/purchases"
import {
  assistantCreditIdentity,
  creditHeaders
} from "@/lib/mca/assistant/http"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const c = await assistantCreditIdentity(request, true)
    await consumeRequestRateLimit(
      `credit-checkout:${c.workspaceId}:${c.userId}`,
      5
    )
    const b = await readJson(
      request,
      z
        .object({
          recipientUserId: z.string().min(1).max(128),
          requestId: z.string().uuid()
        })
        .strict()
    )
    return NextResponse.json(
      await createCreditCheckout(
        c.workspaceId,
        c.userId,
        b.recipientUserId,
        b.requestId
      ),
      { headers: creditHeaders }
    )
  } catch (error) {
    return apiError(error)
  }
}
