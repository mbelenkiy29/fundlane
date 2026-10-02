import { NextResponse } from "next/server"
import { z } from "zod"
import { requireSuperAdmin } from "@/lib/mca/platform-auth"
import { assertTrustedMutation, consumeRequestRateLimit } from "@/lib/mca/auth"
import { assertStrictPlatformMutation } from "@/lib/mca/platform-audit"
import { apiError, AppError } from "@/lib/mca/errors"
import { getDatabase } from "@/lib/mca/db"
import { readJson } from "@/lib/mca/http"
import {
  authorizeEnrollmentContactVerification,
  recoverEnrollmentContact,
} from "@/lib/mca/onboarding/recovery"
import {
  assertEnrollmentMutation,
  enrollmentHttpHeaders,
} from "@/lib/mca/onboarding/http"
import { findEnrollment } from "@/lib/mca/onboarding/store"
import { requireEnrollmentRuntime } from "@/lib/mca/onboarding/claim"

type Context = { params: Promise<{ id: string }> }
const evidence = {
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
  purchaseEvidence: z.string().min(8).max(200),
}
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("verify_target"),
      correctedEmail: z.email().max(320),
      ...evidence,
    })
    .strict(),
  z
    .object({
      action: z.literal("approve_identity"),
      verifiedProviderUserId: z.uuid(),
      ...evidence,
    })
    .strict(),
])
function responseError(error: unknown) {
  const response = apiError(
    error instanceof z.ZodError
      ? new AppError(400, "validation_failed", "Review the recovery command.")
      : error
  )
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
export async function GET(request: Request, context: Context) {
  try {
    await requireSuperAdmin(request)
    requireEnrollmentRuntime()
    const { id } = await context.params,
      row = await findEnrollment(z.uuid().parse(id))
    if (!row)
      throw new AppError(404, "enrollment_not_found", "Enrollment unavailable.")
    const targetVerification = await getDatabase()
      .prepare<{
        id: string
        state: string
        provider_user_id: string | null
        verified_at: string | null
      }>("SELECT id,state,provider_user_id,verified_at FROM mca_enrollment_challenges WHERE enrollment_id=? AND purpose='contact_recovery' ORDER BY created_at DESC LIMIT 5")
      .all(row.id)
    return NextResponse.json(
      {
        enrollmentId: row.id,
        revision: row.revision,
        claimState: row.claimState,
        recoveryState: row.recoveryState,
        emailGeneration: row.emailGeneration,
        billingState: row.billingState,
        trialEndsAt: row.trialEndsAt,
        providerAccountId: row.providerAccountId,
        checkoutSessionId: row.checkoutSessionId,
        subscriptionId: row.subscriptionId,
        livemode: row.offer.livemode,
        targetVerification,
      },
      { headers: enrollmentHttpHeaders }
    )
  } catch (error) {
    return responseError(error)
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireSuperAdmin(request)
    requireEnrollmentRuntime()
    assertTrustedMutation(request)
    assertStrictPlatformMutation(request)
    assertEnrollmentMutation(request)
    await consumeRequestRateLimit(`platform-enrollment:${actor.userId}`, 10)
    const { id } = await context.params
    const enrollmentId = z.uuid().parse(id),
      input = await readJson(request, actionSchema)
    if (input.action === "verify_target")
      await authorizeEnrollmentContactVerification(
        actor,
        { enrollmentId, ...input },
        request
      )
    else
      await recoverEnrollmentContact(actor, { enrollmentId, ...input }, request)
    return NextResponse.json(
      { success: true },
      { headers: enrollmentHttpHeaders }
    )
  } catch (error) {
    return responseError(error)
  }
}
