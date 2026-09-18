import "server-only"
import type { User } from "@supabase/supabase-js"
import { getSupabaseAdminClient } from "../supabase/admin"
import { getDatabase } from "./db"
import { AppError } from "./errors"

/** JWT validity is insufficient after logout: consult the live provider session on every authorization. */
export async function liveSupabaseSession(sessionId: string, userId: string): Promise<boolean> {
  const row = await getDatabase().prepare(`SELECT s.id FROM mca_private.auth_sessions s
    WHERE s.id::text = ? AND s.user_id::text = ? AND (s.not_after IS NULL OR s.not_after > now())
    AND NOT EXISTS (SELECT 1 FROM auth_session_revocations r WHERE r.id = s.id::text)`).get(sessionId, userId)
  return Boolean(row)
}

export function verifiedSupabaseUser(user: User): boolean {
  return Boolean(user.email && user.email_confirmed_at && !user.is_anonymous &&
    (!user.banned_until || Date.parse(user.banned_until) <= Date.now()))
}

/** Also used for long-running delegated callbacks; no cached browser claims or provider organization roles. */
export async function requireLiveSupabaseSession(sessionId: string, userId: string) {
  if (!await liveSupabaseSession(sessionId,userId)) throw new AppError(401,"session_expired","Sign in again to continue.")
  const { data,error } = await getSupabaseAdminClient().auth.admin.getUserById(userId)
  if (error || !data.user || !verifiedSupabaseUser(data.user) || data.user.app_metadata.mca_migration_pending === true)
    throw new AppError(401,"session_expired","Sign in again to continue.")
}
