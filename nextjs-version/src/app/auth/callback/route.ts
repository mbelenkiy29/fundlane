import { NextResponse } from "next/server"
import { createSupabaseServerClient } from "@/lib/supabase/server"
import { authOrigin } from "@/lib/mca/supabase-auth-http"
export async function GET(request: Request) {
  const url=new URL(request.url),client=await createSupabaseServerClient()
  const next=url.searchParams.get("next") === "/reset-password" ? "/reset-password" : "/onboarding"
  const code=url.searchParams.get("code"),tokenHash=url.searchParams.get("token_hash"),type=url.searchParams.get("type")
  let success=false
  if (code) success=!(await client.auth.exchangeCodeForSession(code)).error
  else if (tokenHash && (type === "email" || type === "signup" || type === "recovery")) success=!(await client.auth.verifyOtp({ token_hash:tokenHash,type })).error
  const target=success ? (type === "recovery" ? "/reset-password" : next) : "/sign-in?error=verification_failed"
  return NextResponse.redirect(new URL(target,authOrigin(request)), { headers:{ "Cache-Control":"no-store" } })
}
