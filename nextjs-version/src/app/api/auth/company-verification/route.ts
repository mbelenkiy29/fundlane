import { NextResponse } from "next/server"
import { z } from "zod"
import {
  assertTrustedMutation,
  consumeRequestRateLimit,
  clientRateKey,
} from "@/lib/mca/auth"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { verifyEmail } from "@/lib/mca/sms/onboarding"
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, "verify-company"), 10)
    return NextResponse.json(
      await verifyEmail(
        (
          await readJson(
            request,
            z.object({ token: z.string().min(20).max(200) }).strict()
          )
        ).token
      ),
      { headers: { "cache-control": "no-store" } }
    )
  } catch (e) {
    return apiError(e)
  }
}
