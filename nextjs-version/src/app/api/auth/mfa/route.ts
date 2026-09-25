import { NextResponse } from "next/server"
import { z } from "zod"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"
import {
  beginTotpEnrollment,
  challengeTotp,
  confirmTotpEnrollment,
  disableTotp,
  getTotpAccessState,
  regenerateRecoveryCodes,
  resolveAppUserId,
} from "@/lib/mca/totp-service"

const headers = { "Cache-Control": "private, no-store" }
const totpCode = z.string().min(6).max(19)
const appActions = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enroll") }),
  z.object({ action: z.literal("confirm"), code: z.string().regex(/^\d{6}$/) }),
  z.object({ action: z.literal("challenge"), code: totpCode }),
  z.object({ action: z.literal("disable"), code: totpCode }),
  z.object({ action: z.literal("regenerate"), code: totpCode }),
  z.object({ action: z.literal("verify"), factorId: z.uuid(), code: z.string().regex(/^\d{6}$/) }),
])

async function requireIdentity() {
  const identity = await supabaseIdentity()
  if (!identity) throw new AppError(401, "authentication_required", "Sign in with a verified account to continue.")
  return identity
}

async function requireAppUser() {
  const identity = await requireIdentity()
  const userId = await resolveAppUserId(identity.user.id)
  if (!userId) throw new AppError(409, "account_not_linked", "Finish company setup before managing two-factor authentication.")
  return { identity, userId }
}

export async function GET() {
  try {
    const identity = await requireIdentity()
    const userId = await resolveAppUserId(identity.user.id)
    const client = await createSupabaseServerClient()
    const { data, error } = await client.auth.mfa.listFactors()
    const claims = await client.auth.getClaims()
    if (error || claims.error) throw new AppError(503, "mfa_unavailable", "Unable to load account security.")
    const totp = userId ? await getTotpAccessState({ userId, sessionId: identity.sessionId }) : await getTotpAccessState({ userId: null, sessionId: identity.sessionId })
    return NextResponse.json({
      ...totp,
      factors: data.totp.map(f => ({ id: f.id, name: f.friendly_name ?? "Authenticator", status: f.status })),
      verified: totp.sessionVerified || claims.data?.claims.aal === "aal2",
    }, { headers })
  } catch (error) { return apiError(error) }
}

export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const input = await readJson(request, appActions)
    if (input.action === "verify") {
      const client = await createSupabaseServerClient()
      await requireIdentity()
      await consumeRequestRateLimit(clientRateKey(request, "auth:mfa"), 10)
      const factors = await client.auth.mfa.listFactors()
      if (factors.error || !factors.data.all.some(f => f.id === input.factorId && f.factor_type === "totp")) throw new AppError(403, "mfa_factor_invalid", "This authenticator does not belong to your account.")
      const { error } = await client.auth.mfa.challengeAndVerify({ factorId: input.factorId, code: input.code })
      if (error) throw new AppError(400, "mfa_verification_failed", "That code is invalid or expired. Enter a new authenticator code.")
      return NextResponse.json({ success: true }, { headers })
    }
    const { identity, userId } = await requireAppUser()
    await consumeRequestRateLimit(clientRateKey(request, "auth:totp"), 8)
    await consumeRequestRateLimit(`auth:totp:user:${userId}`, 8)
    if (input.action === "enroll") {
      const enrollment = await beginTotpEnrollment(userId, identity.email)
      return NextResponse.json({ id: userId, secret: enrollment.secret, qrCode: enrollment.qrCode, otpauthUrl: enrollment.otpauthUrl }, { headers })
    }
    if (input.action === "confirm") {
      const result = await confirmTotpEnrollment(userId, input.code, identity.sessionId)
      return NextResponse.json({ success: true, recoveryCodes: result.recoveryCodes }, { headers })
    }
    if (input.action === "challenge") {
      const result = await challengeTotp(userId, identity.sessionId, input.code)
      return NextResponse.json({ success: true, method: result.method }, { headers })
    }
    if (input.action === "disable") {
      await disableTotp(userId, input.code)
      return NextResponse.json({ success: true }, { headers })
    }
    const result = await regenerateRecoveryCodes(userId, input.code)
    return NextResponse.json({ success: true, recoveryCodes: result.recoveryCodes }, { headers })
  } catch (error) { return apiError(error) }
}
