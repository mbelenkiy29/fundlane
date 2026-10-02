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
import { authContinuation, recoveryDestination } from "./auth-navigation"
import { startPasswordTotpChallenge } from "./totp-service"
import { assertAccountSignupAllowed } from "./signup-guard"

const emailInput = z.object({ email: z.email().max(320), next: z.string().max(2048).optional() })
const credentials = emailInput.extend({ password: z.string().min(1).max(256) })
const newPassword = z.string().min(12, "Use a password with at least 12 characters.").max(256, "Use a password with no more than 256 characters.")
export function authOrigin(request: Request) {
  const origin = process.env.MCA_APP_ORIGIN || new URL(request.url).origin
  return new URL(origin).origin
}
function authError(error: { message: string; status?: number; code?: string; name?: string; reasons?: unknown } | null) {
  if (error && (error.code === "weak_password" || error.name === "AuthWeakPasswordError")) {
    const reasons = Array.isArray(error.reasons) ? error.reasons : []
    const message = reasons.includes("pwned")
      ? "This password has appeared in a data breach. Choose a different, unique password."
      : reasons.includes("length") ? "Choose a longer password with at least 12 characters."
        : reasons.includes("characters") ? "Choose a password with uppercase and lowercase letters, numbers, and symbols."
          : "This password does not meet the security requirements. Choose a stronger, unique password with at least 12 characters."
    throw new AppError(400, "weak_password", message, { password: [message] })
  }
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
      const identity = await supabaseIdentity()
      const challenge = identity ? await startPasswordTotpChallenge(identity) : { mfaRequired: false }
      return NextResponse.json({ success: true, mfaRequired: challenge.mfaRequired }, { headers: { "Cache-Control": "no-store" } })
    } else if (action === "company-signup") {
      const input = credentials.extend({ password:newPassword, name:z.string().trim().min(2).max(200), companyName:z.string().trim().max(200).optional() }).parse(body)
      await assertAccountSignupAllowed(input.email, input.next)
      if (authContinuation(input.next ?? null) === "/activate") {
        const { SIGNUP_COOKIE, requireSignupEmail }=await import("./stripe-first-signup")
        const token=(await cookies()).get(SIGNUP_COOKIE)?.value
        if (!token) throw new AppError(410,"signup_intent_expired","Open your signup recovery email or get started again.")
        await requireSignupEmail(token,input.email)
        if (!body || typeof body!=="object" || !("terms" in body) || body.terms!=="on") throw new AppError(400,"legal_agreement_required","Accept the terms of service and privacy policy.")
      }
      const { data,error } = await client.auth.signUp({ email:input.email, password:input.password, options: { data:{ name:input.name,companyName:input.companyName }, emailRedirectTo:`${authOrigin(request)}/auth/callback?next=${encodeURIComponent(authContinuation(input.next ?? null))}` } })
      authError(error)
      return NextResponse.json({ success:true, verificationRequired:!data.session })
    } else if (action === "verify") {
      const input=emailInput.extend({ code:z.string().trim().min(6).max(10) }).parse(body)
      const { error }=await client.auth.verifyOtp({ email:input.email,token:input.code,type:"signup" });authError(error)
    } else if (action === "resend") {
      const input=emailInput.parse(body)
      const { error }=await client.auth.resend({ type:"signup",email:input.email,options:{ emailRedirectTo:`${authOrigin(request)}/auth/callback?next=${encodeURIComponent(authContinuation(input.next ?? null))}` } });authError(error)
    } else if (action === "recovery-request") {
      const input=emailInput.parse(body)
      const { error } = await client.auth.resetPasswordForEmail(input.email,{ redirectTo:`${authOrigin(request)}/auth/callback?next=${encodeURIComponent(recoveryDestination(input.next ?? null))}` })
      // Same successful response for unknown accounts; configuration/outage errors remain actionable.
      if (error && (!error.status || error.status >= 500 || error.status === 429)) authError(error)
    } else {
      const input=z.object({ password:newPassword }).parse(body)
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
  } catch(error) {
    if (error instanceof z.ZodError) {
      const passwordIssues = error.issues.filter(issue => issue.path[0] === "password").map(issue => issue.message)
      return apiError(new AppError(400, "validation_failed", passwordIssues[0] ?? "Review the required account information.",
        passwordIssues.length ? { password: passwordIssues } : undefined))
    }
    return apiError(error)
  }
}
