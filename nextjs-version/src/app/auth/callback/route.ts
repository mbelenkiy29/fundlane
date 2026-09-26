import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { authOrigin } from "@/lib/mca/supabase-auth-http"
import { callbackDestination, emailCallbackContinuation } from "@/lib/mca/auth-navigation"
import { supabaseIdentity } from "@/lib/mca/supabase-auth"
import { apiError } from "@/lib/mca/errors"
import { isGoogleOauthCallback, markGoogleTotpSession, startPasswordTotpChallenge } from "@/lib/mca/totp-service"
export async function GET(request: Request) {
  const url=new URL(request.url),origin=authOrigin(request)
  const code=url.searchParams.get("code"),tokenHash=url.searchParams.get("token_hash"),type=url.searchParams.get("type")
  const continuation=url.searchParams.has("redirect_to") ? emailCallbackContinuation(url.searchParams.get("redirect_to"),origin) : url.searchParams.get("next")
  const next=callbackDestination(continuation,type === "recovery")
  let success=false
  try {
    const client=await createSupabaseServerClient()
    if (url.searchParams.has("error")) success=false
    else if (tokenHash && !code && (type === "email" || type === "signup" || type === "recovery" || (type === "magiclink" && process.env.MCA_MAGIC_LINK_ENABLED === "true"))) success=!(await client.auth.verifyOtp({ token_hash:tokenHash,type })).error
    else if (code && !tokenHash && (url.searchParams.get("flow") !== "magic-link" || process.env.MCA_MAGIC_LINK_ENABLED === "true")) success=!(await client.auth.exchangeCodeForSession(code)).error
    if (success) {
      const identity=await supabaseIdentity({ allowPasswordSetup:true })
      success=Boolean(identity)
      if (identity) {
        try {
          if (url.searchParams.get("flow") !== "magic-link" && isGoogleOauthCallback({
            hasCode: Boolean(code && !tokenHash),
            hasTokenHash: Boolean(tokenHash),
            type,
            provider: typeof identity.user.app_metadata?.provider === "string" ? identity.user.app_metadata.provider : null,
            next,
          })) await markGoogleTotpSession(identity)
          else await startPasswordTotpChallenge(identity)
        } catch { /* Session marking must not block a verified callback. */ }
      }
    }
  } catch(error) {
    const response=apiError(error)
    response.headers.set("Cache-Control","no-store")
    return response
  }
  const recovery=next.startsWith("/reset-password?")
  const retryNext=recovery ? new URL(next,origin).searchParams.get("next")! : next
  const target=success ? next : `${recovery ? "/forgot-password" : "/sign-in"}?error=verification_failed&next=${encodeURIComponent(retryNext)}`
  return NextResponse.redirect(new URL(target,origin), { headers:{ "Cache-Control":"no-store" } })
}
