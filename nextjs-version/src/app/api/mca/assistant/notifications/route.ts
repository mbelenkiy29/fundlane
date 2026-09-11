import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import {
  listCreditNotifications,
  markCreditNotificationRead
} from "@/lib/mca/assistant/alerts"
import {
  assistantCreditIdentity,
  creditHeaders
} from "@/lib/mca/assistant/http"
export async function GET(request: Request) {
  try {
    const c = await assistantCreditIdentity(request, true)
    return NextResponse.json(
      await listCreditNotifications(c.workspaceId, c.userId),
      { headers: creditHeaders }
    )
  } catch (error) {
    return apiError(error)
  }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const c = await assistantCreditIdentity(request, true)
    const b = await readJson(
      request,
      z.object({ id: z.string().uuid() }).strict()
    )
    await markCreditNotificationRead(c.workspaceId, c.userId, b.id)
    return NextResponse.json({ ok: true }, { headers: creditHeaders })
  } catch (error) {
    return apiError(error)
  }
}
