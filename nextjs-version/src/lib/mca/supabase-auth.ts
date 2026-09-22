import "server-only"
import type { User } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import { createSupabaseServerClient, getSupabaseAdminClient } from "../supabase/server"
import { getDatabase, newId, nowIso, recordAuditEvent, withImmediateTransaction } from "./db"
import { AppError } from "./errors"
import type { MembershipContext, Role } from "./types"
import { DEFAULT_ACTION_VISIBILITY, DEFAULT_FEATURE_FLAGS, DEFAULT_PAGE_VISIBILITY } from "./workspaces"
import { initializeCompanyTrial } from "./company-access"

export const WORKSPACE_COOKIE = "mca_workspace"
export type SupabaseIdentity = { user: User; email: string; sessionId: string }

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

export async function supabaseIdentity(options: { allowPasswordSetup?: boolean } = {}): Promise<SupabaseIdentity | null> {
  const client = await createSupabaseServerClient()
  const { data, error } = await client.auth.getUser()
  if (error) {
    if (!error.status || error.status >= 500) throw new AppError(503, "identity_unavailable", "Account verification is temporarily unavailable. Please retry.")
    return null
  }
  if (!data.user || !verifiedSupabaseUser(data.user)) return null
  const claims = await client.auth.getClaims()
  const sessionId = claims.data?.claims.session_id
  if (claims.error || typeof sessionId !== "string" || claims.data?.claims.sub !== data.user.id) return null
  if (!await liveSupabaseSession(sessionId, data.user.id)) return null
  if (!options.allowPasswordSetup && data.user.app_metadata.mca_migration_pending === true) {
    return null
  }
  return { user: data.user, email: data.user.email!.toLowerCase(), sessionId }
}

/** Historical accounts require explicit migration; invitations may only claim new pending placeholders. */
export async function linkSupabaseUser(identity: SupabaseIdentity, invitedUserId?: string): Promise<string> {
  const db = getDatabase()
  const linked = await db.prepare<{ id: string }>("SELECT id FROM users WHERE supabase_user_id = ?").get(identity.user.id)
  if (linked) {
    if (invitedUserId && linked.id !== invitedUserId) throw new AppError(409, "identity_conflict", "This invitation belongs to a different account record.")
    return linked.id
  }
  const migrationId = identity.user.app_metadata.mca_user_id
  if (invitedUserId && typeof migrationId === "string" && migrationId !== invitedUserId) {
    throw new AppError(409, "identity_conflict", "This invitation belongs to a different account record.")
  }
  const trustedId = invitedUserId ?? (typeof migrationId === "string" ? migrationId : undefined)
  if (trustedId) {
    const explicitMigration = typeof migrationId === "string" && migrationId === trustedId
    const updated = await db.prepare<{ id: string }>(`UPDATE users SET supabase_user_id = ?, updated_at = ?
      WHERE id = ? AND (supabase_user_id IS NULL OR supabase_user_id = ?) AND lower(email) = ?
      AND (? OR (clerk_user_id IS NULL AND password_hash IS NULL AND NOT EXISTS
        (SELECT 1 FROM memberships m WHERE m.user_id=users.id AND m.status<>'pending'))) RETURNING id`)
      .get(identity.user.id, nowIso(), trustedId, identity.user.id, identity.email, explicitMigration)
    if (updated) return updated.id
    throw new AppError(409, "identity_conflict", "This existing account must complete its controlled migration and recovery before accepting the invitation.")
  }
  const id = newId(), now = nowIso()
  const inserted = await db.prepare<{ id: string }>(`INSERT INTO users (id,email,name,application_identifier,supabase_user_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`).get(id, identity.email,
    typeof identity.user.user_metadata.name === "string" ? identity.user.user_metadata.name.slice(0, 200) : identity.email,
    `MCA-${id.slice(0,8).toUpperCase()}`, identity.user.id, now, now)
  if (!inserted) throw new AppError(409, "account_migration_required", "An existing account must be migrated or linked through its company invitation before continuing.")
  return inserted.id
}

