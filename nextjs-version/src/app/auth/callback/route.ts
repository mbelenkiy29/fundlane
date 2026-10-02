import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { authOrigin } from "@/lib/mca/supabase-auth-http"
import {
  callbackDestination,
  emailCallbackContinuation,
  emailCallbackChallenge,
} from "@/lib/mca/auth-navigation"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { apiError } from "@/lib/mca/errors"
import {
  isGoogleOauthCallback,
  markGoogleTotpSession,
  startPasswordTotpChallenge,
} from "@/lib/mca/totp-service"
export async function GET(request: Request) {
  const url = new URL(request.url),
    origin = authOrigin(request)
  const code = url.searchParams.get("code"),
    tokenHash = url.searchParams.get("token_hash"),
    type = url.searchParams.get("type")
  const continuation = url.searchParams.has("redirect_to")
    ? emailCallbackContinuation(url.searchParams.get("redirect_to"), origin)
    : url.searchParams.get("next")
  const next = callbackDestination(continuation, type === "recovery")
  const embeddedChallenge = emailCallbackChallenge(
    url.searchParams.get("redirect_to"),
    origin
  )
  const challengeId = url.searchParams.get("challenge") ?? embeddedChallenge
  const ambiguous =
    ["code", "token_hash", "type", "next", "redirect_to", "challenge"].some(
      (key) => url.searchParams.getAll(key).length > 1
    ) ||
    Boolean(
      url.searchParams.get("challenge") &&
      embeddedChallenge &&
      url.searchParams.get("challenge") !== embeddedChallenge
    )
  let success = false
  try {
    const enrollmentAuth = challengeId
      ? await import("@/lib/mca/onboarding/auth")
      : null
    let issued = false
    if (enrollmentAuth && !ambiguous) {
      try {
        await enrollmentAuth.requireIssuedEnrollmentChallenge(
          challengeId!,
          next
        )
        issued = true
      } catch {
        /* No issued challenge means no enrollment exception. */
      }
    }
    const client = await createSupabaseServerClient()
    if (url.searchParams.has("error") || ambiguous || (challengeId && !issued))
      success = false
    else if (
      tokenHash &&
      !code &&
      (type === "email" ||
        type === "signup" ||
        type === "recovery" ||
        (type === "magiclink" &&
          (issued || process.env.MCA_MAGIC_LINK_ENABLED === "true")))
    )
      success = !(await client.auth.verifyOtp({ token_hash: tokenHash, type }))
        .error
    else if (
      code &&
      !tokenHash &&
      (url.searchParams.get("flow") !== "magic-link" ||
        issued ||
        process.env.MCA_MAGIC_LINK_ENABLED === "true")
    )
      success = !(await client.auth.exchangeCodeForSession(code)).error
    if (success) {
      const identity = await supabaseIdentity({ allowPasswordSetup: true })
      success = Boolean(identity)
      if (identity) {
        if (issued && enrollmentAuth) {
          try {
            await enrollmentAuth.completeEnrollmentAuthentication(
              challengeId!,
              identity
            )
          } catch {
            success = false
          }
        }
        try {
          if (
            !issued &&
            url.searchParams.get("flow") !== "magic-link" &&
            isGoogleOauthCallback({
              hasCode: Boolean(code && !tokenHash),
              hasTokenHash: Boolean(tokenHash),
              type,
              provider:
                typeof identity.user.app_metadata?.provider === "string"
                  ? identity.user.app_metadata.provider
                  : null,
              next,
            })
          )
            await markGoogleTotpSession(identity)
          else await startPasswordTotpChallenge(identity)
        } catch {
          /* Session marking must not block a verified callback. */
        }
      }
    }
  } catch (error) {
    const response = apiError(error)
    response.headers.set("Cache-Control", "no-store")
    return response
  }
  const recovery = next.startsWith("/reset-password?")
  const retryNext = recovery
    ? new URL(next, origin).searchParams.get("next")!
    : next
  const target = success
    ? next
    : `${recovery ? "/forgot-password" : "/sign-in"}?error=verification_failed&next=${encodeURIComponent(retryNext)}`
  return NextResponse.redirect(new URL(target, origin), {
    headers: { "Cache-Control": "no-store" },
  })
}
