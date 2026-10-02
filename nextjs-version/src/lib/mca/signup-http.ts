import "server-only"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { z } from "zod"
import { SIGNUP_COOKIE, SIGNUP_LIFETIME_SECONDS, assertSignupOrigin, createSignupIntent, readSignupIntent, requireSignupEmail, beginSignupCheckout, activateSignup } from "./stripe-first-signup"
import { clientRateKey, consumeRequestRateLimit, requireMembershipAccess } from "./auth"
import { apiError, AppError } from "./errors"
import { readJson } from "./http"
import { completeCompanyOnboarding, listSupabaseWorkspaces, setActiveWorkspace, supabaseIdentity } from "./supabase-auth"
import { withImmediateTransaction } from "./db"
import type { StripeBillingClient } from "./billing"

export async function setSignupCookie(token:string,expiresAt?:string) {
  (await cookies()).set(SIGNUP_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:expiresAt?Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000)):SIGNUP_LIFETIME_SECONDS})
}
export async function signupCheckout(request:Request,client?:StripeBillingClient) {
  try {
    assertSignupOrigin(request)
    await consumeRequestRateLimit(clientRateKey(request,"signup-checkout"),10)
    const {restart}=await readJson(request,z.object({restart:z.boolean().optional()}).strict())
    const identity=await supabaseIdentity()
    let token=(await cookies()).get(SIGNUP_COOKIE)?.value
    let intent
    if (token) {try {intent=await readSignupIntent(token)}catch(error){if (!(error instanceof AppError && error.status===410))throw error;token=undefined}}
    if (identity) {
      const workspaces=await listSupabaseWorkspaces(identity)
      if (workspaces.length && (!intent?.workspace_id || workspaces.some(w=>w.id!==intent.workspace_id))) return NextResponse.json({url:"/dashboard"})
    }
    if (!token || restart) token=await createSignupIntent()
    // Keep the durable intent even when Stripe is unavailable or its response is lost.
    await setSignupCookie(token)
    const result=await beginSignupCheckout(token,client)
    return NextResponse.json({url:result.url},{headers:{"Cache-Control":"no-store"}})
  } catch(error) {return apiError(error)}
}
export async function signupActivate(request:Request,client?:StripeBillingClient) {
  try {
    assertSignupOrigin(request)
    await consumeRequestRateLimit(clientRateKey(request,"signup-activate"),10)
    const input=await readJson(request,z.object({companyName:z.string().trim().min(2).max(200),terms:z.literal(true),activate:z.literal(true)}).strict())
    const identity=await supabaseIdentity()
    if (!identity) throw new AppError(401,"authentication_required","Verify your email and log in before activating.")
    const token=(await cookies()).get(SIGNUP_COOKIE)?.value
    if (!token) throw new AppError(410,"signup_intent_expired","Open the recovery link sent after saving your card, or get started again.")
    await requireSignupEmail(token,identity.email)
    // Claim the intent and create the company in one transaction; retries cannot create a second company.
    await withImmediateTransaction(async db=>{
      const intent=await requireSignupEmail(token,identity.email)
      await db.prepare("SELECT id FROM company_signup_intents WHERE id=? FOR UPDATE").get(intent.id)
      const current=await readSignupIntent(token)
      await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`supabase-company:${identity.user.id}`)
      const workspaces=await listSupabaseWorkspaces(identity)
      if (workspaces.length && (!current.workspace_id || workspaces.some(w=>w.id!==current.workspace_id))) throw new AppError(409,"existing_workspace","Log in to use your existing workspace and its Plans & Billing.")
      const context=current.workspace_id ? await setActiveWorkspace(identity,current.workspace_id) : await completeCompanyOnboarding(input.companyName,1)
      if (current.user_id && current.user_id!==context.userId) throw new AppError(403,"signup_already_claimed","This signup belongs to another account.")
      await db.prepare("UPDATE company_signup_intents SET workspace_id=?,user_id=? WHERE id=?").run(context.workspaceId,context.userId,current.id)
    })
    const context=await requireMembershipAccess(request,["admin","super_admin"],{allowPaused:true})
    const result=await activateSignup(token,{workspaceId:context.workspaceId,userId:context.userId!,email:identity.email},client)
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}})
  } catch(error) {return apiError(error)}
}
