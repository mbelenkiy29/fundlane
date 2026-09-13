import "server-only"
import { NextResponse } from "next/server"
import { cookies } from "next/headers"
import { z } from "zod"
import { createSupabaseServerClient, getSupabaseAdminClient } from "../supabase/server"
import { assertTrustedMutation, clientRateKey, consumeRequestRateLimit } from "./auth"
import { apiError, AppError } from "./errors"
import { readJson } from "./http"
import { getDatabase, nowIso } from "./db"
import { supabaseIdentity, WORKSPACE_COOKIE } from "./supabase-auth"

const emailInput = z.object({ email: z.email().max(320) })
const credentials = emailInput.extend({ password: z.string().min(1).max(256) })
export function authOrigin(request: Request) {
  const origin = process.env.MCA_APP_ORIGIN || new URL(request.url).origin
  return new URL(origin).origin
}
function authError(error: { message: string; status?: number } | null) {
  if (error) throw new AppError(error.status === 429 ? 429 : 400, "authentication_failed", error.message)
}

export async function handleSupabaseAuth(request: Request, action: "sign-in" | "company-signup" | "verify" | "resend" | "recovery-request" | "recovery-reset" | "sign-out") {
  try {
    assertTrustedMutation(request)
    await consumeRequestRateLimit(clientRateKey(request, `auth:${action}`), action === "sign-in" ? 20 : 10)
    const client = await createSupabaseServerClient()
    if (action === "sign-out") {
      const claims = await client.auth.getClaims()
      const id = claims.data?.claims.session_id
      if (typeof id === "string") await getDatabase().prepare("INSERT INTO auth_session_revocations (id,revoked_at) VALUES (?,?) ON CONFLICT DO NOTHING").run(id,nowIso())
      const { error } = await client.auth.signOut({ scope: "local" })
      authError(error)
      const store = await cookies(); store.delete(WORKSPACE_COOKIE); store.delete("mca_session")
      return NextResponse.json({ success:true }, { headers: { "Cache-Control":"no-store" } })
    }
    const body: unknown = await readJson(request,z.unknown())
    if (action === "sign-in") {
      const input = credentials.parse(body)
      const { error } = await client.auth.signInWithPassword(input)
      if (error) throw new AppError(401,"invalid_credentials","Email or password is incorrect. Verify your email or recover your account if needed.")
    } else if (action === "company-signup") {
      const input = credentials.extend({ password:z.string().min(12).max(256), name:z.string().trim().min(2).max(200), companyName:z.string().trim().max(200).optional() }).parse(body)
      const { data,error } = await client.auth.signUp({ email:input.email, password:input.password, options: { data:{ name:input.name,companyName:input.companyName }, emailRedirectTo:`${authOrigin(request)}/auth/callback?next=/onboarding` } })
      authError(error)
      return NextResponse.json({ success:true, verificationRequired:!data.session })
    } else if (action === "verify") {
      const input=emailInput.extend({ code:z.string().trim().min(6).max(10) }).parse(body)
      const { error }=await client.auth.verifyOtp({ email:input.email,token:input.code,type:"signup" });authError(error)
    } else if (action === "resend") {
      const input=emailInput.parse(body)
      const { error }=await client.auth.resend({ type:"signup",email:input.email,options:{ emailRedirectTo:`${authOrigin(request)}/auth/callback?next=/onboarding` } });authError(error)
    } else if (action === "recovery-request") {
      const input=emailInput.parse(body)
      const { error } = await client.auth.resetPasswordForEmail(input.email,{ redirectTo:`${authOrigin(request)}/auth/callback?next=/reset-password` })
      // Same successful response for unknown accounts; configuration/outage errors remain actionable.
      if (error && (!error.status || error.status >= 500 || error.status === 429)) authError(error)
    } else {
      const input=z.object({ password:z.string().min(12).max(256) }).parse(body)
      const identity=await supabaseIdentity({ allowPasswordSetup:true })
      if (!identity) throw new AppError(401,"recovery_required","Open a new recovery link from your email before setting your password.")
      const { error }=await client.auth.updateUser({ password:input.password });authError(error)
      // Only the server clears migration metadata, after the verified user has set a password.
      if (identity.user.app_metadata.mca_migration_pending === true) {
        const { error:adminError }=await getSupabaseAdminClient().auth.admin.updateUserById(identity.user.id,{ app_metadata:{ ...identity.user.app_metadata,mca_migration_pending:false } });authError(adminError)
      }
      authError((await client.auth.signOut({ scope:"others" })).error)
      authError((await client.auth.refreshSession()).error)
    }
    return NextResponse.json({ success:true },{ headers:{ "Cache-Control":"no-store" } })
  } catch(error) { return apiError(error instanceof z.ZodError ? new AppError(400,"validation_failed","Review the required account information.") : error) }
}
