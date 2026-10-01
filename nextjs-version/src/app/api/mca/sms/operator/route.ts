import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertStrictPlatformMutation } from "@/lib/mca/platform-audit"
import { NextResponse } from "next/server"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import {
  reviewQueue,
  reviewCompany,
  reviewSchema,
} from "@/lib/mca/sms/onboarding"
export async function GET(request: Request) {
  try {
    await requireSuperAdmin(request)
    return json(
      await reviewQueue(
        null, request
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireSuperAdmin(request)
    assertStrictPlatformMutation(request)
    assertTrustedMutation(request)
    await consumeRequestRateLimit(`platform-sms-operator:${actor.userId}`, 20)
    return json(
      await reviewCompany(
        null,
        await readJson(request, reviewSchema), request
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