export async function resolveSupabaseMembership(identity: SupabaseIdentity, workspaceId?: string): Promise<MembershipContext | null> {
  if (!workspaceId) return null
  const member = await getDatabase().prepare<{ id: string; user_id: string; role: Role }>(`SELECT m.id,m.user_id,m.role
    FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.supabase_user_id=? AND m.workspace_id=? AND m.status='active'`)
    .get(identity.user.id, workspaceId)
  if (!member) return null
  return { authType: "session", userId: member.user_id, membershipId: member.id, workspaceId, role: member.role, scopes: [], sessionId: identity.sessionId }
}

export async function authenticateSupabaseSession(_request?: Request): Promise<MembershipContext | null> {
  void _request // Incoming claims/headers never select roles or bypass the provider session check.
  const identity = await supabaseIdentity()
  if (!identity) return null
  return resolveSupabaseMembership(identity, (await cookies()).get(WORKSPACE_COOKIE)?.value)
}

export async function setActiveWorkspace(identity: SupabaseIdentity, workspaceId: string) {
  const context = await resolveSupabaseMembership(identity, workspaceId)
  if (!context) throw new AppError(403, "membership_inactive", "Your company membership is not active.")
  ;(await cookies()).set(WORKSPACE_COOKIE, workspaceId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 30 })
  return context
}

export async function listSupabaseWorkspaces(identity: SupabaseIdentity) {
  return getDatabase().prepare<{ id: string; name: string; role: Role }>(`SELECT w.id,w.name,m.role FROM workspaces w
    JOIN memberships m ON m.workspace_id=w.id JOIN users u ON u.id=m.user_id
    WHERE u.supabase_user_id=? AND m.status='active' ORDER BY w.name,w.id`).all(identity.user.id)
}

export async function completeCompanyOnboarding(name: string, selectedSeats = 1) {
  const identity = await supabaseIdentity()
  if (!identity) throw new AppError(401, "authentication_required", "Verify your email and sign in before continuing.")
  const workspaceId = await withImmediateTransaction(async db => {
    await db.prepare("SELECT pg_advisory_xact_lock(hashtext(?))").get(`supabase-company:${identity.user.id}`)
    const userId = await linkSupabaseUser(identity)
    // A stable per-form idempotency is provided by reuse of the owner's normalized company name.
    const existing = await db.prepare<{ id: string }>(`SELECT w.id FROM workspaces w
      JOIN workspace_owners o ON o.workspace_id=w.id
      JOIN memberships m ON m.id=o.membership_id AND m.workspace_id=w.id
      WHERE m.user_id=? AND m.status='active' AND lower(w.name)=lower(?)`).get(userId,name)
    if (existing) return existing.id
    const id = newId(), now = nowIso()
    await db.prepare(`INSERT INTO workspaces (id,name,timezone,seat_limit,feature_flags,page_visibility,action_visibility,created_at,updated_at)
      VALUES (?,?,'America/New_York',1,?,?,?,?,?)`).run(id,name,JSON.stringify(DEFAULT_FEATURE_FLAGS),JSON.stringify(DEFAULT_PAGE_VISIBILITY),JSON.stringify(DEFAULT_ACTION_VISIBILITY),now,now)
    const membershipId = newId()
    await db.prepare(`INSERT INTO memberships (id,workspace_id,user_id,role,status,created_at,updated_at) VALUES (?,?,?,'admin','active',?,?)`).run(membershipId,id,userId,now,now)
    await db.prepare("INSERT INTO workspace_owners(workspace_id,membership_id,updated_at) VALUES (?,?,?)").run(id,membershipId,now)
    await initializeCompanyTrial(id, selectedSeats, db)
    await db.prepare("INSERT INTO sms_companies (workspace_id,owner_user_id,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?)").run(id,userId,now,now,now)
    await recordAuditEvent({ context: { workspaceId:id,userId },action:"company.signup",resourceType:"workspace",resourceId:id,executor:db })
    return id
  })
  return setActiveWorkspace(identity, workspaceId)
}

/** Also used for long-running delegated callbacks; no cached browser claims or provider organization roles. */
export async function requireLiveSupabaseSession(sessionId: string, userId: string) {
  if (!await liveSupabaseSession(sessionId,userId)) throw new AppError(401,"session_expired","Sign in again to continue.")
  const { data,error } = await getSupabaseAdminClient().auth.admin.getUserById(userId)
  if (error || !data.user || !verifiedSupabaseUser(data.user) || data.user.app_metadata.mca_migration_pending === true)
    throw new AppError(401,"session_expired","Sign in again to continue.")
}
