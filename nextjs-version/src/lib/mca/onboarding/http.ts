import "server-only"
import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import {
  assertTrustedMutation,
  clientRateKey,
  consumeRequestRateLimit,
} from "../auth"
import { createOpaqueToken } from "../crypto"
import { apiError, AppError } from "../errors"
import { readJson } from "../http"
import { supabaseIdentity } from "../supabase-auth"
import { newPassword } from "../supabase-auth-http"
import {
  completeEnrollmentInvite,
  enrollmentBindingCookie,
  openEnrollmentInvite,
  readEnrollmentAuthCookie,
  requestEnrollmentAuthentication,
  verifyEnrollmentAuthentication,
} from "./auth"
import {
  claimEnrollment,
  readEnrollmentStatus,
  requireEnrollmentRuntime,
} from "./claim"
import { onboardingOrigin, startEnrollmentCheckout } from "./checkout"

export const enrollmentHttpHeaders = { "Cache-Control": "private, no-store" }
export const enrollmentLocatorSchema = z
  .object({
    enrollmentId: z.uuid(),
    destination: z.enum(["crm", "business", "billing"]).optional(),
    generation: z.number().int().positive().safe().optional(),
  })
  .strict()
export function assertEnrollmentMutation(request: Request): void {
  assertTrustedMutation(request)
  if (request.headers.get("origin") !== onboardingOrigin())
    throw new AppError(
      403,
      "untrusted_origin",
      "A trusted application Origin header is required."
    )
}
type EnrollmentHttpAction =
  | "session"
  | "start"
  | "status"
  | "auth"
  | "verify"
  | "claim"
  | "billing"
  | "invite-open"
  | "password"
const inviteQuerySchema = z
  .object({
    challenge: z.uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  })
  .strict()
export async function handleEnrollmentHttp(
  request: Request,
  action: EnrollmentHttpAction
): Promise<Response> {
  try {
    requireEnrollmentRuntime()
    if (action === "status") {
      const query = new URL(request.url).searchParams
      for (const key of ["enrollment", "destination", "generation"])
        if (query.getAll(key).length > 1)
          throw new AppError(
            400,
            "validation_failed",
            "Ambiguous enrollment locator."
          )
      const generation = query.get("generation")
      if (generation !== null && !/^[1-9]\d*$/.test(generation))
        throw new AppError(
          400,
          "validation_failed",
          "Invalid enrollment generation."
        )
      const input = enrollmentLocatorSchema.parse({
        enrollmentId: query.get("enrollment"),
        ...(query.has("destination")
          ? { destination: query.get("destination") }
          : {}),
        ...(generation !== null ? { generation: Number(generation) } : {}),
      })
      await consumeRequestRateLimit(
        clientRateKey(request, "enrollment:status"),
        60
      )
      const identity = await supabaseIdentity()
      const resumeSecret = (await cookies()).get(enrollmentBindingCookie)?.value
      return NextResponse.json(
        await readEnrollmentStatus({
          ...input,
          ...(identity ? { identity } : {}),
          ...(resumeSecret ? { resumeSecret } : {}),
        }),
        { headers: enrollmentHttpHeaders }
      )
    }
    if (action === "invite-open") {
      // Emailed links are GETs; like Auth callbacks, the bound token replaces an Origin check.
      await consumeRequestRateLimit(
        clientRateKey(request, "enrollment:invite"),
        15
      )
      const query = new URL(request.url).searchParams
      const parsed = inviteQuerySchema.safeParse(
        Object.fromEntries(query.entries())
      )
      const location =
        parsed.success && [...query.keys()].length === 2
          ? await openEnrollmentInvite(
              parsed.data.challenge,
              parsed.data.token
            )
          : "/enrollment"
      return NextResponse.redirect(new URL(location, onboardingOrigin()), {
        status: 303,
        headers: { ...enrollmentHttpHeaders, "Referrer-Policy": "no-referrer" },
      })
    }
    assertEnrollmentMutation(request)
    await consumeRequestRateLimit(
      clientRateKey(request, `enrollment:${action}`),
      action === "session" ? 10 : action === "verify" ? 15 : 10
    )
    if (action === "session") {
      await readJson(request, z.object({}).strict())
      const store = await cookies(),
        existing = store.get(enrollmentBindingCookie)?.value
      if (!existing || existing.length < 32 || existing.length > 256)
        store.set(enrollmentBindingCookie, createOpaqueToken(), {
          secure: true,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 2592000,
        })
      return NextResponse.json(
        { success: true },
        { headers: enrollmentHttpHeaders }
      )
    }
    if (action === "start") {
      await readJson(request, z.object({}).strict())
      const resumeSecret = (await cookies()).get(enrollmentBindingCookie)?.value
      if (
        !resumeSecret ||
        resumeSecret.length < 32 ||
        resumeSecret.length > 256
      )
        throw new AppError(
          409,
          "enrollment_browser_binding_required",
          "Initialize this browser before starting a trial."
        )
      const identity = await supabaseIdentity()
      return NextResponse.json(
        await startEnrollmentCheckout({
          resumeSecret,
          ...(identity ? { initiatingProviderUserId: identity.user.id } : {}),
        }),
        { headers: enrollmentHttpHeaders }
      )
    }
    if (action === "auth") {
      const input = await readJson(
        request,
        enrollmentLocatorSchema.extend({ email: z.email().max(320) }).strict()
      )
      await requestEnrollmentAuthentication({
        ...input,
        resumeSecret: (await cookies()).get(enrollmentBindingCookie)?.value,
      })
      return NextResponse.json(
        { success: true, challengeId: (await readEnrollmentAuthCookie())?.id },
        { headers: enrollmentHttpHeaders }
      )
    }
    if (action === "verify") {
      const input = await readJson(
        request,
        z
          .object({
            challengeId: z.uuid(),
            email: z.email().max(320),
            token: z.string().regex(/^\d{6,10}$/),
          })
          .strict()
      )
      return NextResponse.json(
        { success: true, ...(await verifyEnrollmentAuthentication(input)) },
        { headers: enrollmentHttpHeaders }
      )
    }
    if (action === "password") {
      const input = await readJson(
        request,
        z
          .object({
            challengeId: z.uuid(),
            email: z.email().max(320),
            password: newPassword.optional(),
          })
          .strict()
      )
      return NextResponse.json(
        { success: true, ...(await completeEnrollmentInvite(input)) },
        { headers: enrollmentHttpHeaders }
      )
    }
    const input = await readJson(request, enrollmentLocatorSchema)
    const identity = await supabaseIdentity()
    if (!identity)
      throw new AppError(
        401,
        "authentication_required",
        "Sign in with a verified account to continue."
      )
    if (action === "claim")
      return NextResponse.json(await claimEnrollment({ ...input, identity }), {
        headers: enrollmentHttpHeaders,
      })
    const { manageEnrollmentBilling } = await import("./recovery")
    return NextResponse.json(
      { url: await manageEnrollmentBilling({ ...input, identity }) },
      { headers: enrollmentHttpHeaders }
    )
  } catch (error) {
    const response = apiError(
      error instanceof z.ZodError
        ? new AppError(
            400,
            "validation_failed",
            "Review the enrollment locator."
          )
        : error
    )
    response.headers.set("Cache-Control", "private, no-store")
    return response
  }
}
