import "server-only"
import { supabaseIdentity } from "./supabase-auth"
import { createSupabaseServerClient } from "../supabase/server"
import { getDatabase, newId, withImmediateTransaction } from "./db"
import { AppError } from "./errors"
import { sessionHasAppTotp } from "./totp-service"

async function recordGrantedDenial(userId: string, email: string, sessionId: string, code: string): Promise<void> {
  try {
    await withImmediateTransaction(async db => {
      const bucket = Math.floor(Date.now() / 60000)
      const count = await db.prepare<{ request_count: number }>(`INSERT INTO request_rate_windows(rate_key,bucket_start,request_count) VALUES (?,?,1)
        ON CONFLICT(rate_key,bucket_start) DO UPDATE SET request_count=request_rate_windows.request_count+1 RETURNING request_count`)
        .get(`platform-denial:${userId}:${code}`,bucket)
      if (count?.request_count !== 1) return
      await db.prepare(`INSERT INTO platform_admin_audit(id,actor_user_id,actor_email,session_id,action,reason)
        VALUES (?,?,?,?,'super_admin.denied',?)`).run(newId(),userId,email,sessionId,code)
    })
  } catch { /* Denial logging must never convert a denial into access. */ }
}

/** Platform authority is never inferred from company roles or editable metadata. */
export async function requirePlatformAdmin() {
  const identity = await supabaseIdentity()
  if (!identity) throw new AppError(401, "authentication_required", "Sign in to continue.")
  const grant = await getDatabase().prepare<{ user_id: string }>(`SELECT g.user_id FROM platform_admin_grants g
    JOIN users u ON u.id=g.user_id WHERE u.supabase_user_id=? AND g.revoked_at IS NULL`).get(identity.user.id)
  if (!grant) throw new AppError(403, "platform_admin_required", "Platform administrator access is required.")
  const client = await createSupabaseServerClient()
  const { data, error } = await client.auth.getClaims()
  const appVerified = await sessionHasAppTotp(identity.sessionId, grant.user_id)
  if (error || data?.claims.sub !== identity.user.id || data.claims.session_id !== identity.sessionId || (data.claims.aal !== "aal2" && !appVerified)) {
    await recordGrantedDenial(grant.user_id,identity.email,identity.sessionId,"mfa_required")
    throw new AppError(403, "mfa_required", "Complete multi-factor authentication to access platform administration.")
  }
  return { userId: grant.user_id, supabaseUserId: identity.user.id, sessionId: identity.sessionId }
}

const DEFAULT_SUPER_ADMIN_EMAILS = "mike@sentineltechsolutions.io,ben@sentineltechsolutions.io"
const DEFAULT_SMS_APPROVERS = "mike@sentineltechsolutions.io"

export function emailInCeiling(email: string, list: string): boolean {
  return list.split(",").some(value => value.trim().toLowerCase() === email.trim().toLowerCase())
}

/** A confirmed provider email limits an existing grant; it cannot create one. */
export async function requireSuperAdmin(request?: Request) {
  if (request?.headers.get("authorization")?.startsWith("Bearer mca_"))
    throw new AppError(403,"super_admin_required","Super administrator access requires a user session.")
  let actor: Awaited<ReturnType<typeof requirePlatformAdmin>>
  try { actor = await requirePlatformAdmin() }
  catch (error) {
    if (error instanceof AppError && error.code === "authentication_required") {
      const client = await createSupabaseServerClient()
      const user = await client.auth.getUser()
      if (user.data?.user && !user.data.user.email_confirmed_at)
        throw new AppError(403,"super_admin_required","Confirm your email before accessing platform administration.")
    }
    throw error
  }
  const identity = await supabaseIdentity()
  if (!identity || identity.user.id !== actor.supabaseUserId || identity.sessionId !== actor.sessionId)
    throw new AppError(401, "authentication_required", "Sign in to continue.")
  const confirmedEmail = identity.email.trim().toLowerCase()
  if (!emailInCeiling(confirmedEmail, process.env.MCA_SUPER_ADMIN_EMAILS ?? DEFAULT_SUPER_ADMIN_EMAILS))
  {
    await recordGrantedDenial(actor.userId,confirmedEmail,actor.sessionId,"super_admin_required")
    throw new AppError(403, "super_admin_required", "Super administrator access is required.")
  }
  return { ...actor, email: confirmedEmail }
}

export type SuperAdminActor = Awaited<ReturnType<typeof requireSuperAdmin>>

export function requireSmsApprover(actor: SuperAdminActor): void {
  if (!emailInCeiling(actor.email, process.env.MCA_SUPER_ADMIN_SMS_APPROVER_EMAILS ?? DEFAULT_SMS_APPROVERS))
    throw new AppError(403, "sms_approver_required", "SMS approval access is required.")
}
