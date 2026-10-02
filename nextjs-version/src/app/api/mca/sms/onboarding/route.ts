import { NextResponse } from "next/server"
import { z } from "zod"
import { apiError, AppError } from "@/lib/mca/errors"
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
const onboardingInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify_email") }).strict(),
  z.object({ action: z.literal("submit"), profile: registrationProfileInput, useStoredEin: z.boolean().optional(), basicRevision: z.number().int().nonnegative().optional() }).strict(),
])
async function readOnboardingInput(request: Request) {
  const parsed = onboardingInput.safeParse(await readJson(request, z.unknown()))
  if (parsed.success) return parsed.data
  const fields: Record<string, string[]> = {}
  for (const issue of parsed.error.issues) {
    const [parent, field] = issue.path
    const path = parent === "profile" && typeof field === "string" && Object.hasOwn(registrationProfileInput.shape, field)
      ? `profile.${field}` : ["action", "profile", "useStoredEin", "basicRevision"].includes(String(parent)) ? String(parent) : "request"
    fields[path] = ["Review this field."]
  }
  throw new AppError(400, "validation_failed", "Review the highlighted fields.", fields)
}
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
    const input = await readOnboardingInput(request)
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
