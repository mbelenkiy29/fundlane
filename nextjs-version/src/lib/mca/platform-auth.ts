import "server-only"
import { supabaseIdentity } from "./supabase-auth"
import { createSupabaseServerClient } from "../supabase/server"
import { getDatabase } from "./db"
import { AppError } from "./errors"
import { sessionHasAppTotp } from "./totp-service"

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
    throw new AppError(403, "mfa_required", "Complete multi-factor authentication to access platform administration.")
  }
  return { userId: grant.user_id, supabaseUserId: identity.user.id, sessionId: identity.sessionId }
}
