import { NextResponse } from "next/server"
import { z } from "zod"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "@/lib/mca/auth"
import { apiError, AppError } from "@/lib/mca/errors"
import { readJson } from "@/lib/mca/http"

const headers = { "Cache-Control": "private, no-store" }
async function authenticatedClient() {
  if (!await supabaseIdentity()) throw new AppError(401, "authentication_required", "Sign in with a verified account to continue.")
  return createSupabaseServerClient()
}
export async function GET() {
  try {
    const client = await authenticatedClient()
    const { data, error } = await client.auth.mfa.listFactors()
    const claims = await client.auth.getClaims()
    if (error || claims.error) throw new AppError(503, "mfa_unavailable", "Unable to load account security.")
    return NextResponse.json({ factors: data.totp.map(f => ({ id: f.id, name: f.friendly_name ?? "Authenticator", status: f.status })), verified: claims.data?.claims.aal === "aal2" }, { headers })
  } catch (error) { return apiError(error) }
}
export async function POST(request: Request) {
  try {
    assertTrustedMutation(request)
    const client = await authenticatedClient()
    await consumeRequestRateLimit(clientRateKey(request, "auth:mfa"), 10)
    const input = await readJson(request, z.discriminatedUnion("action", [
      z.object({ action: z.literal("enroll") }),
      z.object({ action: z.literal("verify"), factorId: z.uuid(), code: z.string().regex(/^\d{6}$/) }),
    ]))
    if (input.action === "enroll") {
      const { data, error } = await client.auth.mfa.enroll({ factorType: "totp", issuer: "Fundlane" })
      if (error) throw new AppError(400, "mfa_enrollment_failed", "Unable to enroll an authenticator. Retry or use your existing authenticator.")
      return NextResponse.json({ id: data.id, secret: data.totp.secret, qrCode: data.totp.qr_code }, { headers })
    }
    const factors = await client.auth.mfa.listFactors()
    if (factors.error || !factors.data.all.some(f => f.id === input.factorId && f.factor_type === "totp")) throw new AppError(403, "mfa_factor_invalid", "This authenticator does not belong to your account.")
    const { error } = await client.auth.mfa.challengeAndVerify({ factorId: input.factorId, code: input.code })
    if (error) throw new AppError(400, "mfa_verification_failed", "That code is invalid or expired. Enter a new authenticator code.")
    return NextResponse.json({ success: true }, { headers })
  } catch (error) { return apiError(error) }
}
