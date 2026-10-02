import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import { requireSmsActor } from "@/lib/mca/sms/http"
const json = (data: unknown) =>
  NextResponse.json(data, { headers: { "cache-control": "no-store" } })
import {
  onboardingStatus,
  ensureCompany,
  submitProfile,
  registrationProfileInput,
  sendVerification,
} from "@/lib/mca/sms/onboarding"
import { consumeRequestRateLimit } from "@/lib/mca/auth"
export async function GET(request: Request) {
  try {
    return json(
      await onboardingStatus(
        await requireSmsActor(request, { mode: "read", settings: true })
      )
    )
  } catch (e) {
    return apiError(e)
  }
}
export async function POST(request: Request) {
  try {
    const actor = await requireSmsActor(request, {
      mode: "write",
      admin: true,
      settings: true,
    })
    const input = await readJson(
      request,
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("verify_email") }),
        z.object({ action: z.literal("submit"), profile: registrationProfileInput, useStoredEin: z.boolean().optional(), basicRevision: z.number().int().nonnegative().optional() }).strict(),
      ])
    )
    if (input.action === "verify_email") {
      await consumeRequestRateLimit(`sms-verify:${actor.workspaceId}`, 2)
      await ensureCompany(actor)
      return json(await sendVerification(actor.workspaceId, actor.userId!))
    }
    return json(await submitProfile(actor, input.profile, { useStoredEin: input.useStoredEin, basicRevision: input.basicRevision }))
  } catch (e) {
    return apiError(e)
  }
}
