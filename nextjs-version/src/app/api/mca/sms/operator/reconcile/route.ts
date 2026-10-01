import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertStrictPlatformMutation } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { z } from "zod"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { reconcileOperation } from "@/lib/mca/sms/maintenance"
export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    assertStrictPlatformMutation(request)
    assertTrustedMutation(request)
    await consumeRequestRateLimit(`platform-sms-operator:${actor.userId}`, 20)
    const context = null
    return NextResponse.json(
      await reconcileOperation(
        context,
        (await readJson(request, z.object({ id: z.string().min(1) }).strict()))
          .id, undefined, request
      ), { headers: { "Cache-Control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
